
// export.js (v6) — robust "ส่งออก" automation with download/popup/response fallbacks
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

function textCandidates() {
  return /Export|ส่งออก|Download|ดาวน์โหลด|นำออก|CSV|Excel|ไฟล์/i;
}

function exportCandidates(page) {
  const names = textCandidates();
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

async function openOverflowMenu(page) {
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
      try { await btn.click(); await page.waitForTimeout(200); } catch {}
      // return the element inside menu that matches export terms if visible
      const item = page.getByText(textCandidates()).first();
      if (await item.count()) return item;
      try { await page.keyboard.press('Escape'); } catch {}
    }
  }
  return null;
}

async function waitForFileLike(page) {
  // Prepare listeners BEFORE clicking
  const downloadP = page.context().waitForEvent('download', { timeout: 20000 }).catch(() => null);
  const popupP    = page.waitForEvent('popup', { timeout: 20000 }).catch(() => null);
  const responseP = page.waitForResponse(resp => {
    const ct = (resp.headers()['content-type'] || '').toLowerCase();
    const url = resp.url();
    return /text\/csv|application\/octet-stream/.test(ct) || /export|download|csv/i.test(url);
  }, { timeout: 20000 }).catch(() => null);
  return { downloadP, popupP, responseP };
}

async function saveFromAny(download, popup, response) {
  if (download) {
    await download.saveAs(path.join(OUTDIR, CSV_FILENAME));
    return true;
  }
  if (popup) {
    try {
      await popup.waitForLoadState('domcontentloaded', { timeout: 10000 });
      const resp = await popup.waitForResponse(r => {
        const ct = (r.headers()['content-type'] || '').toLowerCase();
        return /text\/csv|application\/octet-stream/.test(ct);
      }, { timeout: 10000 }).catch(() => null);
      if (resp) {
        const body = await resp.body();
        fs.writeFileSync(path.join(OUTDIR, CSV_FILENAME), body);
        await popup.close().catch(() => {});
        return true;
      }
    } catch {}
  }
  if (response) {
    try {
      const body = await response.body();
      fs.writeFileSync(path.join(OUTDIR, CSV_FILENAME), body);
      return true;
    } catch {}
  }
  return false;
}

async function clickWithFileWait(page, clickFn) {
  const { downloadP, popupP, responseP } = await waitForFileLike(page);
  await clickFn();
  const saved = await saveFromAny(await downloadP, await popupP, await responseP);
  return saved;
}

async function maybeHandleExportDialog(page) {
  const dlg = page.locator('[role="dialog"], .modal, .cdk-overlay-container [role="dialog"]').first();
  if (await dlg.count()) {
    // common confirm buttons
    const confirm = page.locator(
      'button:has-text("Export"), button:has-text("Download"), button:has-text("ตกลง"), button:has-text("ยืนยัน"), button:has-text("ดาวน์โหลด"), button:has-text("ส่งออก")'
    ).first();
    if (await confirm.count()) {
      const saved = await clickWithFileWait(page, async () => { await confirm.click(); });
      if (saved) return true;
    }
    // sometimes dialog shows options list first
    const options = page.getByText(/CSV|Excel|All|ทั้งหมด|รายการทั้งหมด|สินค้าทั้งหมด/i).first();
    if (await options.count()) {
      try { await options.click(); } catch {}
      const confirm2 = page.getByText(/Export|ส่งออก|Download|ดาวน์โหลด|ตกลง|ยืนยัน/i).first();
      if (await confirm2.count()) {
        const saved2 = await clickWithFileWait(page, async () => { await confirm2.click(); });
        if (saved2) return true;
      }
    }
  }
  return false;
}

async function navigateAndExport(page) {
  for (const url of URLS_TO_TRY) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 60000 });
    await page.waitForTimeout(1200);
    await dismissOverlays(page);
    await page.evaluate(() => window.scrollTo(0, 0));

    // A) try direct buttons/links
    for (const t of exportCandidates(page)) {
      if (await t.count()) {
        const saved = await clickWithFileWait(page, async () => { await t.click(); });
        if (saved) return true;

        // if menu opened after click, choose item then confirm
        const menuItem = page.getByText(textCandidates()).first();
        if (await menuItem.count()) {
          const saved2 = await clickWithFileWait(page, async () => { await menuItem.click(); });
          if (saved2) return true;
          const ok = await maybeHandleExportDialog(page);
          if (ok) return true;
        }
        // or dialog path
        const ok2 = await maybeHandleExportDialog(page);
        if (ok2) return true;
      }
    }

    // B) try overflow menus
    const item = await openOverflowMenu(page);
    if (item && await item.count()) {
      const saved = await clickWithFileWait(page, async () => { await item.click(); });
      if (saved) return true;
      const ok = await maybeHandleExportDialog(page);
      if (ok) return true;
    }

    // C) heuristics: scan toolbar near "+ เพิ่มสินค้า"
    const addBtn = page.getByText(/^\+\s*เพิ่มสินค้า$/).first();
    if (await addBtn.count()) {
      try {
        const h = await addBtn.elementHandle();
        if (h) {
          const saved = await clickWithFileWait(page, async () => {
            await page.evaluate((el) => {
              const toolbar = el.closest('header, .toolbar, .mat-toolbar, .mdc-toolbar, .head, .panel, .top') || document.body;
              const candidates = toolbar.querySelectorAll('button, a, [role="button"]');
              for (const c of candidates) {
                const text = (c.innerText || c.textContent || '').trim();
                if (/^ส่งออก$|^Export$|ดาวน์โหลด|Download/i.test(text)) { c.click(); return; }
              }
            }, h);
          });
          if (saved) return true;
          const ok = await maybeHandleExportDialog(page);
          if (ok) return true;
        }
      } catch {}
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
    if (!ok) throw new Error('ยังไม่พบการดาวน์โหลดหลังคลิก "ส่งออก" — ตรวจสิทธิ์บัญชี/หน้าที่รองรับ และลองอีกครั้ง');
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
