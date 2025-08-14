// export.js (v8-fix) — ultimate fallback: capture Blob/objectURL downloads
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUTDIR = 'out';
const CSV_FILENAME = 'inventory.csv';
const SCREENSHOT = 'error.png';
const BEFORE = 'before_click.png';
const AFTER  = 'after_click.png';

const URLS_TO_TRY = [
  'https://r.loyverse.com/dashboard/#/goods/price?page=0&limit=10&inventory=all',
  'https://r.loyverse.com/dashboard/#/goods/items',
  'https://r.loyverse.com/dashboard/#/inventory_by_items',
  'https://r.loyverse.com/dashboard/#/inventory',
];

const DL_TIMEOUT = 120000;
const NAV_TIMEOUT = 90000;

function ensureOutDir() {
  if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR, { recursive: true });
}
function log(...args){ console.log('[log]', ...args); }

async function newContextWithStorage(browser) {
  const b64 = process.env.LOYVERSE_STORAGE_B64;
  if (b64) {
    try {
      const jsonText = Buffer.from(b64, 'base64').toString('utf-8');
      const storageState = JSON.parse(jsonText);
      log('use LOYVERSE_STORAGE_B64');
      const ctx = await browser.newContext({ storageState, acceptDownloads: true });
      await ctx.addInitScript(() => {
        // Hook objectURL to capture Blobs used for download
        window.__dl = { blobs: {}, hrefs: [] };
        const orig = URL.createObjectURL;
        URL.createObjectURL = function(blob){
          const url = orig.call(this, blob);
          try { window.__dl.blobs[url] = blob; } catch {}
          return url;
        };
        const origLink = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function(){
          try { if (this.download && this.href) window.__dl.hrefs.push(this.href); } catch {}
          return origLink.call(this);
        };
      });
      return ctx;
    } catch (e) {
      console.error('[storage] LOYVERSE_STORAGE_B64 parse error:', e.message);
    }
  }
  const storagePath = path.join(OUTDIR, 'storage.json');
  if (fs.existsSync(storagePath)) {
    try {
      const storageState = JSON.parse(fs.readFileSync(storagePath, 'utf-8'));
      log('use out/storage.json');
      const ctx = await browser.newContext({ storageState, acceptDownloads: true });
      await ctx.addInitScript(() => {
        window.__dl = { blobs: {}, hrefs: [] };
        const orig = URL.createObjectURL;
        URL.createObjectURL = function(blob){
          const url = orig.call(this, blob);
          try { window.__dl.blobs[url] = blob; } catch {}
          return url;
        };
        const origLink = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function(){
          try { if (this.download && this.href) window.__dl.hrefs.push(this.href); } catch {}
          return origLink.call(this);
        };
      });
      return ctx;
    } catch (e) {
      console.error('[storage] out/storage.json parse error:', e.message);
    }
  }
  throw new Error('Missing login credentials. Provide LOYVERSE_STORAGE_B64 or out/storage.json');
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
    if (await el.count()) { try { await el.click({ timeout: 300 }); } catch {} }
  }
  try { await page.keyboard.press('Escape'); } catch {}
}

function namesRe() { return /Export|ส่งออก|Download|ดาวน์โหลด|นำออก|CSV|Excel|ไฟล์/i; }

function exportTargets(page) {
  const re = namesRe();
  return [
    page.getByRole('button', { name: re }).first(),
    page.locator('button:has-text("ส่งออก")').first(),
    page.getByText(re, { exact: false }).first(),
    page.locator('[role="button"]').filter({ hasText: re }).first(),
  ];
}

async function prepareFileWaiters(page) {
  const downloadP = page.context().waitForEvent('download', { timeout: DL_TIMEOUT }).catch(() => null);
  const popupP    = page.waitForEvent('popup', { timeout: 3000 }).catch(() => null);
  const responseP = page.waitForResponse(r => {
    const ct = (r.headers()['content-type'] || '').toLowerCase();
    const cd = (r.headers()['content-disposition'] || '').toLowerCase();
    const url = r.url();
    return /text\/csv|application\/octet-stream/.test(ct) || /attachment/.test(cd) || /export|download|csv/i.test(url);
  }, { timeout: DL_TIMEOUT }).catch(() => null);
  return { downloadP, popupP, responseP };
}

