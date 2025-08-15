// export.js (v13) — Items-first + strong toolbar wait/sweep + click-by-text-anywhere + CSV choice + CSV validation
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUTDIR = 'out';
const CSV_FILENAME = 'inventory.csv';
const BEFORE = 'before_click.png';
const AFTER  = 'after_click.png';
const SCREENSHOT = 'error.png';

const DEFAULT_URLS = [
  'https://r.loyverse.com/dashboard/#/goods/items',
  'https://r.loyverse.com/dashboard/#/inventory_by_items',
  'https://r.loyverse.com/dashboard/#/goods/price?page=0&limit=10&inventory=all',
];
const URLS_TO_TRY = (process.env.LOYVERSE_EXPORT_PAGES
  ? process.env.LOYVERSE_EXPORT_PAGES.split(',').map(s => s.trim()).filter(Boolean)
  : DEFAULT_URLS);

const DL_TIMEOUT = 120000;
const NAV_TIMEOUT = 90000;

function ensureOutDir(){ if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR, { recursive: true }); }
function log(...a){ console.log('[log]', ...a); }

function looksLikeCSV(txt){
  if (!txt || typeof txt !== 'string') return false;
  const t = txt.slice(0, 2000).toLowerCase();
  if (t.includes('<html') || t.includes('<svg') || t.includes('<body')) return false;
  const lines = txt.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return false;
  const sep = [',',';','\t'].find(s => (lines[0].split(s).length + lines[1].split(s).length) > 3);
  return !!sep;
}

