const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUTDIR = 'out';
const CSV_FILENAME = 'inventory.csv';
const SCREENSHOT = 'error.png';

const storagePath = path.join(OUTDIR, 'storage.json');

(async () => {
  if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await (async () => {
    if (process.env.LOYVERSE_STORAGE_B64) {
      try {
        fs.writeFileSync(storagePath, Buffer.from(process.env.LOYVERSE_STORAGE_B64, 'base64'));
        return await browser.newContext({ storageState: storagePath });
      } catch (err) {
        console.error('Failed to load session from LOYVERSE_STORAGE_B64:', err);
      }
    }
    if (process.env.LOYVERSE_EMAIL && process.env.LOYVERSE_PASSWORD) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto('https://loyverse.com/en/login', { waitUntil: 'domcontentloaded' });
      await page.fill('input[name="email"]', process.env.LOYVERSE_EMAIL);
      await page.fill('input[name="password"]', process.env.LOYVERSE_PASSWORD);
      await page.click('button[type="submit"]');
      await page.waitForTimeout(5000);
      const storage = await ctx.storageState();
      fs.writeFileSync(storagePath, JSON.stringify(storage));
      return ctx;
    }
    console.error("Missing login credentials. Set either LOYVERSE_STORAGE_B64 or LOYVERSE_EMAIL/PASSWORD.");
    process.exit(1);
  })();

  try {
    const page = await context.newPage();
    await page.goto('https://r.loyverse.com/dashboard/#/goods/price');
    await page.waitForTimeout(4000);

    const exportBtn = page.locator('button:has-text("Export")').first();
    await exportBtn.click();
    await page.waitForTimeout(5000);

    const downloads = await page.context().waitForEvent('download', { timeout: 10000 });
    const filePath = path.join(OUTDIR, CSV_FILENAME);
    await downloads.saveAs(filePath);
    console.log("Downloaded:", filePath);

  } catch (err) {
    console.error("ERROR:", err);
    const page = await context.newPage();
    await page.screenshot({ path: path.join(OUTDIR, SCREENSHOT) });
  } finally {
    await browser.close();
  }
})();