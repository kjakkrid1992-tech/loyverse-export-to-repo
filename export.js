
// export.js (v5) — fix race: waitForEvent('download') with Promise.all + popup fallback
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUTDIR = 'out';
const CSV_FILENAME = 'inventory.csv';
const SCREENSHOT = 'error.png';

const URLS_TO_TRY = [
  'https://r.loyverse.com/dashboard/#/goods/price?page=0&limit=10&inventory=all',
  'https://r.loyverse.com/dashboard/#/goods/items',
  'https://r.loyverse.com/dashboard/#/inventory_by_items',
  'https://r.loyverse.com/dashboard/#/inventory',
];

function ensureOutDir() {
  if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR, { recursive: true });
}

async function newContextWithStorage(browser) {
  const b64 = process.env.LOYVERSE_STORAGE_B64;
  if (b64) {
    try {
      const jsonText = Buffer.from(b64, 'base64').toString('utf-8');
      const storageState = JSON.parse(jsonText);
      return await browser.newContext({ storageState, acceptDownloads: true });
    } catch (e) {
      console.error('[storage] LOYVERSE_STORAGE_B64 parse error:', e.message);
    }
  }
  const storagePath = path.join(OUTDIR, 'storage.json');
  if (fs.existsSync(storagePath)) {
    try {
      const storageState = JSON.parse(fs.readFileSync(storagePath, 'utf-8'));
      return await browser.newContext({ storageState, acceptDownloads: true });
    } catch (e) {
      console.error('[storage] out/storage.json parse error:', e.message);
    }
  }
  const email = process.env.LOYVERSE_EMAIL;
  const password = process.env.LOYVERSE_PASSWORD;
  if (email && password) {
    const ctx = await browser.newContext({ acceptDownloads: true });
    const page = await ctx.newPage();
    await page.goto('https://loyverse.com/signin', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 60000 });
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"], input[name="password"]', password);
    const loginBtn = page.locator(
      'button:has-text("Sign in"), button:has-text("เข้าสู่ระบบ"), button[type="submit"]'
    ).first();
    await loginBtn.click();
    await page.waitForLoadState('networkidle', { timeout: 90000 });
    await page.goto(URLS_TO_TRY[0], { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 60000 });
    try {
      const state = await ctx.storageState();
      ensureOutDir();
      fs.writeFileSync(path.join(OUTDIR, 'storage.json'), JSON.stringify(state, null, 2), 'utf-8');
    } catch {}
    return ctx;
  }
  throw new Error('Missing login credentials. Provide LOYVERSE_STORAGE_B64 or out/storage.json or LOYVERSE_EMAIL/PASSWORD');
}

async function dismissOverlays(page) {
  const selectors = [
    'button:has-text("Accept")',
    'button:has-text("I agree")',
    'button:has-text("ตกลง")',
    'button:has-text("ยอมรับ")',
    'button[aria-label*="Close" i]',
    '.cdk-overlay-backdrop'
  ];
  for (const s of selectors) {
    const el = page.locator(s).first();
    if (await el.count()) {
      try { await el.click({ timeout: 500 }); } catch {}
    }
  }
  try { await page.keyboard.press('Escape'); } catch {}
}

function candidatesForExport(page) {
  const names = /^(Export|ส่งออก|Download|ดาวน์โหลด|นำออก|CSV)$/i;
  return [
    page.getByRole('button', { name: names }).first(),
    page.getByRole('link',   { name: names }).first(),
    page.locator('[role="button"]').filter({ hasText: names }).first(),
    page.getByText(names, { exact: false }).first(),
    page.locator('text=ส่งออก').first(),
    page.locator('text=Export').first(),
    page.locator('text=ดาวน์โหลด').first(),
  ];
}

async function openExportMenuIfAny(page) {
  const menus = [
    'button:has-text("เพิ่มเติม")',
    'button:has-text("More")',
    'button:has-text("Actions")',
    'button[aria-label*="More" i]',
    '[data-testid="kebab-menu"]',
    'button:has([data-icon="more"])',
  ];
  for (const m of menus) {
    const btn = page.locator(m).first();
    if (await btn.count()) {
      try { await btn.click(); await page.waitForTimeout(150); } catch {}
      const item = page.getByText(/Export|ส่งออก|Download|ดาวน์โหลด|นำออก/i).first();
      if (await item.count()) return item;
      try { await page.keyboard.press('Escape'); } catch {}
    }
  }
  return null;
}

