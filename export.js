// export.js (v10) — Items-first + toolbar menu sweep + deep capture
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUTDIR = 'out';
const CSV_FILENAME = 'inventory.csv';
const BEFORE = 'before_click.png';
const AFTER  = 'after_click.png';
const SCREENSHOT = 'error.png';

// เริ่มจากหน้า Items ก่อน (ครบคอลัมน์/ครบสินค้า) แล้วค่อย fallback หน้าอื่น
const DEFAULT_URLS = [
  'https://r.loyverse.com/dashboard/#/goods/items',
  'https://r.loyverse.com/dashboard/#/inventory_by_items',
  'https://r.loyverse.com/dashboard/#/goods/price?page=0&limit=10&inventory=all',
  'https://r.loyverse.com/dashboard/#/inventory',
];
// สามารถ override ได้ผ่าน ENV: LOYVERSE_EXPORT_PAGES="url1,url2,..."
const URLS_TO_TRY = (process.env.LOYVERSE_EXPORT_PAGES
  ? process.env.LOYVERSE_EXPORT_PAGES.split(',').map(s => s.trim()).filter(Boolean)
  : DEFAULT_URLS);

const DL_TIMEOUT = 120000;
const NAV_TIMEOUT = 90000;

function ensureOutDir(){ if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR, { recursive: true }); }
function log(...a){ console.log('[log]', ...a); }

async function makeContext(browser, storageState){
  const ctx = await browser.newContext({ storageState, acceptDownloads: true });

  // Hook กลไกดาวน์โหลดฝั่งหน้าเว็บ (Blob/objectURL, anchor, window.open, location.*)
  await ctx.addInitScript(() => {
    try {
      window.__dl = { blobs:{}, hrefs:[], opens:[], locs:[] };

      const origCreate = URL.createObjectURL;
      URL.createObjectURL = function(blob){
        const u = origCreate.call(URL, blob);
        try { window.__dl.blobs[u] = blob; } catch {}
        return u;
      };

      const origClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function(){
        try { window.__dl.hrefs.push(this.href || ''); } catch {}
        return origClick.call(this);
      };

      const origSetAttr = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function(k,v){
        try {
          if (this.tagName === 'A' && k.toLowerCase()==='href') window.__dl.hrefs.push(String(v||''));
        } catch {}
        return origSetAttr.call(this, k, v);
      };

      const origOpen = window.open;
      window.open = function(u, ...rest){
        try { window.__dl.opens.push(String(u||'')); } catch {}
        return origOpen ? origOpen.call(window, u, ...rest) : null;
      };

      const origAssign = window.location.assign;
      window.location.assign = function(u){
        try { window.__dl.locs.push(String(u||'')); } catch {}
        return origAssign.call(window.location, u);
      };
      const hrefDesc = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
      if (hrefDesc && hrefDesc.set){
        Object.defineProperty(window.location, 'href', {
          set(u){ try { window.__dl.locs.push(String(u||'')); } catch {}; return hrefDesc.set.call(window.location, u); },
          get(){ return hrefDesc.get.call(window.location); }
        });
      }
    } catch {}
  });
  return ctx;
}

async function newContextWithStorage(browser){
  const b64 = process.env.LOYVERSE_STORAGE_B64;
  if (b64){
    try {
      const jsonText = Buffer.from(b64, 'base64').toString('utf-8');
      const storageState = JSON.parse(jsonText);
      log('use LOYVERSE_STORAGE_B64');
      return await makeContext(browser, storageState);
    } catch(e){ console.error('[storage] LOYVERSE_STORAGE_B64 parse error:', e.message); }
  }
  const fsPath = path.join(OUTDIR, 'storage.json');
  if (fs.existsSync(fsPath)){
    try {
      const storageState = JSON.parse(fs.readFileSync(fsPath, 'utf-8'));
      log('use out/storage.json');
      return await makeContext(browser, storageState);
    } catch(e){ console.error('[storage] out/storage.json parse error:', e.message); }
  }
  throw new Error('Missing login credentials. Provide LOYVERSE_STORAGE_B64 or out/storage.json');
}

