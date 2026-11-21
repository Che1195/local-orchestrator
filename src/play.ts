// Best-possible arm: play a Snake file in sandboxed headless Chromium, offline, and save evidence for Claude's
// review: screenshots at each step, console and page errors, the buttons found, and whether the board changed.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Page } from 'playwright';

export interface PlayReport {
  file: string;
  loaded: boolean;
  errors: string[];
  blockedRequests: string[];
  buttons: string[];
  canvas: { width: number; height: number } | null;
  steps: { name: string; screenshot: string; boardHash: string | null; note: string }[];
  boardChangedAfterStart: boolean | null;
  boardChangedWhilePaused: boolean | null;
  mobile: { screenshot: string; horizontalOverflow: boolean } | null;
}

async function boardHash(page: Page): Promise<string | null> {
  // In-page code is a string so this file needs no DOM types.
  return page.evaluate<string | null>(`(() => {
    const c = document.querySelector('canvas');
    if (!c) return null;
    try {
      const data = c.toDataURL();
      let h = 0;
      for (let i = 0; i < data.length; i++) h = (h * 31 + data.charCodeAt(i)) | 0;
      return String(h);
    } catch { return 'unreadable'; }
  })()`);
}

async function clickButton(page: Page, pattern: RegExp): Promise<string> {
  const button = page.getByRole('button', { name: pattern }).first();
  if ((await button.count()) === 0) return `no button matching ${pattern}`;
  await button.click({ timeout: 2000 }).catch((e: unknown) => { throw new Error(`click ${pattern} failed: ${String(e)}`); });
  return `clicked ${pattern}`;
}

export async function playEvidence(htmlPath: string, outDir: string): Promise<PlayReport> {
  await mkdir(outDir, { recursive: true });
  const report: PlayReport = { file: htmlPath, loaded: false, errors: [], blockedRequests: [], buttons: [], canvas: null, steps: [], boardChangedAfterStart: null, boardChangedWhilePaused: null, mobile: null };
  const browser = await chromium.launch({ chromiumSandbox: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    // Offline: only the file itself and inline data may load.
    await context.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith('file:') || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
      report.blockedRequests.push(url);
      return route.abort();
    });
    const page = await context.newPage();
    page.on('console', msg => { if (msg.type() === 'error') report.errors.push(`console: ${msg.text()}`); });
    page.on('pageerror', err => report.errors.push(`page error: ${err.message}`));
    const shot = async (name: string, note: string) => {
      const screenshot = join(outDir, `${String(report.steps.length + 1).padStart(2, '0')}-${name}.png`);
      await page.screenshot({ path: screenshot });
      report.steps.push({ name, screenshot, boardHash: await boardHash(page), note });
    };
    await page.goto(pathToFileURL(htmlPath).href, { timeout: 10_000 });
    report.loaded = true;
    await page.waitForTimeout(600);
    report.buttons = (await page.getByRole('button').allTextContents()).map(t => t.trim()).filter(Boolean);
    report.canvas = await page.evaluate<{ width: number; height: number } | null>(`(() => { const c = document.querySelector('canvas'); return c ? { width: c.width, height: c.height } : null; })()`);
    await shot('ready', 'page loaded, nothing pressed');
    const started = await clickButton(page, /start|play|restart/i).catch((e: unknown) => String(e));
    await page.waitForTimeout(1200);
    await shot('after-start', started);
    report.boardChangedAfterStart = report.steps[0]?.boardHash !== report.steps[1]?.boardHash;
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(500);
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(800);
    await shot('after-turns', 'pressed ArrowUp, then ArrowLeft');
    const paused = await clickButton(page, /pause/i).catch((e: unknown) => String(e));
    await page.waitForTimeout(300);
    const pausedA = await boardHash(page);
    await page.waitForTimeout(1200);
    await shot('paused', `${paused}; waited 1.2 s`);
    report.boardChangedWhilePaused = pausedA !== report.steps[report.steps.length - 1]?.boardHash;
    const resumed = await clickButton(page, /resume|pause/i).catch((e: unknown) => String(e));
    await page.waitForTimeout(8000);
    await shot('later', `${resumed}; ran 8 s without input (expect a wall hit and game over)`);
    const restarted = await clickButton(page, /restart|start|play/i).catch((e: unknown) => String(e));
    await page.waitForTimeout(800);
    await shot('after-restart', restarted);

    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await phone.route('**/*', route => (route.request().url().startsWith('file:') ? route.continue() : route.abort()));
    const p2 = await phone.newPage();
    await p2.goto(pathToFileURL(htmlPath).href, { timeout: 10_000 });
    await p2.waitForTimeout(600);
    const mobileShot = join(outDir, 'phone.png');
    await p2.screenshot({ path: mobileShot, fullPage: true });
    report.mobile = { screenshot: mobileShot, horizontalOverflow: await p2.evaluate<boolean>('document.documentElement.scrollWidth > window.innerWidth + 1') };
  } catch (e) {
    report.errors.push(`harness: ${String(e)}`);
  } finally {
    await browser.close();
    await writeFile(join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}
