
// export.js (v2) — robust Export detection + multi-page fallback
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUTDIR = 'out';
const CSV_FILENAME = 'inventory.csv';
const SCREENSHOT = 'error.png';

const URLS_TO_TRY = [
  'https://r.loyverse.com/dashboard/#/goods/price',           // รายการราคา
  'https://r.loyverse.com/dashboard/#/goods/items',           // สินค้า
  'https://r.loyverse.com/dashboard/#/inventory_by_items',    // สต็อกตามสินค้า
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
  // Fallback: email/password (may fail with captcha/2FA)
  const email = process.env.LOYVERSE_EMAIL;
  const password = process.env.LOYVERSE_PASSWORD;
  if (email && password) {
    const ctx = await browser.newContext({ acceptDownloads: true });
    const page = await ctx.newPage();
    await page.goto('https://loyverse.com/signin', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 60000 });
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"], input[name="password"]', password);
    const loginBtn = page.locator([
      'button:has-text("Sign in")',
      'button:has-text("เข้าสู่ระบบ")',
      'button[type="submit"]',
    ].join(', ')).first();
    await loginBtn.click();
    await page.waitForLoadState('networkidle', { timeout: 90000 });
    // Touch a backoffice url so cookies for r.loyverse.com are set
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
  // Close cookie banners / dialogs if any
  const buttons = [
    'button:has-text("Accept")',
    'button:has-text("I agree")',
    'button:has-text("ตกลง")',
    'button:has-text("ยอมรับ")',
    'button:has-text("ปิด")',
    'button[aria-label*="Close" i]',
  ];
  for (const sel of buttons) {
    const b = page.locator(sel).first();
    if (await b.count()) {
      try { await b.click({ timeout: 1000 }); } catch {}
    }
  }
  // Press Escape to close any open popovers
  try { await page.keyboard.press('Escape'); } catch {}
}

async function tryClickExport(page) {
  // 1) Direct button by role/name
  const byRole = page.getByRole('button', { name: /Export|ส่งออก|Download|ดาวน์โหลด/i }).first();
  if (await byRole.count()) {
    await byRole.click();
    return true;
  }

  // 2) Any element containing text -> click it
  const byText = page.getByText(/Export|ส่งออก|Download|ดาวน์โหลด/i).first();
  if (await byText.count()) {
    try { await byText.click(); return true; } catch {}
  }

  // 3) Common kebab/overflow menus, then select Export
  const menus = [
    'button[aria-label*="More" i]',
    'button:has([data-icon="more"])',
    '[data-testid="kebab-menu"]',
    'button:has-text("More")',
    'button:has-text("เพิ่มเติม")',
    'button:has-text("Actions")',
    'button:has-text("การดำเนินการ")',
  ];
  for (const m of menus) {
    const menuBtn = page.locator(m).first();
    if (await menuBtn.count()) {
      await menuBtn.click();
      const menuItem = page.getByText(/Export|ส่งออก|Download|ดาวน์โหลด/i).first();
      if (await menuItem.count()) {
        await menuItem.click();
        return true;
      }
      // close menu
      try { await page.keyboard.press('Escape'); } catch {}
    }
  }

  return false;
}

async function confirmExportIfDialog(page) {
  const hasDialog = await page.locator('[role="dialog"], .modal, .cdk-overlay-container [role="dialog"]').first().count();
  if (!hasDialog) return;
  const confirmBtns = page.locator([
    'button:has-text("Export")',
    'button:has-text("Download")',
    'button:has-text("ตกลง")',
    'button:has-text("ยืนยัน")',
    'button:has-text("ดาวน์โหลด")',
  ].join(', '));
  if (await confirmBtns.count()) {
    await confirmBtns.first().click();
  }
}

async function navigateAndExport(page) {
  for (const url of URLS_TO_TRY) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 60000 });
    await page.waitForTimeout(1500);
    await dismissOverlays(page);

    // Scroll up to ensure header buttons are visible
    await page.evaluate(() => { window.scrollTo(0, 0); });

    const ok = await tryClickExport(page);
    if (ok) {
      await confirmExportIfDialog(page);
      // Wait for download
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
    if (!ok) throw new Error('ไม่พบเมนู/ปุ่ม Export บนทุกหน้าที่ลอง');
    console.log('[ok] Downloaded:', path.join(OUTDIR, CSV_FILENAME));
  } catch (err) {
    console.error('[error]', err.message);
    try {
      const p = await context.newPage();
      await p.goto('https://r.loyverse.com/dashboard/#/goods/price', { waitUntil: 'domcontentloaded' }).catch(() => {});
      await p.screenshot({ path: path.join(OUTDIR, SCREENSHOT), fullPage: true }).catch(() => {});
      await p.close();
      console.error('[error] saved screenshot to out/error.png');
    } catch {}
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
