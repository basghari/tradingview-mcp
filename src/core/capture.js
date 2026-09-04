/**
 * Core screenshot/capture logic.
 */
import { getClient, evaluate, getChartCollection } from '../connection.js';
import { waitForChartRender } from '../wait.js';
import { execFile } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(dirname(dirname(__dirname)), 'screenshots');

// Page.captureScreenshot needs the compositor to produce a frame; an occluded
// or minimized window can suspend frame production and leave the CDP command
// pending forever (observed 2026-09-04: two captures hung 7+ and 3+ minutes
// while Runtime.evaluate stayed responsive). Every capture is therefore
// preceded by Page.bringToFront and bounded by a hard timeout.
const CAPTURE_TIMEOUT_MS = Number(process.env.TV_CAPTURE_TIMEOUT_MS) || 20000;
const BRING_TO_FRONT_TIMEOUT_MS = 5000;
const SCREENSHOT_STAGE = 'cdp-screenshot';

export function withTimeout(promise, ms, stage) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${stage} timed out after ${ms}ms`), { stage })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function bringToFront(client) {
  try {
    await withTimeout(client.Page.bringToFront(), BRING_TO_FRONT_TIMEOUT_MS, 'bring-to-front');
  } catch {
    // Non-fatal: the capture timeout below still bounds the screenshot call.
  }
  // CDP Page.bringToFront cannot raise an Electron window above another app on
  // macOS — it resolves while document.visibilityState stays "hidden" (verified
  // 2026-09-04). If the page still reports hidden, activate the app itself: an
  // activate event, not a relaunch — the process and chart state are untouched.
  // Gated on visibility so a healthy capture never steals the user's focus.
  try {
    const vis = await withTimeout(evaluate('document.visibilityState'), 2000, 'visibility-probe');
    if (vis !== 'visible' && process.platform === 'darwin') {
      await new Promise((resolve) => execFile('open', ['-a', 'TradingView'], () => resolve()));
      // `open -a` activates the app but does not restore minimized windows
      // (verified 2026-09-04: the CDP page sat in a minimized window, stayed
      // hidden through activation, and both capture attempts timed out).
      const unminimize = [
        'tell application "System Events" to tell process "TradingView"',
        '  repeat with w in windows',
        '    if value of attribute "AXMinimized" of w is true then set value of attribute "AXMinimized" of w to false',
        '  end repeat',
        'end tell',
      ].join('\n');
      await new Promise((resolve) => execFile('osascript', ['-e', unminimize], () => resolve()));
      await new Promise((r) => setTimeout(r, 500)); // let the compositor produce a first frame
    }
  } catch {
    // Non-fatal: the capture timeout below still bounds the screenshot call.
  }
}

// Shared bounded screenshot: bringToFront, capture under the hard timeout, one
// retry after re-activating. Throws the stage-tagged timeout error if both
// attempts time out; callers decide how to surface it (structured object here,
// per-combo error entry in batch.js).
export async function boundedCapture(client, params) {
  await bringToFront(client);
  try {
    return await withTimeout(client.Page.captureScreenshot(params), CAPTURE_TIMEOUT_MS, SCREENSHOT_STAGE);
  } catch (err) {
    if (!err || err.stage !== SCREENSHOT_STAGE) throw err;
    // One retry after re-activating the window — the first bringToFront may
    // have raced the compositor waking back up.
    await bringToFront(client);
    return await withTimeout(client.Page.captureScreenshot(params), CAPTURE_TIMEOUT_MS, SCREENSHOT_STAGE);
  }
}

export async function captureScreenshot({ region, filename, method, waitForRender = false } = {}) {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  if (waitForRender) await waitForChartRender();

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const fname = (filename || `tv_${region || 'full'}_${ts}`).replace(/[\/\\]/g, '_').replace(/\.\./g, '_');
  const filePath = join(SCREENSHOT_DIR, `${fname}.png`);

  if (method === 'api') {
    try {
      const colPath = await getChartCollection();
      await evaluate(`${colPath}.takeScreenshot()`);
      return {
        success: true, method: 'api', waited_for_render: !!waitForRender,
        note: 'takeScreenshot() triggered — TradingView will save/show the screenshot via its own UI',
      };
    } catch {
      // Fall through to CDP method
    }
  }

  const client = await getClient();
  let clip = undefined;

  if (region === 'chart') {
    const bounds = await evaluate(`
      (function() {
        var el = document.querySelector('[data-name="pane-canvas"]')
          || document.querySelector('[class*="chart-container"]')
          || document.querySelector('canvas');
        if (!el) return null;
        var rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })()
    `);
    if (bounds) clip = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, scale: 1 };
  } else if (region === 'strategy_tester') {
    const bounds = await evaluate(`
      (function() {
        var el = document.querySelector('[data-name="backtesting"]')
          || document.querySelector('[class*="strategyReport"]');
        if (!el) return null;
        var rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })()
    `);
    if (bounds) clip = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, scale: 1 };
  }

  const params = { format: 'png' };
  if (clip) params.clip = clip;

  let data;
  try {
    ({ data } = await boundedCapture(client, params));
  } catch (err) {
    if (!err || err.stage !== SCREENSHOT_STAGE) throw err;
    return {
      success: false,
      stage: 'cdp-screenshot-timeout',
      error: `Page.captureScreenshot did not return within ${CAPTURE_TIMEOUT_MS}ms (two attempts, Page.bringToFront before each)`,
      hint: 'The compositor is likely not producing frames (window occluded/minimized) or the instance is wedged — kill and relaunch TradingView (tv_launch), then retry the capture.',
    };
  }
  writeFileSync(filePath, Buffer.from(data, 'base64'));

  return {
    success: true, method: 'cdp', file_path: filePath, region,
    waited_for_render: !!waitForRender,
    size_bytes: Buffer.from(data, 'base64').length,
  };
}