async function dismissOverlays(page){
  const sels = [
    'button:has-text("Accept")','button:has-text("I agree")',
    'button:has-text("ตกลง")','button:has-text("ยอมรับ")',
    'button[aria-label*="Close" i]','.cdk-overlay-backdrop'
  ];
  for (const s of sels){
    const el = page.locator(s).first();
    if (await el.count()){ try { await el.click({ timeout:300 }); } catch{} }
  }
  try { await page.keyboard.press('Escape'); } catch {}
}

async function waiters(page){
  const downloadP = page.context().waitForEvent('download', { timeout: DL_TIMEOUT }).catch(() => null);
  const popupP    = page.waitForEvent('popup', { timeout: 5000 }).catch(() => null);
  const responseP = page.waitForResponse(r => {
    const ct = (r.headers()['content-type'] || '').toLowerCase();
    const cd = (r.headers()['content-disposition'] || '').toLowerCase();
    const url = r.url();
    return /text\/csv|application\/octet-stream|excel/.test(ct) || /attachment/.test(cd) || /export|download|csv/i.test(url);
  }, { timeout: DL_TIMEOUT }).catch(() => null);
  return { downloadP, popupP, responseP };
}

async function saveFrom(download, popup, response){
  const dst = path.join(OUTDIR, CSV_FILENAME);
  if (download){ await download.saveAs(dst); return true; }
  if (popup){
    try {
      await popup.waitForLoadState('domcontentloaded', { timeout: 8000 });
      const resp = await popup.waitForResponse(r => {
        const ct = (r.headers()['content-type'] || '').toLowerCase();
        const cd = (r.headers()['content-disposition'] || '').toLowerCase();
        return /text\/csv|application\/octet-stream|excel/.test(ct) || /attachment/.test(cd);
      }, { timeout: 8000 }).catch(() => null);
      if (resp){ const body = await resp.body(); fs.writeFileSync(dst, body); return true; }
    } catch {}
  }
  if (response){
    try { const body = await response.body(); fs.writeFileSync(dst, body); return true; }
    catch {}
  }
  return false;
}

async function tryDumpClientSide(page){
  const end = Date.now() + 8000;
  while (Date.now() < end){
    const got = await page.evaluate(async () => {
      const out = { ok:false, csv:null, info:null };
      try {
        const collectText = async (u) => {
          if (!u) return null;
          if (u.startsWith('data:')){
            const i = u.indexOf(',');
            if (i > -1){ try { return atob(u.slice(i+1)); } catch { return null; } }
          }
          const res = await fetch(u); return await res.text();
        };
        const e = window.__dl || { blobs:{}, hrefs:[], opens:[], locs:[] };
        const blobUrls = Object.keys(e.blobs || {});
        if (blobUrls.length){
          const last = blobUrls[blobUrls.length-1];
          const txt = await e.blobs[last].text().catch(() => null);
          if (txt){ out.ok = true; out.csv = txt; out.info = { via:'blob', url:last }; return out; }
        }
        const cand = [].concat(e.hrefs||[], e.opens||[], e.locs||[]).reverse();
        for (const u of cand){
          const txt = await collectText(u);
          if (txt && (txt.includes(',') || txt.includes('\n'))){
            out.ok = true; out.csv = txt; out.info = { via:'url', url:u }; return out;
          }
        }
      } catch (err){ out.info = { err:String(err) }; }
      return out;
    });
    if (got && got.ok && got.csv){
      fs.writeFileSync(path.join(OUTDIR, CSV_FILENAME), got.csv, 'utf8');
      log('client-side capture:', JSON.stringify(got.info));
      return true;
    }
    await page.waitForTimeout(300);
  }
  return false;
}

async function clickOnceAndCollect(page, clickFn){
  const w = await waiters(page);
  await page.screenshot({ path: path.join(OUTDIR, BEFORE), fullPage: true }).catch(() => {});
  await clickFn();
  await page.screenshot({ path: path.join(OUTDIR, AFTER), fullPage: true }).catch(() => {});
  if (await saveFrom(await w.downloadP, await w.popupP, await w.responseP)) return true;
  if (await tryDumpClientSide(page)) return true;
  return false;
}

