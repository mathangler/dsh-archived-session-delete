/**
 * Plugin display-metadata check — real browser, needs a running Harness.
 *
 * Plugin Manager and Settings read a bundle's title and description from its
 * EXPORTED locale JSON without activating the plugin, so installation alone does
 * not establish what a person sees. This drives the page: open Settings, go to
 * the Plugins page, and report the metadata rows for one package plus the active
 * UI language, which is what decides WHICH locale file the Host's
 * language -> text map resolves to.
 *
 * Read-only. Launches its own throwaway Chrome profile and kills only that
 * process, so a browser the user already has open is untouched.
 *
 * Usage:
 *   node tools/metadata-check.mjs <url> <chrome> [package-name]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2];
const chromePath = process.argv[3];
const target = process.argv[4] || 'dsh-archived-session-delete';
// Optional browser language (e.g. "en-US"). The check runs in a THROWAWAY
// Chrome profile, so forcing the browser language exercises a different UI
// locale without changing the user's own language setting.
const browserLang = process.argv[5] || '';

const port = 9357;
const profile = mkdtempSync(join(tmpdir(), 'asdel-meta-'));

const chromeArgs = [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
];
if (browserLang !== '') chromeArgs.push(`--lang=${browserLang}`, `--accept-lang=${browserLang}`);

const chrome = spawn(chromePath, chromeArgs, { stdio: 'ignore' });

let failures = 0;
function check(label, ok, detail) {
  if (ok) { console.log('  ok   ' + label); return; }
  failures += 1;
  console.log('  FAIL ' + label + (detail === undefined ? '' : ' — ' + detail));
}

async function waitForDevtools(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return await r.json();
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('devtools never became ready');
}

const version = await waitForDevtools(20000);
const ws = await new Promise((resolve, reject) => {
  const s = new WebSocket(version.webSocketDebuggerUrl);
  s.addEventListener('open', () => resolve(s), { once: true });
  s.addEventListener('error', () => reject(new Error('ws error')), { once: true });
});
let nextId = 1;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
});
const send = (method, params, sessionId) => {
  const id = nextId++;
  const p = { id, method, params: params ?? {} };
  if (sessionId !== undefined) p.sessionId = sessionId;
  ws.send(JSON.stringify(p));
  return new Promise((r) => pending.set(id, r));
};

const created = await send('Target.createTarget', { url: 'about:blank' });
const attached = await send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
const session = attached.sessionId;
await send('Runtime.enable', {}, session);
await send('Page.enable', {}, session);
// Override the page locale BEFORE navigation. DSH keeps its language
// preference in the Host settings document, so when no explicit preference is
// stored it auto-detects; overriding the page locale exercises that path
// without touching the user's saved preference. (--lang alone does not change
// navigator.language in headless Chrome.)
if (browserLang !== '') {
  await send('Emulation.setLocaleOverride', { locale: browserLang }, session);
}
await send('Page.navigate', { url }, session);
await new Promise((r) => setTimeout(r, 13000));

async function evaluate(expression) {
  const reply = await send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  }, session);
  if (reply && reply.exceptionDetails) {
    throw new Error('page threw: ' + String(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text));
  }
  return reply && reply.result ? reply.result.value : undefined;
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('plugin display metadata\n');

// Open Settings: 0.2 moved it inside the account menu; older builds expose a
// direct control. Try direct first, then the menu.
const opened = await evaluate(`(async () => {
  const byAria = (re) => [...document.querySelectorAll('button')]
    .find((b) => re.test(b.getAttribute('aria-label') || ''));
  const direct = byAria(/^设置$|^Settings$/i);
  if (direct) { direct.click(); return 'direct'; }
  const trigger = byAria(/账号菜单|account menu/i);
  if (!trigger) return 'no-settings-trigger';
  trigger.click();
  await new Promise((r) => setTimeout(r, 1200));
  const item = [...document.querySelectorAll('button, [role="menuitem"], a')]
    .find((el) => /^设置|^Settings/i.test((el.textContent || '').trim()));
  if (!item) return 'no-settings-entry-in-menu';
  item.click();
  return 'menu';
})()`);
console.log('  settings opened: ' + opened);
await settle(2000);

// Go to the Plugins page. Its nav row is an icon button, so the label lives in
// aria-label rather than text content.
const went = await evaluate(`(async () => {
  const match = (el) => {
    const text = (el.textContent || '').trim();
    const aria = (el.getAttribute('aria-label') || '').trim();
    return /^插件$|^Plugins$/i.test(text) || /^插件$|^Plugins$/i.test(aria);
  };
  const row = [...document.querySelectorAll('button, [role="button"], a')].find(match);
  if (!row) return 'no-plugins-row';
  row.click();
  return 'clicked';
})()`);
console.log('  plugins page: ' + went);

// The inventory is fetched asynchronously and its latency varies, so poll for
// the row instead of guessing a fixed delay — a too-short wait reads as a
// missing title and reports a false failure.
async function waitForTitle(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const seen = await evaluate(
      `(document.body.innerText || '').indexOf('已归档会话删除') !== -1 || (document.body.innerText || '').indexOf('Archived Session Delete') !== -1`,
    );
    if (seen) return true;
    if (Date.now() >= deadline) return false;
    await settle(700);
  }
}
const appeared = await waitForTitle(20000);
console.log('  inventory loaded: ' + appeared);
await settle(600);

const report = await evaluate(`(() => {
  const lang = document.documentElement.getAttribute('lang')
    || (navigator.language || '');
  const hits = [];
  for (const el of document.querySelectorAll('*')) {
    if (el.children.length !== 0) continue;
    // Skip non-rendered carriers such as the boot payload script.
    if (/^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(el.tagName)) continue;
    const text = (el.textContent || '').trim();
    if (text === '') continue;
    if (text.indexOf(${JSON.stringify(target)}) === -1
      && !/已归档会话删除|Archived Session Delete/.test(text)) continue;
    hits.push(text.slice(0, 160));
  }
  const all = document.body.innerText || '';
  // Find the icon that belongs to THIS plugin's row: locate the title leaf, walk
  // up to the row container, then look for an image or inline svg inside it.
  // Reported rather than assumed, because an <svg> anywhere on the page would
  // prove nothing (the shell's own nav icons are svgs too).
  const icon = (() => {
    const titles = ['已归档会话删除', 'Archived Session Delete'];
    const leaf = [...document.querySelectorAll('*')].find(
      (el) => el.children.length === 0 && titles.indexOf((el.textContent || '').trim()) !== -1,
    );
    if (!leaf) return { found: false };
    // Walk up to the SMALLEST ancestor that already carries an image, so the
    // sample is this row rather than a group of sibling rows.
    let box = leaf;
    while (box.parentElement && box.querySelectorAll('img, svg').length === 0) box = box.parentElement;
    const imgs = [...box.querySelectorAll('img')].map((im) => {
      const src = String(im.getAttribute('src') || '');
      const at = src.indexOf('base64,');
      let decoded = '';
      try { decoded = at === -1 ? '' : atob(src.slice(at + 7)); } catch (e) { decoded = ''; }
      return {
        loaded: im.complete && im.naturalWidth > 0,
        w: im.naturalWidth,
        svgChars: decoded.length,
        // The generic fallback artwork is an image too, so "an image loaded"
        // proves nothing. Our own SVG carries this unique aria-label.
        isOurs: decoded.indexOf('Archived session delete') !== -1,
      };
    });
    return {
      found: true,
      boxClass: String(box.className || '').slice(0, 40),
      imgs,
      svgs: box.querySelectorAll('svg').length,
    };
  })();
  return JSON.stringify({
    lang,
    hits,
    icon,
    sample: all.replace(/\\n{2,}/g, '\\n').slice(0, 2200),
    seesZhTitle: all.indexOf('已归档会话删除') !== -1,
    seesEnTitle: all.indexOf('Archived Session Delete') !== -1,
    seesZhDesc: all.indexOf('为每个已归档会话增加永久删除按钮') !== -1,
    seesEnDesc: all.indexOf('Adds a permanent Delete action') !== -1,
    seesPackageName: all.indexOf(${JSON.stringify(target)}) !== -1,
  }, null, 1);
})()`);

const data = JSON.parse(report);
console.log('\n  UI language: ' + (data.lang || '(unset)'));
console.log('  matching text: ' + JSON.stringify(data.hits));

check('the localized title is on the page', data.seesZhTitle || data.seesEnTitle,
  JSON.stringify({ zh: data.seesZhTitle, en: data.seesEnTitle }));
check('the localized description is on the page', data.seesZhDesc || data.seesEnDesc,
  JSON.stringify({ zh: data.seesZhDesc, en: data.seesEnDesc }));
check('the raw package name is not used as the display title', !data.seesPackageName || data.seesZhTitle || data.seesEnTitle);
console.log('  icon probe: ' + JSON.stringify(data.icon));
check(
  'the plugin row renders THIS package icon (not the generic fallback)',
  data.icon && data.icon.found && (data.icon.imgs || []).some((im) => im.loaded && im.isOurs),
  JSON.stringify(data.icon),
);
if (data.lang) {
  const wantsZh = /^zh/i.test(data.lang);
  check(
    'the shown locale matches the active UI language (' + data.lang + ')',
    wantsZh ? data.seesZhTitle : data.seesEnTitle,
    JSON.stringify({ wantsZh, zh: data.seesZhTitle, en: data.seesEnTitle }),
  );
}

console.log('\n' + (failures === 0 ? 'all checks passed' : failures + ' check(s) failed'));
if (failures !== 0 && data.sample) console.log('\nvisible text sample:\n' + data.sample);
ws.close();
chrome.kill();
try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(failures === 0 ? 0 : 1);
