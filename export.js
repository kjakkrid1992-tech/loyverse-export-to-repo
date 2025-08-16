// export.js — Items-only export with tracing + timeouts
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUTDIR = 'out';
const CSV_FILENAME = 'inventory.csv';
const SCREENSHOT = 'error.png';
const TRACE_ZIP = 'trace.zip';
const DEFAULT_ITEMS_URL = 'https://r.loyverse.com/dashboard/#/goods/items';

const storagePath = path.join(OUTDIR, 'storage.json');

function ensureOutdir() {
  if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR, { recursive: true });
}

function decodeStorageFromEnv() {
  const b64 = process.env.LOYVERSE_STORAGE_B64;
  if (!b64) {
    throw new Error('ENV LOYVERSE_STORAGE_B64 is missing. Put your Base64-encoded storage.json into GitHub Secret.');
  }
  const json = Buffer.from(b64, 'base64').toString('utf8');
  fs.writeFileSync(storagePath, json, 'utf8');
}

function setGlobalTimeout(ms) {
  setTimeout(() => {
    console.error(`HARD TIMEOUT after ${ms}ms — exiting`);
    process.exit(124);
  }, ms).unref();
}

(async () => {
  ensureOutdir();
  decodeStorageFromEnv();

  const headless = process.env.HEADLESS === '0' ? false : true;
  const itemsUrl = process.env.LOYVERSE_ITEMS_URL || DEFAULT_ITEMS_URL;
  const maxRunMs = parseInt(process.env.MAX_RUN_MS || '600000', 10); // 10min hard stop
  setGlobalTimeout(maxRunMs);

  const browser = await chromium.launch({
    headless,
    args: ['--disable-dev-shm-usage', '--no-sandbox'],
  });

  let context;
  try {
    context = await chromium.launchPersistentContext('', {
      headless,
      args: ['--disable-dev-shm-usage', '--no-sandbox'],
      storageState: storagePath,
    });
  } catch (e) {
    const tmpBrowser = await chromium.launch({ headless });
    context = await tmpBrowser.newContext({ storageState: storagePath });
  }

  // Start tracing
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

  try {
    const page = await context.newPage();

    console.log('Go to Items page:', itemsUrl);
    await page.goto(itemsUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });

    // Detect login screen early
    if ((await page.content()).toLowerCase().includes('login')) {
      console.error('LOGIN_REQUIRED: session may be expired — recapture storage.json');
    }

    // Wait Export button
    const exportButton = page.getByRole('button', { name: /ส่งออก|Export/i });
    await exportButton.waitFor({ state: 'visible', timeout: 60000 });

    await page.waitForTimeout(4000);

    async function tryDirectDownload() {
      try {
        const [ download ] = await Promise.all([
          page.waitForEvent('download', { timeout: 8000 }),
          exportButton.click()
        ]);
        return download;
      } catch (_) {
        return null;
      }
    }

    async function tryModalCsvDownload() {
      await exportButton.click();
      const csvCandidates = [
        page.getByRole('menuitem', { name: /CSV/i }),
        page.getByRole('button', { name: /CSV/i }),
        page.getByText(/CSV/i)
      ];
      for (const cand of csvCandidates) {
        try {
          await cand.waitFor({ state: 'visible', timeout: 3000 });
          await cand.click({ timeout: 3000 });
          const download = await page.waitForEvent('download', { timeout: 20000 });
          return download;
        } catch (_) {}
      }
      return null;
    }

    let download = await tryDirectDownload();
    if (!download) {
      console.log('Direct download not detected, trying modal CSV flow...');
      download = await tryModalCsvDownload();
    }
    if (!download) {
      throw new Error('Export failed: could not detect download after clicking Export/CSV.');
    }

    const filePath = path.join(OUTDIR, CSV_FILENAME);
    await download.saveAs(filePath);
    console.log('Downloaded:', filePath);

    const stat = fs.statSync(filePath);
    if (!stat.size) throw new Error('Downloaded CSV is empty');

  } catch (err) {
    console.error('ERROR:', err);
    try {
      const page = await context.newPage();
      await page.screenshot({ path: path.join(OUTDIR, SCREENSHOT), fullPage: true });
    } catch (e) {}
    process.exitCode = 1;
  } finally {
    // Save trace always
    try {
      await context.tracing.stop({ path: path.join(OUTDIR, TRACE_ZIP) });
    } catch (e) {}
    try { await context.close(); } catch (_) {}
  }
})();
