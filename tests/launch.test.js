/**
 * Tests for launch() in src/core/health.js.
 * Covers Windows MSIX handling: direct WindowsApps spawn, local-copy fallback
 * when spawn fails or CDP never binds, copy reuse, and classic-path launches.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { launch, inspectLaunchSwitches } from '../src/core/health.js';

const MSIX_EXE = 'C:\\Program Files\\WindowsApps\\TradingView.Desktop_3.1.0.7818_x64__n534cwy3pjxzj\\TradingView.exe';
const LOCAL_COPY_EXE = `${process.env.LOCALAPPDATA || ''}\\tradingview-mcp\\TradingView.Desktop_3.1.0.7818_x64__n534cwy3pjxzj\\TradingView.exe`;
const CDP_VERSION = JSON.stringify({ Browser: 'Chrome/140', 'User-Agent': 'TVDesktop/3.1.0' });

// ── Mock helpers ─────────────────────────────────────────────────────────

function mockChild({ failWith } = {}) {
  const child = new EventEmitter();
  child.pid = 12345;
  child.unref = () => {};
  if (failWith) queueMicrotask(() => child.emit('error', Object.assign(new Error(failWith), { code: failWith })));
  return child;
}

/**
 * Build a _deps bundle simulating a win32 MSIX environment.
 * @param {object} opts
 *   spawnFailures — spawn paths (substring) that emit EACCES
 *   cdpBindsFor  — spawn paths (substring) after which probeCdp starts succeeding
 *   copyExists   — local copy already present
 */
function msixDeps({ spawnFailures = [], cdpBindsFor = [], copyExists = false } = {}) {
  const state = { spawned: [], copies: [], removed: [], killed: 0, cdpUp: false };
  const deps = {
    existsSync: (p) => {
      if (p === MSIX_EXE) return true;
      if (p.includes('tradingview-mcp')) return copyExists || state.copies.length > 0;
      return false;
    },
    execSync: (cmd) => {
      if (cmd.includes('Get-AppxPackage')) {
        return 'C:\\Program Files\\WindowsApps\\TradingView.Desktop_3.1.0.7818_x64__n534cwy3pjxzj\n';
      }
      if (cmd.includes('taskkill')) { state.killed++; return ''; }
      throw new Error(`unexpected execSync: ${cmd}`);
    },
    spawn: (exe) => {
      state.spawned.push(exe);
      const fail = spawnFailures.some((s) => exe.includes(s));
      if (!fail && cdpBindsFor.some((s) => exe.includes(s))) state.cdpUp = true;
      return mockChild(fail ? { failWith: 'EACCES' } : {});
    },
    cpSync: (src, dst) => { state.copies.push({ src, dst }); },
    rmSync: (p) => { state.removed.push(p); },
    readdirSync: () => ['TradingView.Desktop_3.0.0.7652_x64__n534cwy3pjxzj'],
    delay: async () => {},
    probeCdp: async () => (state.cdpUp ? CDP_VERSION : null),
  };
  return { deps, state };
}

// launch() only takes the MSIX code path on win32; skip elsewhere.
const onWindows = process.platform === 'win32';

