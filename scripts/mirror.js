// Usage: node scripts/mirror.js <start-url> [outDir]
// Loads the URL in headless Chromium, saves every resource it requests
// (scripts, CSS, fonts, images, XHR/fetch...) under <outDir>/_ext/<host>/<path>,
// rewrites absolute URLs inside text files to the local copies, and writes
// <outDir>/index.html pointing at the saved start document.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const START = process.argv[2];
const OUT = process.argv[3] || 'site';
const BASE = (process.env.BASE_PATH || '').replace(/\/$/, ''); // e.g. "/my-repo" for project Pages, "" for custom domain/user site
const SETTLE_MS = Number(process.env.SETTLE_MS || 8000);

if (!START) { console.error('usage: node scripts/mirror.js <url> [outDir]'); process.exit(1); }

const EXT = {
  'text/html': '.html', 'text/css': '.css', 'application/javascript': '.js', 'text/javascript': '.js',
  'application/x-javascript': '.js', 'application/json': '.json', 'image/svg+xml': '.svg',
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/x-icon': '.ico', 'image/vnd.microsoft.icon': '.ico', 'font/woff2': '.woff2',
  'font/woff': '.woff', 'font/ttf': '.ttf', 'application/wasm': '.wasm', 'audio/mpeg': '.mp3',
  'video/mp4': '.mp4', 'application/font-woff2': '.woff2', 'application/font-woff': '.woff',
};
const TEXT = /^(text\/|application\/(javascript|x-javascript|json)|image\/svg)/;

function localPathFor(url, contentType) {
  const u = new URL(url);
  let p = decodeURIComponent(u.pathname);
  if (p.endsWith('/')) p += 'index';
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  let ext = path.extname(p);
  if (!ext && EXT[ct]) { p += EXT[ct]; ext = EXT[ct]; }
  if (u.search) {
    const h = crypto.createHash('md5').update(u.search).digest('hex').slice(0, 8);
    p = p.slice(0, p.length - ext.length) + '.' + h + ext;
  }
  p = p.replace(/[:*?"<>|\\]/g, '_');
  return `_ext/${u.host.replace(":", "_")}${p}`;
}

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox'],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  const saved = new Map(); // url -> { rel, type, body }
  const pending = [];
  page.on('response', (res) => {
    pending.push((async () => {
      try {
        const url = res.url();
        if (!/^https?:/.test(url) || res.request().method() !== 'GET') return;
        if (res.status() < 200 || res.status() >= 300 || saved.has(url)) return;
        const type = res.headers()['content-type'] || '';
        const body = await res.body();
        saved.set(url, { rel: localPathFor(url, type), type, body });
      } catch { /* redirects / aborted requests have no body */ }
    })());
  });

  await page.goto(START, { waitUntil: 'networkidle', timeout: 60000 }).catch((e) => console.warn('goto:', e.message));
  // nudge lazy loaders
  await page.evaluate(async () => {
    for (let y = 0; y < document.body?.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 100)); }
    window.scrollTo(0, 0);
  }).catch(() => {});
  await page.waitForTimeout(SETTLE_MS);
  await Promise.all(pending);
  await browser.close();

  if (!saved.has(START)) {
    // start URL may have redirected; take the first saved document as entry
    console.warn('Start URL response not captured directly.');
  }

  // build rewrite table (longest URLs first); handle https://, http:// and protocol-relative forms
  const entries = [...saved.entries()].sort((a, b) => b[0].length - a[0].length);
  const rewrite = (text) => {
    for (const [url, { rel }] of entries) {
      const local = `${BASE}/${rel}`;
      text = text.split(url).join(local);
      text = text.split(url.replace(/^https?:/, '')).join(local);
    }
    return text;
  };

  for (const [url, { rel, type, body }] of saved) {
    const dest = path.join(OUT, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const isText = TEXT.test(type.split(';')[0].trim().toLowerCase()) || /\.(svg|css|js|html|json)$/.test(rel);
    fs.writeFileSync(dest, isText ? rewrite(body.toString('utf8')) : body);
  }

  const entry = saved.get(START);
  const entryRel = entry ? entry.rel : [...saved.values()][0]?.rel;
  if (!entryRel) { console.error('Nothing was captured.'); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'index.html'),
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Redirecting…</title>` +
    `<meta http-equiv="refresh" content="0; url=./${entryRel}"></head>` +
    `<body><a href="./${entryRel}">Continue</a></body></html>`);

  console.log(`Saved ${saved.size} files to ${OUT}/ (entry: ${entryRel})`);
  for (const { rel } of saved.values()) console.log('  ' + rel);
})();