async function clickExportAndWait(page) {
  await page.evaluate(() => window.scrollTo(0, 0));

  // Case A: clickable candidates directly trigger download
  for (const t of candidatesForExport(page)) {
    if (await t.count()) {
      try {
        const [download] = await Promise.all([
          page.context().waitForEvent('download', { timeout: 15000 }),
          t.click()
        ]);
        return download;
      } catch {}
    }
  }

  // Case B: open menu then click export item
  const menuItem = await openExportMenuIfAny(page);
  if (menuItem && await menuItem.count()) {
    try {
      const [download] = await Promise.all([
        page.context().waitForEvent('download', { timeout: 15000 }),
        menuItem.click()
      ]);
      return download;
    } catch {}
  }

  // Case C: dialog appears (format/options) -> click confirm while listening for download
  const dialogSel = '[role="dialog"], .modal, .cdk-overlay-container [role="dialog"]';
  if (await page.locator(dialogSel).first().count()) {
    const confirm = page.locator(
      'button:has-text("Export"), button:has-text("Download"), button:has-text("ตกลง"), button:has-text("ยืนยัน"), button:has-text("ดาวน์โหลด")'
    ).first();
    if (await confirm.count()) {
      try {
        const [download] = await Promise.all([
          page.context().waitForEvent('download', { timeout: 15000 }),
          confirm.click()
        ]);
        return download;
      } catch {}
    }
  }

  // Case D: some UIs open a new tab (popup) with CSV
  try {
    const [popup] = await Promise.all([
      page.waitForEvent('popup', { timeout: 5000 }),
      // as a last click attempt: try text again (might focus link)
      (async () => { for (const t of candidatesForExport(page)) { if (await t.count()) { try { await t.click(); break; } catch {} } } })()
    ]);
    await popup.waitForLoadState('domcontentloaded', { timeout: 10000 });
    const res = await popup.waitForResponse(resp => /text\/csv|application\/octet-stream/i.test(resp.headers()['content-type'] || ''), { timeout: 10000 }).catch(() => null);
    if (res) {
      const body = await res.body();
      const saveTo = path.join(OUTDIR, CSV_FILENAME);
      fs.writeFileSync(saveTo, body);
      await popup.close().catch(() => {});
      return { saveAs: async (p) => fs.copyFileSync(saveTo, p) };
    }
  } catch {}

  return null;
}

async function navigateAndExport(page) {
  for (const url of URLS_TO_TRY) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 60000 });
    await page.waitForTimeout(1200);
    await dismissOverlays(page);

    const dl = await clickExportAndWait(page);
    if (dl) {
      await dl.saveAs(path.join(OUTDIR, CSV_FILENAME));
      return true;
    }
  }
  return false;
}

(async () => {
  ensureOutDir();
  const browser = await chromium.launch({ headless: true });
  let context;
  try {
    context = await newContextWithStorage(browser);
  } catch (e) {
    console.error('[context]', e.message);
    await browser.close();
    process.exit(1);
  }

  try {
    const page = await context.newPage();
    const ok = await navigateAndExport(page);
    if (!ok) throw new Error('ยังไม่พบการดาวน์โหลดหลังคลิก "ส่งออก" — อาจต้องระบุหน้า/สิทธิ์การใช้งาน');
    console.log('[ok] Downloaded:', path.join(OUTDIR, CSV_FILENAME));
  } catch (err) {
    console.error('[error]', err.message);
    try {
      const pg = await context.newPage();
      await pg.goto('https://r.loyverse.com/dashboard/#/goods/price?page=0&limit=10&inventory=all', { waitUntil: 'domcontentloaded' }).catch(() => {});
      await pg.screenshot({ path: path.join(OUTDIR, SCREENSHOT), fullPage: true }).catch(() => {});
      await pg.close();
      console.error('[error] saved screenshot to out/error.png');
    } catch {}
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