describe('launch() — MSIX WindowsApps handling', { skip: !onWindows }, () => {
  it('direct WindowsApps spawn that binds CDP does not copy', async () => {
    const { deps, state } = msixDeps({ cdpBindsFor: ['WindowsApps'] });
    const result = await launch({ _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.binary, MSIX_EXE);
    assert.equal(result.msix_local_copy, undefined);
    assert.equal(state.copies.length, 0);
    assert.equal(result.cdp_url, 'http://127.0.0.1:9222');
  });

  it('EACCES on direct spawn falls back to local copy', async () => {
    const { deps, state } = msixDeps({ spawnFailures: ['WindowsApps'], cdpBindsFor: ['tradingview-mcp'] });
    const result = await launch({ _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.msix_local_copy, true);
    assert.equal(result.binary, LOCAL_COPY_EXE);
    assert.equal(state.copies.length, 1);
    assert.match(state.copies[0].src, /WindowsApps/);
    // stale cached version of another release is cleaned up first
    assert.equal(state.removed.length, 1);
    assert.match(state.removed[0], /3\.0\.0\.7652/);
    // the CDP-less direct instance is killed before relaunching from the copy
    assert.ok(state.killed >= 2);
  });

  it('CDP never binding on direct spawn falls back to local copy', async () => {
    const { deps, state } = msixDeps({ cdpBindsFor: ['tradingview-mcp'] });
    const result = await launch({ _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.msix_local_copy, true);
    assert.equal(state.spawned.length, 2);
    assert.match(state.spawned[0], /WindowsApps/);
    assert.match(state.spawned[1], /tradingview-mcp/);
  });

  it('reuses an existing local copy without re-copying', async () => {
    const { deps, state } = msixDeps({ spawnFailures: ['WindowsApps'], cdpBindsFor: ['tradingview-mcp'], copyExists: true });
    const result = await launch({ _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.msix_local_copy, true);
    assert.equal(state.copies.length, 0);
  });

  it('returns cdp_ready:false warning when nothing binds', async () => {
    const { deps } = msixDeps({});
    const result = await launch({ _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.cdp_ready, false);
    assert.equal(result.msix_local_copy, true);
    assert.ok(result.warning);
  });
});

describe('launch() — classic install path', { skip: !onWindows }, () => {
  it('launches classic LOCALAPPDATA install without MSIX logic', async () => {
    const classicExe = `${process.env.LOCALAPPDATA}\\TradingView\\TradingView.exe`;
    const state = { spawned: [], cdpUp: false };
    const deps = {
      existsSync: (p) => p === classicExe,
      execSync: (cmd) => { if (cmd.includes('taskkill')) return ''; throw new Error(`unexpected: ${cmd}`); },
      spawn: (exe) => { state.spawned.push(exe); state.cdpUp = true; return mockChild(); },
      cpSync: () => { throw new Error('should not copy'); },
      rmSync: () => {},
      readdirSync: () => [],
      delay: async () => {},
      probeCdp: async () => (state.cdpUp ? CDP_VERSION : null),
    };
    const result = await launch({ _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.binary, classicExe);
    assert.equal(result.msix_local_copy, undefined);
    assert.deepEqual(state.spawned, [classicExe]);
  });

  it('throws a helpful error when TradingView is not found', async () => {
    const deps = {
      existsSync: () => false,
      execSync: () => { throw new Error('not found'); },
      spawn: () => { throw new Error('should not spawn'); },
      cpSync: () => {}, rmSync: () => {}, readdirSync: () => [],
      delay: async () => {}, probeCdp: async () => null,
    };
    await assert.rejects(() => launch({ _deps: deps }), /TradingView not found/);
  });
});

// ── macOS launch: stop-existing + anti-throttling switch verification ────
// Simulated with _deps.platform = 'darwin', so these run on any OS.

const MAC_EXE = '/Applications/TradingView.app/Contents/MacOS/TradingView';
const SWITCHES = ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];

/**
 * Simulated process table for darwin.
 *   existing — args of an already-running main process (null = none running)
 *   resist   — which stop steps the existing process ignores: 'quit', 'TERM', 'KILL'
 *   noLsof   — lsof unavailable
 */
function macDeps({ existing = null, resist = [], noLsof = false } = {}) {
  const state = { procs: [], listener: null, cmds: [], spawned: [], nextPid: 500 };
  if (existing !== null) {
    state.procs.push({ pid: 100, args: existing });
    state.listener = 100;
  }
  const remove = (step) => { if (!resist.includes(step)) { state.procs = []; state.listener = null; } };
  const deps = {
    platform: 'darwin',
    existsSync: (p) => p === MAC_EXE,
    execSync: (cmd) => {
      state.cmds.push(cmd);
      if (cmd.startsWith('pgrep -x')) {
        if (!state.procs.length) throw new Error('pgrep: no match');
        return state.procs.map((p) => p.pid).join('\n') + '\n';
      }
      if (cmd.startsWith('osascript')) { remove('quit'); return ''; }
      if (cmd.startsWith('kill -TERM')) { remove('TERM'); return ''; }
      if (cmd.startsWith('kill -KILL')) { remove('KILL'); return ''; }
      if (cmd.startsWith('lsof')) {
        if (noLsof || !state.listener) throw new Error('lsof: nothing');
        return `${state.listener}\n`;
      }
      if (cmd.startsWith('ps -ww -o args= -p')) {
        const pid = Number(cmd.split(' ').pop());
        const p = state.procs.find((x) => x.pid === pid);
        if (!p) throw new Error('ps: no such pid');
        return `${p.args}\n`;
      }
      throw new Error(`unexpected execSync: ${cmd}`);
    },
    spawn: (exe, args) => {
      state.spawned.push({ exe, args });
      const child = mockChild();
      child.pid = state.nextPid++;
      // Single-instance handoff: a second launch passes control to the running app and exits.
      if (!state.procs.length) {
        state.procs.push({ pid: child.pid, args: [exe, ...args].join(' ') });
        state.listener = child.pid;
      }
      return child;
    },
    cpSync: () => { throw new Error('should not copy'); },
    rmSync: () => {}, readdirSync: () => [],
    delay: async () => {},
    probeCdp: async () => (state.listener ? CDP_VERSION : null),
  };
  return { deps, state };
}

const OLD_ARGS = `${MAC_EXE} --remote-debugging-port=9222`;

describe('launch() — darwin stop-existing and switch verification', () => {
  it('spawns with all anti-throttling switches when nothing is running', async () => {
    const { deps, state } = macDeps();
    const result = await launch({ _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.anti_throttle_ok, true);
    assert.deepEqual(result.anti_throttle.missing, []);
    for (const sw of SWITCHES) assert.ok(state.spawned[0].args.includes(sw), sw);
    assert.ok(!state.cmds.some((c) => c.startsWith('osascript') || c.startsWith('kill')));
  });

  it('quits a running instance gracefully before spawning', async () => {
    const { deps, state } = macDeps({ existing: OLD_ARGS });
    const result = await launch({ _deps: deps });
    assert.equal(result.anti_throttle_ok, true);
    assert.equal(result.anti_throttle.pid, result.pid);
    assert.ok(state.cmds.some((c) => c.startsWith('osascript')));
    assert.ok(!state.cmds.some((c) => c.startsWith('kill')));
  });

  it('escalates to SIGTERM when quit is ignored', async () => {
    const { deps, state } = macDeps({ existing: OLD_ARGS, resist: ['quit'] });
    const result = await launch({ _deps: deps });
    assert.equal(result.anti_throttle_ok, true);
    assert.ok(state.cmds.includes('kill -TERM 100'));
    assert.ok(!state.cmds.some((c) => c.startsWith('kill -KILL')));
  });

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const { deps, state } = macDeps({ existing: OLD_ARGS, resist: ['quit', 'TERM'] });
    const result = await launch({ _deps: deps });
    assert.equal(result.anti_throttle_ok, true);
    assert.ok(state.cmds.includes('kill -KILL 100'));
  });

  it('refuses to spawn when the old instance survives every stop step', async () => {
    const { deps, state } = macDeps({ existing: OLD_ARGS, resist: ['quit', 'TERM', 'KILL'] });
    await assert.rejects(() => launch({ _deps: deps }), /Could not stop the running TradingView \(pid 100\)/);
    assert.equal(state.spawned.length, 0);
  });

  it('fails loudly when the launch hands off to a switch-less instance (kill_existing:false)', async () => {
    const { deps } = macDeps({ existing: OLD_ARGS });
    await assert.rejects(() => launch({ kill_existing: false, _deps: deps }), /pid 100 \(not the spawned pid .*handed off.*lacks --disable-backgrounding-occluded-windows/);
  });

  it('accepts a handoff to an instance that already has the switches', async () => {
    const { deps } = macDeps({ existing: `${OLD_ARGS} ${SWITCHES.join(' ')}` });
    const result = await launch({ kill_existing: false, _deps: deps });
    assert.equal(result.anti_throttle_ok, true);
    assert.equal(result.anti_throttle.pid, 100);
  });

  it('warns (anti_throttle_ok null) when the CDP process cannot be inspected', async () => {
    const { deps } = macDeps({ noLsof: true });
    const result = await launch({ _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.anti_throttle_ok, null);
    assert.match(result.warning, /Could not verify/);
  });

  it('never uses pkill -f (it matches unrelated shells mentioning TradingView)', async () => {
    const { deps, state } = macDeps({ existing: OLD_ARGS, resist: ['quit', 'TERM'] });
    await launch({ _deps: deps });
    assert.ok(!state.cmds.some((c) => c.includes('pkill')));
    assert.ok(state.cmds.filter((c) => c.startsWith('pgrep')).every((c) => c === 'pgrep -x "TradingView"'));
  });
});

describe('inspectLaunchSwitches()', () => {
  it('reports the missing switches of the CDP-serving process', () => {
    const { deps } = macDeps({ existing: `${OLD_ARGS} --disable-renderer-backgrounding` });
    const r = inspectLaunchSwitches({ cdpPort: 9222, _deps: deps });
    assert.equal(r.ok, false);
    assert.equal(r.pid, 100);
    assert.deepEqual(r.present, ['--disable-renderer-backgrounding']);
    assert.deepEqual(r.missing, ['--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling']);
  });

  it('returns ok:null when nothing listens on the port', () => {
    const { deps } = macDeps();
    const r = inspectLaunchSwitches({ cdpPort: 9222, _deps: deps });
    assert.equal(r.ok, null);
    assert.match(r.error, /no process found listening/);
  });
});
