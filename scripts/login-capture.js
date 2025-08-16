// scripts/login-capture.js — ใช้จับ storage.json หลังล็อกอินด้วยมือ (เฉพาะครั้งแรก)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const OUTDIR = 'out';
  const storagePath = path.join(OUTDIR, 'storage.json');
  if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR, { recursive: true });

  const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();

  console.log('เปิดหน้า Login ของ Loyverse...');
  await page.goto('https://loyverse.com/login', { waitUntil: 'domcontentloaded' });

  console.log('โปรดล็อกอินให้เสร็จ (รวม 2FA ถ้ามี) แล้วกด Ctrl+C เมื่อเข้าถึง Dashboard แล้ว');
  process.on('SIGINT', async () => {
    console.log('\\nบันทึก storageState →', storagePath);
    await context.storageState({ path: storagePath });
    await browser.close();
    process.exit(0);
  });
})();
