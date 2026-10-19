/**
 * Core health/discovery/launch logic.
 */
import { getClient, getTargetInfo, evaluate, CDP_HOST, CDP_PORT } from '../connection.js';
import { existsSync, cpSync, rmSync, readdirSync } from 'fs';
import { execSync, spawn } from 'child_process';
import { dirname, basename, join } from 'path';

// Best-effort git-pull update check: compare local HEAD to origin's default
// branch on GitHub. Never throws — returns null on any failure (offline,
// detached HEAD, not a git checkout) so it can't break the health check.
let _updateCache = null;
async function checkForUpdate() {
  if (_updateCache && (Date.now() - _updateCache.at) < 3600_000) return _updateCache.value;
  let value = null;
  try {
    const localSha = execSync('git rev-parse HEAD', { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const remoteUrl = execSync('git config --get remote.origin.url', { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const m = remoteUrl.match(/github\.com[:/](.+?)(?:\.git)?$/);
    if (localSha && m) {
      const repo = m[1];
      const http = await import('https');
      const remoteSha = await new Promise((resolve) => {
        const req = http.get({
          host: 'api.github.com', path: `/repos/${repo}/commits/HEAD`,
          headers: { 'User-Agent': 'tradingview-mcp', Accept: 'application/vnd.github.sha' },
        }, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve(res.statusCode === 200 ? d.trim() : null)); });
        req.on('error', () => resolve(null));
        req.setTimeout(3000, () => { req.destroy(); resolve(null); });
      });
      if (remoteSha) {
        value = {
          update_available: remoteSha !== localSha,
          local_commit: localSha.slice(0, 8),
          latest_commit: remoteSha.slice(0, 8),
          ...(remoteSha !== localSha && { hint: 'Run the tv_update tool (or `tv update` CLI) to update, then restart the MCP server.' }),
        };
      }
    }
  } catch { /* best-effort */ }
  _updateCache = { at: Date.now(), value };
  return value;
}

export async function healthCheck() {
  await getClient();
  const target = await getTargetInfo();

  const state = await evaluate(`
    (function() {
      var result = { url: window.location.href, title: document.title };
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        result.symbol = chart.symbol();
        result.resolution = chart.resolution();
        result.chartType = chart.chartType();
        result.apiAvailable = true;
      } catch(e) {
        result.symbol = 'unknown';
        result.resolution = 'unknown';
        result.chartType = null;
        result.apiAvailable = false;
        result.apiError = e.message;
      }
      return result;
    })()
  `);

  const update = await checkForUpdate();
  const switches = inspectLaunchSwitches();

  return {
    success: true,
    cdp_connected: true,
    target_id: target.id,
    target_url: target.url,
    target_title: target.title,
    chart_symbol: state?.symbol || 'unknown',
    chart_resolution: state?.resolution || 'unknown',
    chart_type: state?.chartType ?? null,
    api_available: state?.apiAvailable ?? false,
    anti_throttle_ok: switches.ok,
    anti_throttle: switches,
    ...(switches.ok !== true && { warning: _switchWarning(switches) }),
    ...(update && { update }),
  };
}

// Chromium stops painting a page it thinks nobody can see (occluded window,
// locked screen), which froze every chart capture in the 2026-10-19
// scheduled run behind a locked Mac. These switches keep the renderer and
// its timers running while the window is hidden. They only take effect if
// the TradingView main process was started with them, so launch() verifies
// them and the health check reports them.
export const ANTI_THROTTLE_SWITCHES = [
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
];

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function _firstPid(out) {
  const pid = Number(String(out).trim().split(/\s+/)[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

// PID of the process listening on the CDP port, or null if none.
function _cdpListenerPid({ cdpPort, platform, execSync }) {
  try {
    const cmd = platform === 'win32'
      ? `powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort ${cdpPort} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"`
      : `lsof -nP -iTCP:${cdpPort} -sTCP:LISTEN -t`;
    return _firstPid(execSync(cmd, { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString());
  } catch { return null; } // lsof exits 1 when nothing listens
}

function _processArgs({ pid, platform, execSync }) {
  const cmd = platform === 'win32'
    ? `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`
    : `ps -ww -o args= -p ${pid}`; // -ww: never truncate to terminal width
  return execSync(cmd, { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
}

/**
 * Read the command line of the process serving CDP and report which
 * anti-throttling switches it was started with. ok is true/false, or null
 * when the process could not be inspected (remote CDP host, no listener,
 * lsof/ps unavailable). Never throws.
 */
export function inspectLaunchSwitches({ cdpPort = CDP_PORT, _deps } = {}) {
  const platform = _deps?.platform || process.platform;
  const exec = _deps?.execSync || execSync;
  if (!LOCAL_HOSTS.has(CDP_HOST)) {
    return { ok: null, error: `CDP host ${CDP_HOST} is not local; process arguments cannot be read` };
  }
  const pid = _cdpListenerPid({ cdpPort, platform, execSync: exec });
  if (!pid) return { ok: null, error: `no process found listening on CDP port ${cdpPort}` };
  let args;
  try { args = _processArgs({ pid, platform, execSync: exec }); }
  catch (e) { return { ok: null, pid, error: `could not read arguments of pid ${pid}: ${e.message}` }; }
  const tokens = args.split(/\s+/);
  const present = ANTI_THROTTLE_SWITCHES.filter((sw) => tokens.includes(sw));
  const missing = ANTI_THROTTLE_SWITCHES.filter((sw) => !tokens.includes(sw));
  return { ok: missing.length === 0, pid, present, missing };
}

function _switchWarning(sw) {
  if (sw.ok === null) {
    return `Could not verify TradingView's anti-throttling launch switches (${sw.error}). Chart captures may freeze while the screen is locked or the window is hidden.`;
  }
  return `TradingView (pid ${sw.pid}) was started without ${sw.missing.join(', ')}. Chart captures freeze while the screen is locked or the window is hidden. Relaunch it with tv_launch (kill_existing defaults to true).`;
}

export async function discover() {
  const paths = await evaluate(`
    (function() {
      var results = {};
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        var methods = [];
        for (var k in chart) { if (typeof chart[k] === 'function') methods.push(k); }
        results.chartApi = { available: true, path: 'window.TradingViewApi._activeChartWidgetWV.value()', methodCount: methods.length, methods: methods.slice(0, 50) };
      } catch(e) { results.chartApi = { available: false, error: e.message }; }
      try {
        var col = window.TradingViewApi._chartWidgetCollection;
        var colMethods = [];
        for (var k in col) { if (typeof col[k] === 'function') colMethods.push(k); }
        results.chartWidgetCollection = { available: !!col, path: 'window.TradingViewApi._chartWidgetCollection', methodCount: colMethods.length, methods: colMethods.slice(0, 30) };
      } catch(e) { results.chartWidgetCollection = { available: false, error: e.message }; }
      try {
        var ws = window.ChartApiInstance;
        var wsMethods = [];
        for (var k in ws) { if (typeof ws[k] === 'function') wsMethods.push(k); }
        results.chartApiInstance = { available: !!ws, path: 'window.ChartApiInstance', methodCount: wsMethods.length, methods: wsMethods.slice(0, 30) };
      } catch(e) { results.chartApiInstance = { available: false, error: e.message }; }
      try {
        var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
        var bwbMethods = [];
        if (bwb) { for (var k in bwb) { if (typeof bwb[k] === 'function') bwbMethods.push(k); } }
        results.bottomWidgetBar = { available: !!bwb, path: 'window.TradingView.bottomWidgetBar', methodCount: bwbMethods.length, methods: bwbMethods.slice(0, 20) };
      } catch(e) { results.bottomWidgetBar = { available: false, error: e.message }; }
      try {
        var replay = window.TradingViewApi._replayApi;
        results.replayApi = { available: !!replay, path: 'window.TradingViewApi._replayApi' };
      } catch(e) { results.replayApi = { available: false, error: e.message }; }
      try {
        var alerts = window.TradingViewApi._alertService;
        results.alertService = { available: !!alerts, path: 'window.TradingViewApi._alertService' };
      } catch(e) { results.alertService = { available: false, error: e.message }; }
      return results;
    })()
  `);

  const available = Object.values(paths).filter(v => v.available).length;
  const total = Object.keys(paths).length;

  return { success: true, apis_available: available, apis_total: total, apis: paths };
}

export async function uiState() {
  const state = await evaluate(`
    (function() {
      var ui = {};
      var bottom = document.querySelector('[class*="layout__area--bottom"]');
      ui.bottom_panel = { open: !!(bottom && bottom.offsetHeight > 50), height: bottom ? bottom.offsetHeight : 0 };
      var right = document.querySelector('[class*="layout__area--right"]');
      ui.right_panel = { open: !!(right && right.offsetWidth > 50), width: right ? right.offsetWidth : 0 };
      var monacoEl = document.querySelector('.monaco-editor.pine-editor-monaco');
      ui.pine_editor = { open: !!monacoEl, width: monacoEl ? monacoEl.offsetWidth : 0, height: monacoEl ? monacoEl.offsetHeight : 0 };
      var stratPanel = document.querySelector('[data-name="backtesting"]') || document.querySelector('[class*="strategyReport"]');
      ui.strategy_tester = { open: !!(stratPanel && stratPanel.offsetParent) };
      var widgetbar = document.querySelector('[data-name="widgetbar-wrap"]');
      ui.widgetbar = { open: !!(widgetbar && widgetbar.offsetWidth > 50) };
      ui.buttons = {};
      var btns = document.querySelectorAll('button');
      var seen = {};
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        if (b.offsetParent === null || b.offsetWidth < 15) continue;
        var text = b.textContent.trim();
        var aria = b.getAttribute('aria-label') || '';
        var dn = b.getAttribute('data-name') || '';
        var label = text || aria || dn;
        if (!label || label.length > 60) continue;
        var key = label.replace(/[^a-zA-Z0-9 ]/g, '').substring(0, 40);
        if (seen[key]) continue;
        seen[key] = true;
        var rect = b.getBoundingClientRect();
        var region = 'other';
        if (rect.y < 50) region = 'top_bar';
        else if (rect.y < 90 && rect.x < 650) region = 'toolbar';
        else if (rect.x < 45) region = 'left_sidebar';
        else if (rect.x > 650 && rect.y < 100) region = 'pine_header';
        else if (rect.y > 750) region = 'bottom_bar';
        if (!ui.buttons[region]) ui.buttons[region] = [];
        ui.buttons[region].push({ label: label.substring(0, 40), disabled: b.disabled, x: Math.round(rect.x), y: Math.round(rect.y) });
      }
      ui.key_buttons = {};
      var keyLabels = {
        'add_to_chart': /add to chart/i, 'save_and_add': /save and add/i,
        'update_on_chart': /update on chart/i, 'save': /^Save(Save)?$/,
        'saved': /^Saved/, 'publish_script': /publish script/i,
        'compile_errors': /error/i, 'unsaved_version': /unsaved version/i,
      };
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        if (b.offsetParent === null) continue;
        var text = b.textContent.trim();
        for (var k in keyLabels) {
          if (keyLabels[k].test(text)) {
            ui.key_buttons[k] = { text: text.substring(0, 40), disabled: b.disabled, visible: b.offsetWidth > 0 };
          }
        }
      }
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        ui.chart = { symbol: chart.symbol(), resolution: chart.resolution(), chartType: chart.chartType(), study_count: chart.getAllStudies().length };
      } catch(e) { ui.chart = { error: e.message }; }
      try {
        var replay = window.TradingViewApi._replayApi;
        function unwrap(v) { return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; }
        ui.replay = { available: unwrap(replay.isReplayAvailable()), started: unwrap(replay.isReplayStarted()) };
      } catch(e) { ui.replay = { error: e.message }; }
      return ui;
    })()
  `);

  return { success: true, ...state };
}

const WINDOWS_APPS_RE = /\\WindowsApps\\/i;

function _resolveLaunchDeps(deps) {
  return {
    spawn: deps?.spawn || spawn,
    execSync: deps?.execSync || execSync,
    existsSync: deps?.existsSync || existsSync,
    cpSync: deps?.cpSync || cpSync,
    rmSync: deps?.rmSync || rmSync,
    readdirSync: deps?.readdirSync || readdirSync,
    delay: deps?.delay || ((ms) => new Promise((r) => setTimeout(r, ms))),
    probeCdp: deps?.probeCdp || _probeCdp,
    platform: deps?.platform || process.platform,
  };
}

// PIDs of running TradingView main processes. Matches the process name
// exactly (pgrep -x), so helper processes ("TradingView Helper ...") and
// shells whose command line merely mentions TradingView are never hit.
function _mainPids({ tvPath, execSync }) {
  try {
    const out = execSync(`pgrep -x ${JSON.stringify(basename(tvPath))}`, { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return out.split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  } catch { return []; } // pgrep exits 1 when nothing matches
}

/**
 * Stop every running TradingView main process and verify none survives:
 * graceful quit (osascript on macOS), then SIGTERM, then SIGKILL, by pid.
 * Throws if an instance is still alive afterwards — spawning then would
 * hand off to the old process and silently keep its launch arguments
 * (2026-10-19: pkill -f left the old instance up, launch reported success
 * connected to it, without the anti-throttling switches).
 */
async function _stopExisting({ tvPath, platform, execSync, delay }) {
  const waitGone = async (ms) => {
    for (let t = 0; t < ms; t += 500) {
      if (_mainPids({ tvPath, execSync }).length === 0) return true;
      await delay(500);
    }
    return _mainPids({ tvPath, execSync }).length === 0;
  };

  const initial = _mainPids({ tvPath, execSync });
  if (initial.length === 0) return { stopped: [] };
  const steps = [];

  if (platform === 'darwin') {
    try {
      execSync(`osascript -e 'quit app "${basename(tvPath)}"'`, { timeout: 5000, stdio: 'ignore' });
      steps.push('quit');
    } catch { steps.push('quit-failed'); }
    if (await waitGone(10000)) return { stopped: initial, steps };
  }

  for (const [signal, waitMs] of [['TERM', 5000], ['KILL', 3000]]) {
    const pids = _mainPids({ tvPath, execSync });
    if (pids.length === 0) return { stopped: initial, steps };
    try { execSync(`kill -${signal} ${pids.join(' ')}`, { timeout: 5000, stdio: 'ignore' }); } catch { /* raced exit */ }
    steps.push(signal);
    if (await waitGone(waitMs)) return { stopped: initial, steps };
  }

  const survivors = _mainPids({ tvPath, execSync });
  throw new Error(`Could not stop the running TradingView (pid ${survivors.join(', ')}) after ${steps.join(' → ')}. Quit it manually, then rerun tv_launch.`);
}

async function _probeCdp(cdpPort) {
  const http = await import('http');
  return new Promise((resolve) => {
    const req = http.get(`http://${CDP_HOST}:${cdpPort}/json/version`, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(2000, () => { req.destroy(); resolve(null); });
  });
}

function _spawnDetached(spawnFn, exe, args) {
  const child = spawnFn(exe, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

// Resolves once with an error string if the process fails/exits within graceMs,
// or with null if it survives that long.
function _spawnFailedEarly(child, graceMs = 1500) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { cleanup(); resolve(null); }, graceMs);
    const onError = (e) => { cleanup(); resolve(e.code || e.message || 'spawn error'); };
    const onExit = (code) => { cleanup(); resolve(`exited immediately (code ${code})`); };
    const cleanup = () => { clearTimeout(timer); child.off?.('error', onError); child.off?.('exit', onExit); };
    child.on('error', onError);
    child.on('exit', onExit);
  });
}

async function _waitForCdp({ cdpPort, attempts, delay, probeCdp }) {
  for (let i = 0; i < attempts; i++) {
    await delay(1000);
    try {
      const ready = await probeCdp(cdpPort);
      if (ready) return JSON.parse(ready);
    } catch { /* retry */ }
  }
  return null;
}

/**
 * Some Windows builds block CDP for MSIX-packaged apps: direct spawn from
 * WindowsApps gets EACCES, and even COM activation passes the flag but the
 * debug port never binds (issues #42, #75, #128). Running the same files from
 * a plain directory outside WindowsApps works and keeps the user's session,
 * so copy the package into LOCALAPPDATA once per version and launch that.
 */
function _copyMsixPackageLocal(tvPath, { cpSync, rmSync, readdirSync, existsSync }) {
  const srcDir = dirname(tvPath);
  const pkgName = basename(srcDir);
  const cacheRoot = join(process.env.LOCALAPPDATA || '', 'tradingview-mcp');
  const dstDir = join(cacheRoot, pkgName);
  const dstExe = join(dstDir, 'TradingView.exe');
  if (!existsSync(dstExe)) {
    try {
      for (const entry of readdirSync(cacheRoot)) {
        if (entry !== pkgName && /^TradingView\./i.test(entry)) {
          rmSync(join(cacheRoot, entry), { recursive: true, force: true });
        }
      }
    } catch { /* cache root may not exist yet */ }
    cpSync(srcDir, dstDir, { recursive: true });
  }
  return dstExe;
}

export async function launch({ port, kill_existing, _deps } = {}) {
  const deps = _resolveLaunchDeps(_deps);
  const cdpPort = port || CDP_PORT;
  const killFirst = kill_existing !== false;
  const platform = deps.platform;

  const pathMap = {
    darwin: [
      '/Applications/TradingView.app/Contents/MacOS/TradingView',
      `${process.env.HOME}/Applications/TradingView.app/Contents/MacOS/TradingView`,
    ],
    win32: [
      `${process.env.LOCALAPPDATA}\\TradingView\\TradingView.exe`,
      `${process.env.PROGRAMFILES}\\TradingView\\TradingView.exe`,
      `${process.env['PROGRAMFILES(X86)']}\\TradingView\\TradingView.exe`,
    ],
    linux: [
      '/opt/TradingView/tradingview',
      '/opt/TradingView/TradingView',
      `${process.env.HOME}/.local/share/TradingView/TradingView`,
      '/usr/bin/tradingview',
      '/snap/tradingview/current/tradingview',
    ],
  };

  let tvPath = null;
  const candidates = pathMap[platform] || pathMap.linux;
  for (const p of candidates) {
    if (p && deps.existsSync(p)) { tvPath = p; break; }
  }

  if (!tvPath && platform === 'win32') {
    // MSIX/Windows Store install — InstallLocation is in WindowsApps, which is ACL-restricted
    // for normal `dir` enumeration but readable via Get-AppxPackage without elevation.
    try {
      const ps = 'powershell -NoProfile -Command "(Get-AppxPackage -Name \'TradingView.Desktop\' -ErrorAction SilentlyContinue).InstallLocation"';
      const installDir = deps.execSync(ps, { timeout: 5000 }).toString().trim();
      if (installDir) {
        const candidate = `${installDir}\\TradingView.exe`;
        if (deps.existsSync(candidate)) tvPath = candidate;
      }
    } catch { /* ignore */ }
  }

  if (!tvPath) {
    try {
      const cmd = platform === 'win32' ? 'where TradingView.exe' : 'which tradingview';
      tvPath = deps.execSync(cmd, { timeout: 3000 }).toString().trim().split('\n')[0];
      if (tvPath && !deps.existsSync(tvPath)) tvPath = null;
    } catch { /* ignore */ }
  }

  if (!tvPath && platform === 'darwin') {
    try {
      const found = deps.execSync('mdfind "kMDItemFSName == TradingView.app" | head -1', { timeout: 5000 }).toString().trim();
      if (found) {
        const candidate = `${found}/Contents/MacOS/TradingView`;
        if (deps.existsSync(candidate)) tvPath = candidate;
      }
    } catch { /* ignore */ }
  }

  if (!tvPath) {
    throw new Error(`TradingView not found on ${platform}. Searched: ${candidates.join(', ')}. Launch manually with: /path/to/TradingView --remote-debugging-port=${cdpPort}`);
  }

  const killExisting = async () => {
    if (platform === 'win32') {
      try {
        deps.execSync('taskkill /F /IM TradingView.exe', { timeout: 5000 });
        await deps.delay(1500);
      } catch { /* may not be running */ }
      return;
    }
    await _stopExisting({ tvPath, platform, execSync: deps.execSync, delay: deps.delay });
  };

  if (killFirst) await killExisting();

  const cdpArgs = [`--remote-debugging-port=${cdpPort}`, ...ANTI_THROTTLE_SWITCHES];
  let child = _spawnDetached(deps.spawn, tvPath, cdpArgs);
  let info = null;
  let usedLocalCopy = false;

  if (platform === 'win32' && WINDOWS_APPS_RE.test(tvPath)) {
    const earlyFailure = await _spawnFailedEarly(child);
    if (!earlyFailure) {
      info = await _waitForCdp({ cdpPort, attempts: 15, delay: deps.delay, probeCdp: deps.probeCdp });
    }
    if (!info) {
      // Direct WindowsApps launch was blocked or CDP never bound — fall back to
      // a local copy of the package (see _copyMsixPackageLocal).
      const localExe = _copyMsixPackageLocal(tvPath, deps);
      await killExisting();
      child = _spawnDetached(deps.spawn, localExe, cdpArgs);
      tvPath = localExe;
      usedLocalCopy = true;
    }
  }

  if (!info) {
    info = await _waitForCdp({ cdpPort, attempts: 15, delay: deps.delay, probeCdp: deps.probeCdp });
  }

  if (info) {
    // The CDP endpoint may belong to an instance this spawn handed off to
    // rather than the one just started; only its own arguments count.
    const switches = inspectLaunchSwitches({ cdpPort, _deps: { platform, execSync: deps.execSync } });
    if (switches.ok === false) {
      throw new Error(`CDP on port ${cdpPort} is served by TradingView pid ${switches.pid}${switches.pid !== child.pid ? ` (not the spawned pid ${child.pid} — the launch handed off to an existing instance)` : ''}, which lacks ${switches.missing.join(', ')}. Chart captures will freeze while the screen is locked. Quit TradingView and rerun tv_launch${killFirst ? '' : ' without no-kill'}.`);
    }
    return {
      success: true, platform, binary: tvPath, pid: child.pid,
      anti_throttle_ok: switches.ok, anti_throttle: switches,
      ...(switches.ok === null && { warning: _switchWarning(switches) }),
      cdp_port: cdpPort, cdp_url: `http://${CDP_HOST}:${cdpPort}`,
      browser: info.Browser, user_agent: info['User-Agent'],
      ...(usedLocalCopy && { msix_local_copy: true }),
    };
  }

  return {
    success: true, platform, binary: tvPath, pid: child.pid, cdp_port: cdpPort, cdp_ready: false,
    ...(usedLocalCopy && { msix_local_copy: true }),
    warning: 'TradingView launched but CDP not responding yet. It may still be loading. Try tv_health_check in a few seconds.',
  };
}