// ไล่คลิกปุ่ม/เมนูบน toolbar เพื่อหา "ส่งออก"
async function toolbarExportSweep(page){
  await page.evaluate(() => window.scrollTo(0,0));

  // 1) ปุ่ม "ส่งออก" ตรง ๆ
  const direct = page.locator('button:has-text("ส่งออก"), [role="button"]:has-text("ส่งออก")').first();
  if (await direct.count()){
    log('click direct "ส่งออก"');
    const ok = await clickOnceAndCollect(page, async () => { await direct.click(); });
    if (ok) return true;
  }

  // 2) หา toolbar จาก "+ เพิ่มสินค้า" แล้ววนกดปุ่มทีละอันเพื่อหาเมนู "ส่งออก"
  const addBtn = page.getByText(/^\+\s*เพิ่มสินค้า$/).first();
  if (await addBtn.count()){
    log('toolbar detected near "+ เพิ่มสินค้า" -> sweeping buttons');
    // ติดตั้ง waiters แล้วค่อยคลิกใน evaluate
    await clickOnceAndCollect(page, async () => {});
    const found = await page.evaluate(async () => {
      function getToolbar(el){
        return (el.closest('header, .toolbar, .mat-toolbar, .mdc-toolbar, .head, .panel, .top, .title-bar')
                || document.querySelector('header, .toolbar, .mat-toolbar, .mdc-toolbar, .head, .panel, .top, .title-bar')
                || document.body);
      }
      const add = Array.from(document.querySelectorAll('*')).find(x => /\+\s*เพิ่มสินค้า/.test(x.textContent||''));
      const tb = add ? getToolbar(add) : getToolbar(document.body);
      const btns = Array.from(tb.querySelectorAll('button, [role="button"]'));

      function visible(el){
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width>0 && r.height>0 && s.visibility!=='hidden' && s.display!=='none';
      }

      for (const b of btns){
        try {
          if (!visible(b)) continue;
          b.click();
          await new Promise(r => setTimeout(r, 300));
          const menuItem = Array.from(document.querySelectorAll('*')).find(x => {
            const t=(x.innerText||x.textContent||'').trim();
            return /^(ส่งออก|Export)$/i.test(t);
          });
          if (menuItem){ menuItem.click(); return true; }
          // ปิดเมนู ถ้ายังไม่ใช่
          document.activeElement && document.activeElement.blur && document.activeElement.blur();
          const esc = new KeyboardEvent('keydown', {key:'Escape'});
          document.dispatchEvent(esc);
          await new Promise(r => setTimeout(r, 100));
        } catch {}
      }
      return false;
    });
    if (found){
      log('menu "ส่งออก" clicked from toolbar sweep');
      const ok2 = await tryDumpClientSide(page);
      if (ok2) return true;
    }
  }

  // 3) เมนูทั่วไป (เพิ่มเติม / More / Actions / ไอคอน 3 จุด)
  const menus = [
    'button:has-text("เพิ่มเติม")','button:has-text("More")','button:has-text("Actions")',
    'button[aria-label*="More" i]','[data-testid="kebab-menu"]','button:has([data-icon="more"])',
    'button[aria-haspopup="menu"]'
  ];
  for (const m of menus){
    const btn = page.locator(m).first();
    if (await btn.count()){
      log('open menu candidate:', m);
      const ok = await clickOnceAndCollect(page, async () => {
        await btn.click();
        await page.waitForTimeout(200);
        const it = page.getByText(/^(ส่งออก|Export)$/).first();
        if (await it.count()) await it.click();
      });
      if (ok) return true;
    }
  }
  return false;
}

async function navigateAndExport(page){
  for (const url of URLS_TO_TRY){
    log('goto', url);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT });
    await page.waitForTimeout(1200);
    await dismissOverlays(page);

    const ok = await toolbarExportSweep(page);
    if (ok) return true;
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
    if (!ok) throw new Error('ยังไม่พบไฟล์ CSV หลังพยายามคลิก "ส่งออก" บนหน้า Items/ฯลฯ');
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
