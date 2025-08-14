// export.js
// ใช้ Playwright ดาวน์โหลดไฟล์ Export จาก Loyverse Back Office ไปยัง out/inventory.csv
// รองรับล็อกอินด้วย storageState จาก LOYVERSE_STORAGE_B64 (แนะนำ) / out/storage.json / EMAIL+PASSWORD (สำรอง)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUTDIR = 'out';
const CSV_FILENAME = 'inventory.csv';
const SCREENSHOT = 'error.png';

// หน้า Back Office รายการราคา (เมนู "สินค้า > รายการราคา")
const DASHBOARD_URL = 'https://r.loyverse.com/dashboard/#/goods/price';

// -------------------- Utilities --------------------
function ensureOutDir() {
  if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR, { recursive: true });
}

async function newContextWithStorage(browser) {
  // 1) จาก ENV: LOYVERSE_STORAGE_B64
  const b64 = process.env.LOYVERSE_STORAGE_B64;
  if (b64) {
    try {
      const jsonText = Buffer.from(b64, 'base64').toString('utf-8');
      const storageState = JSON.parse(jsonText);
      return await browser.newContext({ storageState, acceptDownloads: true });
    } catch (e) {
      console.error('[storage] อ่าน LOYVERSE_STORAGE_B64 ไม่ได้:', e.message);
    }
  }

  // 2) จากไฟล์ out/storage.json
  const storagePath = path.join(OUTDIR, 'storage.json');
  if (fs.existsSync(storagePath)) {
    try {
      const storageState = JSON.parse(fs.readFileSync(storagePath, 'utf-8'));
      return await browser.newContext({ storageState, acceptDownloads: true });
    } catch (e) {
      console.error('[storage] อ่าน out/storage.json ไม่ได้:', e.message);
    }
  }

  // 3) สำรอง: LOYVERSE_EMAIL + LOYVERSE_PASSWORD (อาจติด Captcha/2FA)
  const email = process.env.LOYVERSE_EMAIL;
  const password = process.env.LOYVERSE_PASSWORD;
  if (email && password) {
    const ctx = await browser.newContext({ acceptDownloads: true });
    const page = await ctx.newPage();

    // หน้า signin ปัจจุบัน
    await page.goto('https://loyverse.com/signin', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 60000 });
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"], input[name="password"]', password);

    // ปุ่ม Sign in / เข้าสู่ระบบ
    const loginBtn = page.locator([
      'button:has-text("Sign in")',
      'button:has-text("เข้าสู่ระบบ")',
      'button[type="submit"]'
    ].join(', ')).first();
    await loginBtn.click();

    // รอ transition เข้าระบบ (ถ้าติด Captcha/2FA จะไม่ผ่าน)
    await page.waitForLoadState('networkidle', { timeout: 90000 });

    // เข้า Back Office สักหน้าหนึ่งให้ set คุกกี้โดเมน r.loyverse.com
    await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 60000 });

    // บันทึก storage ไว้ใช้รอบถัดไป (เฉพาะเครื่อง/runner ที่อนุญาตเขียนไฟล์)
    try {
      const state = await ctx.storageState();
      ensureOutDir();
      fs.writeFileSync(path.join(OUTDIR, 'storage.json'), JSON.stringify(state, null, 2), 'utf-8');
    } catch {}

    return ctx;
  }

  throw new Error('ไม่มีข้อมูลล็อกอิน: กรุณาตั้ง LOYVERSE_STORAGE_B64 หรือเตรียม out/storage.json หรือกำหนด LOYVERSE_EMAIL/PASSWORD');
}

async function clickExportMultiLang(page) {
  // ปุ่ม "Export/ส่งออก" อาจอยู่บนปุ่มหลัก หรือในเมนู (สามจุด)
  const candidates = [
    'button:has-text("Export")',
    'button:has-text("ส่งออก")',
    '[aria-label*="Export" i]',
    '[aria-label*="ส่งออก"]',
    'text=/^Export$/i',
    'text=/^ส่งออก$/'
  ];
  for (const sel of candidates) {
    const node = page.locator(sel).first();
    if (await node.count()) {
      await node.click();
      return true;
    }
  }

  // เมนู 3 จุด → รายการ Export/ส่งออก
  const kebab = page.locator([
    'button[aria-label*="More" i]',
    'button:has([data-icon="more"])',
    '[data-testid="kebab-menu"]'
  ].join(', ')).first();

  if (await kebab.count()) {
    await kebab.click();
    const exportItem = page.locator('text=/Export|ส่งออก/').first();
    if (await exportItem.count()) {
      await exportItem.click();
      return true;
    }
  }

  throw new Error('หาเมนู/ปุ่ม Export ไม่เจอ (UI อาจเปลี่ยนหรือสิทธิ์ไม่พอ)');
}

// บางครั้ง Loyverse จะเปิด modal ให้เลือกชนิดไฟล์/ฟิลด์ ให้พยายามคลิกยืนยันให้ได้
async function confirmExportIfDialog(page) {
  // รอ modal/กล่องโต้ตอบสั้น ๆ ถ้ามี
  const modalSelector = [
    '[role="dialog"]',
    '.modal',
    '.cdk-overlay-container [role="dialog"]'
  ].join(', ');

  const hasDialog = await page.locator(modalSelector).first().count();
  if (!hasDialog) return;

  // ปุ่มยืนยันที่พบบ่อย: Export / Download / OK / ตกลง
  const confirmBtns = page.locator([
    'button:has-text("Export")',
    'button:has-text("Download")',
    'button:has-text("ตกลง")',
    'button:has-text("ยืนยัน")',
    'button:has-text("ดาวน์โหลด")'
  ].join(', '));

  if (await confirmBtns.count()) {
    await confirmBtns.first().click();
  }
}

async function run() {
  ensureOutDir();
  const browser = await chromium.launch({ headless: true }); // GitHub Actions ใช้ headless
  let context;

  try {
    context = await newContextWithStorage(browser);
  } catch (e) {
    console.error('[context] เตรียม context ไม่สำเร็จ:', e.message);
    await browser.close();
    process.exit(1);
  }

  try {
    const page = await context.newPage();

    // เข้า Back Office
    await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 60000 });

    // เผื่อโหลดตาราง/ตัวกรอง
    await page.waitForTimeout(2000);

    // คลิก Export/ส่งออก
    await clickExportMultiLang(page);

    // เผื่อมี dialog ให้เลือก option → พยายามคลิกยืนยัน
    await confirmExportIfDialog(page);

    // รออีเวนต์ดาวน์โหลดแล้วบันทึกไฟล์
    const download = await page.context().waitForEvent('download', { timeout: 60000 });
    const saveTo = path.join(OUTDIR, CSV_FILENAME);
    await download.saveAs(saveTo);

    console.log('[ok] Downloaded:', saveTo);
  } catch (err) {
    console.error('[error]', err.message);
    try {
      // เก็บภาพหน้าจอช่วยดีบัก
      const pg = await context.newPage();
      await pg.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await pg.screenshot({ path: path.join(OUTDIR, SCREENSHOT), fullPage: true }).catch(() => {});
      await pg.close();
      console.error('[error] saved screenshot to out/error.png');
    } catch {}
    process.exit(1);
  } finally {
    await browser.close();
  }
}

run();