async function makeContext(browser, storageState){
  const ctx = await browser.newContext({ storageState, acceptDownloads: true });
  // capture client-side download mechanisms
  await ctx.addInitScript(() => {
    try {
      window.__dl = { blobs:{}, hrefs:[], opens:[], locs:[] };
      const origCreate = URL.createObjectURL;
      URL.createObjectURL = function(blob){ const u = origCreate.call(URL, blob); try { window.__dl.blobs[u] = blob; } catch{} return u; };
      const origClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function(){ try { window.__dl.hrefs.push(this.href || ''); } catch{}; return origClick.call(this); };
      const origSetAttr = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function(k,v){ try { if (this.tagName==='A' && k.toLowerCase()==='href') window.__dl.hrefs.push(String(v||'')); } catch{}; return origSetAttr.call(this,k,v); };
      const origOpen = window.open;
      window.open = function(u,...r){ try { window.__dl.opens.push(String(u||'')); } catch{}; return origOpen ? origOpen.call(window,u,...r) : null; };
      const origAssign = window.location.assign;
      window.location.assign = function(u){ try { window.__dl.locs.push(String(u||'')); } catch{}; return origAssign.call(window.location,u); };
      const hrefDesc = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
      if (hrefDesc && hrefDesc.set){
        Object.defineProperty(window.location, 'href', {
          set(u){ try { window.__dl.locs.push(String(u||'')); } catch{}; return hrefDesc.set.call(window.location,u); },
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

async function waitToolbar(page){
  const deadline = Date.now() + 20000; // 20s
  const probes = [
    'button:has-text("ส่งออก")',
    'button:has-text("นำเข้า")',
    'button:has-text("เพิ่มเติม")',
    'button[aria-haspopup="menu"]',
    '[role="button"]:has-text("ส่งออก")',
    'text=/^\\+\\s*เพิ่มสินค้า$/',
  ];
  while (Date.now() < deadline){
    for (const p of probes){
      try {
        const loc = p.startsWith('text=') ? page.getByText(/^\+\s*เพิ่มสินค้า$/).first()
                                          : page.locator(p).first();
        if (await loc.count()) return true;
      } catch {}
    }
    await page.waitForTimeout(300);
  }
  return false;
}

async function waiters(page){
  const downloadP = page.context().waitForEvent('download', { timeout: DL_TIMEOUT }).catch(() => null);
  const popupP    = page.waitForEvent('popup', { timeout: 5000 }).catch(() => null);
  const responseP = page.waitForResponse(r => {
    const ct = (r.headers()['content-type'] || '').toLowerCase();
    const cd = (r.headers()['content-disposition'] || '').toLowerCase();
    const url = r.url();
    return /text\/csv|application\/octet-stream|excel|spreadsheet/.test(ct) || /attachment/.test(cd) || /export|download|csv|xlsx?/i.test(url);
  }, { timeout: DL_TIMEOUT }).catch(() => null);
  return { downloadP, popupP, responseP };
}

async function saveFrom(download, popup, response){
  const dst = path.join(OUTDIR, CSV_FILENAME);
  if (download){ await download.saveAs(dst); const txt = fs.readFileSync(dst,'utf8'); if (looksLikeCSV(txt)) return true; fs.unlinkSync(dst); }
  if (popup){
    try {
      await popup.waitForLoadState('domcontentloaded',{timeout:8000});
      const resp = await popup.waitForResponse(r => {
        const ct=(r.headers()['content-type']||'').toLowerCase();
        const cd=(r.headers()['content-disposition']||'').toLowerCase();
        return /text\/csv|application\/octet-stream|excel|spreadsheet/.test(ct) || /attachment/.test(cd);
      },{timeout:8000}).catch(()=>null);
      if (resp){ const body=await resp.body(); fs.writeFileSync(dst,body); const txt=fs.readFileSync(dst,'utf8'); if (looksLikeCSV(txt)) return true; fs.unlinkSync(dst); }
    } catch {}
  }
  if (response){
    try { const body=await response.body(); fs.writeFileSync(dst,body); const txt=fs.readFileSync(dst,'utf8'); if (looksLikeCSV(txt)) return true; fs.unlinkSync(dst); } catch {}
  }
  return false;
}

async function tryDumpClientSide(page){
  const end = Date.now() + 12000;
  while (Date.now() < end){
    const got = await page.evaluate(async () => {
      const out = { ok:false, csv:null, info:null };
      try {
        const collectText = async (u) => {
          if (!u) return null;
          if (u.startsWith('data:')){
            const i = u.indexOf(',');
            if (i>-1){ try { return atob(u.slice(i+1)); } catch { return null; } }
          }
          const res = await fetch(u);
          return await res.text();
        };
        const e = window.__dl || { blobs:{}, hrefs:[], opens:[], locs:[] };
        const blobUrls = Object.keys(e.blobs || {});
        if (blobUrls.length){
          const last = blobUrls[blobUrls.length-1];
          const txt = await e.blobs[last].text().catch(()=>null);
          if (txt){ return { ok:true, csv:txt, info:{via:'blob', url:last} }; }
        }
        const cand = [].concat(e.hrefs||[], e.opens||[], e.locs||[]).reverse();
        for (const u of cand){
          const txt = await collectText(u);
          if (txt){ return { ok:true, csv:txt, info:{via:'url', url:u} }; }
        }
      } catch (err){ return { ok:false, info:{err:String(err)} }; }
      return out;
    });
    if (got && got.ok && looksLikeCSV(got.csv)){
      fs.writeFileSync(path.join(OUTDIR, CSV_FILENAME), got.csv, 'utf8');
      log('client-side capture:', JSON.stringify(got.info));
      return true;
    }
    await page.waitForTimeout(300);
  }
  return false;
}

async function clickCsvChoice(page){
  const choices = [/ไฟล์?\s*CSV/i, /CSV/i, /Excel/i, /XLSX?/i, /สเปรดชีต/i];
  for (const re of choices){
    const el = page.getByText(re).first();
    if (await el.count()){
      try { log('click CSV/Excel option:', re.toString()); await el.click(); await page.waitForTimeout(300); return true; } catch {}
    }
  }
  const aCSV = page.locator('a[download]:has-text("CSV"), a[download]:has-text("csv")').first();
  if (await aCSV.count()){ try { log('click <a download> CSV'); await aCSV.click(); return true; } catch {} }
  return false;
}

async function collectAfterClick(page, doClick){
  const w = await waiters(page);
  await page.screenshot({ path: path.join(OUTDIR, BEFORE), fullPage: true }).catch(()=>{});
  await doClick();
  await page.waitForTimeout(400);
  await clickCsvChoice(page);
  await page.screenshot({ path: path.join(OUTDIR, AFTER), fullPage: true }).catch(()=>{});
  if (await saveFrom(await w.downloadP, await w.popupP, await w.responseP)) return true;
  if (await tryDumpClientSide(page)) return true;
  return false;
}

async function clickExportAnywhere(page){
  log('try: direct Export button');
  const direct = page.locator('button:has-text("ส่งออก"), [role="button"]:has-text("ส่งออก")').first();
  if (await direct.count()){
    const ok = await collectAfterClick(page, async () => { await direct.click(); });
    if (ok) return true;
  }

  log('try: click text "ส่งออก" and bubble to clickable ancestor');
  const ok2 = await collectAfterClick(page, async () => {
    await page.evaluate(() => {
      function findNodesByText(regex){
        const all = Array.from(document.querySelectorAll('body *'));
        return all.filter(n => regex.test((n.innerText || n.textContent || '').trim()));
      }
      function clickable(el){
        if (!el) return null;
        const tag = el.tagName;
        const role = el.getAttribute && (el.getAttribute('role') || '');
        if (tag === 'BUTTON' || tag === 'A' || role === 'button') return el;
        if (el.tabIndex >= 0) return el;
        return null;
      }
      const targets = findNodesByText(/ส่งออก|Export/i);
      for (const t of targets){
        let el = t;
        for (let i=0; i<6 && el; i++){
          const c = clickable(el);
          if (c){ c.click(); return true; }
          el = el.parentElement;
        }
      }
      return false;
    });
  });
  if (ok2) return true;

  log('try: open toolbar menus (more/actions/...) then click "ส่งออก"');
  const menus = [
    'button[aria-haspopup="menu"]',
    'button:has([data-icon="more"])',
    'button:has-text("เพิ่มเติม")',
    'button:has-text("More")',
    'button:has-text("Actions")',
  ];
  for (const m of menus){
    const btn = page.locator(m).first();
    if (await btn.count()){
      const ok = await collectAfterClick(page, async () => {
        await btn.click();
        await page.waitForTimeout(250);
        const it = page.getByText(/ส่งออก|Export/i).first();
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
    await page.waitForTimeout(1500);
    await dismissOverlays(page);
    await page.evaluate(() => window.scrollTo(0, 0));

    const ready = await waitToolbar(page);
    log('toolbar ready?', ready);
    if (!ready) continue;

    const ok = await clickExportAnywhere(page);
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
    if (!ok) throw new Error('ยังไม่พบไฟล์ CSV หลังพยายามคลิก "ส่งออก" + เลือก CSV');
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