async function saveFrom(download, popup, response) {
  const dst = path.join(OUTDIR, CSV_FILENAME);
  if (download) { await download.saveAs(dst); return true; }
  if (popup) {
    try {
      await popup.waitForLoadState('domcontentloaded', { timeout: 8000 });
      const resp = await popup.waitForResponse(r => {
        const ct = (r.headers()['content-type'] || '').toLowerCase();
        const cd = (r.headers()['content-disposition'] || '').toLowerCase();
        return /text\/csv|application\/octet-stream/.test(ct) || /attachment/.test(cd);
      }, { timeout: 8000 }).catch(() => null);
      if (resp) { const body = await resp.body(); fs.writeFileSync(dst, body); return true; }
    } catch {}
  }
  if (response) { const body = await response.body(); fs.writeFileSync(dst, body); return true; }
  return false;
}

async function tryGrabBlobHref(page) {
  const info = await page.evaluate(async () => {
    const entry = { hrefs: (window.__dl && window.__dl.hrefs) || [], blobCount: window.__dl ? Object.keys(window.__dl.blobs).length : 0, last: null };
    if (window.__dl && Object.keys(window.__dl.blobs).length) {
      const urls = Object.keys(window.__dl.blobs);
      const lastUrl = urls[urls.length - 1];
      const blob = window.__dl.blobs[lastUrl];
      const text = await blob.text().catch(() => null);
      entry.last = { url: lastUrl, text };
    }
    return entry;
  });
  if (info.last && info.last.text) {
    fs.writeFileSync(path.join(OUTDIR, CSV_FILENAME), info.last.text, 'utf8');
    return true;
  }
  if (info.hrefs && info.hrefs.length) {
    const href = info.hrefs[info.hrefs.length - 1];
    const content = await page.evaluate(async (h) => {
      try {
        if (h.startsWith('data:')) {
          const b64 = h.split(',')[1];
          return Buffer.from(b64, 'base64').toString('utf-8');
        }
        const res = await fetch(h);
        const txt = await res.text();
        return txt;
      } catch (e) { return null; }
    }, href);
    if (content) {
      fs.writeFileSync(path.join(OUTDIR, CSV_FILENAME), content, 'utf8');
      return true;
    }
  }
  return false;
}

async function clickAndCollect(page, clickFn) {
  const waiters = await prepareFileWaiters(page);
  await page.screenshot({ path: path.join(OUTDIR, BEFORE), fullPage: true }).catch(() => {});
  await clickFn();
  await page.screenshot({ path: path.join(OUTDIR, AFTER), fullPage: true }).catch(() => {});
  if (await saveFrom(await waiters.downloadP, await waiters.popupP, await waiters.responseP)) return true;
  return await tryGrabBlobHref(page);
}

async function navigateAndExport(page) {
  for (const url of URLS_TO_TRY) {
    log('goto', url);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT });
    await page.waitForTimeout(1200);
    await dismissOverlays(page);
    await page.evaluate(() => window.scrollTo(0, 0));

    for (const t of exportTargets(page)) {
      if (await t.count()) {
        log('click candidate');
        const ok = await clickAndCollect(page, async () => { await t.click(); });
        if (ok) return true;
      }
    }

    const addBtn = page.getByText(/^\+\s*เพิ่มสินค้า$/).first();
    if (await addBtn.count()) {
      log('toolbar heuristic');
      const ok = await clickAndCollect(page, async () => {
        const h = await addBtn.elementHandle();
        await page.evaluate((el) => {
          const tb = el.closest('header, .toolbar, .mat-toolbar, .mdc-toolbar, .head, .panel, .top, .title-bar') || document.body;
          const nodes = tb.querySelectorAll('button, a, [role="button"]');
          for (const n of nodes) {
            const t = (n.innerText || n.textContent || '').trim();
            if (/^ส่งออก$|Export|ดาวน์โหลด|Download/i.test(t)) { n.click(); return; }
          }
        }, h);
      });
      if (ok) return true;
    }

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
        log('open menu', m);
        const ok = await clickAndCollect(page, async () => {
          await btn.click();
          await page.waitForTimeout(200);
          const it = page.getByText(namesRe()).first();
          if (await it.count()) await it.click();
        });
        if (ok) return true;
      }
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
    if (!ok) throw new Error('ยังไม่พบไฟล์ CSV หลังคลิก "ส่งออก" — อาจเป็น UI ที่สร้างไฟล์ฝั่งหน้าเว็บโดยไม่มี network ตรง');
    console.log('[ok] Downloaded:', path.join(OUTDIR, CSV_FILENAME));
  } catch (err) {
    console.error('[error]', err.message);
    try {
      const pg = await context.newPage();
      await pg.goto(URLS_TO_TRY[0], { waitUntil: 'domcontentloaded' }).catch(() => {});
      await pg.screenshot({ path: path.join(OUTDIR, SCREENSHOT), fullPage: true }).catch(() => {});
      await pg.close();
      console.error('[error] saved screenshot to out/error.png');
    } catch {}
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
