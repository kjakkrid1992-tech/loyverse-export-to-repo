// export.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUTDIR = 'out';
const CSV_FILENAME = 'inventory.csv';
const SCREENSHOT = 'error.png';

const DASHBOARD_URL = 'https://r.loyverse.com/dashboard/#/goods/price';

const storagePath = path.join(OUTDIR, 'storage.json');

async function buildContext(browser) {
  // 1) ใช้ STORAGE จาก ENV (BASE64 ของ JSON)
  if (process.env.LOYVERSE_STORAGE_B64) {
    try {
      const jsonText = Buffer.from(process.env.LOYVERSE_STORAGE_B64, 'base64').toString('utf-8');
      const storageState = JSON.parse(jsonText);
      return await browser.newContext({ storageState });
    } catch (e) {
      console.error('Failed to load session from LOYVERSE_STORAGE_B64:', e);
    }
  }

  // 2) ใช้ไฟล์ storage.json (กรณีรันท้องถิ่น)
  if (fs.existsSync(storagePath)) {
    try {
      const storageState = JSON.parse(fs.readFileSync(storagePath, 'utf-8'));
      return await browser.newContext({ storageState });
    } catch (e) {
      console.error('Failed to load session from storage.json:', e);
    }
  }

  // 3) สำรอง: ล็อกอินด้วยอีเมล/รหัสผ่าน (กรณีต้องใช้จริง)
  const email = process.env.LOYVERSE_EMAIL;
  const password = process.env.LOYVERSE_PASSWORD;
  if (email && password) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    await page.goto('https://r.loyverse.com/login', { waitUntil: 'domcontentloaded' });
    // รอฟอร์มล็อกอิน
    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 30000 });
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"], input[name="password"]', password);

    // กดปุ่ม Sign in / เข้าสู่ระบบ
    const loginButton = page.locator('button:has-text("Sign in"), button:has-text("เข้าสู่ระบบ"), button[type="submit"]');
    await loginButton.first().click();

    // รอ redirect เข้าหน้า dashboard (หรือ hCaptcha/2FA ซึ่งจะล้มเหลว)
    await page.waitForLoadState('networkidle', { timeout: 60000 });
    if (page.url().includes('/login')) {
      throw new Error('Login seems to have failed or requires Captcha/2FA. Use storage state instead.');
    }

    // บันทึก storage สำหรับใช้ซ้ำในรอบถัดไป (เฉพาะรันท้องถิ่น/runner ที่อนุญาต)
    const state = await ctx.storageState();
    fs.mkdirSync(OUTDIR, { recursive: true });
    fs.writeFileSync(storagePath, JSON.stringify(state, null, 2), 'utf-8');

    return ctx;
  }

  throw new Error('Missing login credentials. Set either LOYVERSE_STORAGE_B64 or LOYVERSE_EMAIL/PASSWORD.');
}

async function clickExport(page) {
  // รองรับหลายภาษา + สำรองด้วย aria / role
  const candidates = [
    'button:has-text("Export")',
    'button:has-text("ส่งออก")',
    '[aria-label*="Export" i]',
    '[aria-label*="ส่งออก"]',
    'button >> text=/^Export$/i',
    'button >> text=/^ส่งออก$/',
  ];

  for (const sel of candidates) {
    const elt = page.locator(sel).first();
    if (await elt.count()) {
      await elt.click();
      return true;
    }
  }
  // สำรองสุดท้าย: ลองค้นหาเมนู/ไอคอน 3 จุด แล้วหา Export ภายในเมนู
  const menuKebab = page.locator('button[aria-label*="More"], button:has([data-icon="more"]), [data-testid="kebab-menu"]').first();
  if (await menuKebab.count()) {
    await menuKebab.click();
    const exportItem = page.locator('text=/Export|ส่งออก/').first();
    if (await exportItem.count()) {
      await exportItem.click();
      return true;
    }
  }
  throw new Error('Export button not found (UI might have changed or requires different selectors).');
}

(async () => {
  if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });

  let context;
  try {
    context = await buildContext(browser);
  } catch (e) {
    console.error('ERROR while preparing context:', e);
    await browser.close();
    process.exit(1);
  }

  try {
    const page = await context.newPage();
    await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle');

    // เผื่อหน้าโหลดข้อมูลราคา/ตาราง
    await page.waitForTimeout(4000);

    // คลิก Export/ส่งออก
    await clickExport(page);

    // รอ event download แล้วบันทึกไฟล์
    const download = await page.context().waitForEvent('download', { timeout: 30000 });
    const filePath = path.join(OUTDIR, CSV_FILENAME);
    await download.saveAs(filePath);
    console.log('Downloaded:', filePath);
  } catch (err) {
    console.error('ERROR:', err);
    try {
      const page = await context.newPage();
      await page.screenshot({ path: path.join(OUTDIR, SCREENSHOT), fullPage: true });
    } catch {}
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
