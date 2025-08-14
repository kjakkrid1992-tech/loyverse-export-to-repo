
// export.js (v4) — extra-robust Export click for Thai UI
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
  // Close common overlays/cookie banners
  const selectors = [
    'button:has-text("Accept")',
    'button:has-text("I agree")',
    'button:has-text("ตกลง")',
    'button:has-text("ยอมรับ")',
    'button[aria-label*="Close" i]',
    '.cdk-overlay-backdrop' // click backdrop to close menus
  ];
  for (const s of selectors) {
    const el = page.locator(s).first();
    if (await el.count()) {
      try { await el.click({ timeout: 500 }); } catch {}
    }
  }
  try { await page.keyboard.press('Escape'); } catch {}
}

async function clickExportSmart(page) {
  // 0) make sure toolbar is visible
  await page.evaluate(() => window.scrollTo(0, 0));

  // 1) direct role/button/link by name
  const names = /^(Export|ส่งออก|Download|ดาวน์โหลด|นำออก|CSV)$/i;
  const roleTargets = [
    page.getByRole('button', { name: names }).first(),
    page.getByRole('link',   { name: names }).first(),
    page.locator('[role="button"]').filter({ hasText: names }).first(),
  ];
  for (const t of roleTargets) {
    if (await t.count()) {
      try { await t.click(); return true; } catch {}
    }
  }

  // 2) generic elements containing the text
  const textTargets = [
    page.getByText(names, { exact: false }).first(),
    page.locator('text=ส่งออก').first(),
    page.locator('text=Export').first(),
    page.locator('text=ดาวน์โหลด').first(),
  ];
  for (const t of textTargets) {
    if (await t.count()) {
      try { await t.click(); return true; } catch {}
      // click closest clickable ancestor
      try {
        const h = await t.elementHandle();
        if (h) {
          await page.evaluate((el) => {
            const clickable = el.closest('button, a, [role="button"], .mat-button, .mat-stroked-button, .btn, .mdc-button');
            (clickable || el).dispatchEvent(new MouseEvent('click', { bubbles: true }));
          }, h);
          return true;
        }
      } catch {}
    }
  }

  // 3) overflow menus "เพิ่มเติม/More/Actions" then menu item Export
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
      try { await btn.click(); } catch {}
      const item = page.getByText(names).first();
      if (await item.count()) {
        try { await item.click(); return true; } catch {}
      }
      try { await page.keyboard.press('Escape'); } catch {}
    }
  }

  // 4) toolbar heuristic: find the container with "+ เพิ่มสินค้า / นำเข้า / ส่งออก"
  const addBtn = page.getByText(/^\+\s*เพิ่มสินค้า$/);
  if (await addBtn.count()) {
    try {
      const h = await addBtn.first().elementHandle();
      if (h) {
        await page.evaluate((el) => {
          const toolbar = el.closest('header, .toolbar, .mat-toolbar, .mdc-toolbar, .head, .panel, .top') || document.body;
          const candidates = toolbar.querySelectorAll('button, a, [role="button"]');
          for (const c of candidates) {
            const text = (c.innerText || c.textContent || '').trim();
            if (/^ส่งออก$|^Export$|ดาวน์โหลด|Download/i.test(text)) {
              c.click();
              return;
            }
          }
        }, h);
        // small wait to detect if dialog opened
        await page.waitForTimeout(400);
        return true;
      }
    } catch {}
  }

  // 5) scan <a> with download attribute or href contains 'export'/'download'
  const found = await page.evaluate(() => {
    const as = Array.from(document.querySelectorAll('a, button, [role="button"]'));
    for (const a of as) {
      const text = (a.innerText || a.textContent || '').trim();
      const href = (a.getAttribute && a.getAttribute('href')) || '';
      if (/^ส่งออก$|^Export$|ดาวน์โหลด|Download/i.test(text)) { a.click(); return true; }
      if (a.hasAttribute && a.hasAttribute('download')) { a.click(); return true; }
      if (/export|download|csv/i.test(href)) { a.click(); return true; }
    }
    return false;
  });
  if (found) return true;

  return false;
}

async function confirmExportIfDialog(page) {
  const dlg = page.locator('[role="dialog"], .modal, .cdk-overlay-container [role="dialog"]').first();
  if (await dlg.count()) {
    const ok = page.locator(
      'button:has-text("Export"), button:has-text("Download"), button:has-text("ตกลง"), button:has-text("ยืนยัน"), button:has-text("ดาวน์โหลด")'
    ).first();
    if (await ok.count()) { try { await ok.click(); } catch {} }
  }
}

async function navigateAndExport(page) {
  for (const url of URLS_TO_TRY) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 60000 });
    await page.waitForTimeout(1200);
    await dismissOverlays(page);

    const clicked = await clickExportSmart(page);
    if (clicked) {
      await confirmExportIfDialog(page);
      const download = await page.context().waitForEvent('download', { timeout: 60000 });
      await download.saveAs(path.join(OUTDIR, CSV_FILENAME));
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
    if (!ok) throw new Error('ไม่พบปุ่ม/เมนู "ส่งออก" บนหน้าที่รองรับ');
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
