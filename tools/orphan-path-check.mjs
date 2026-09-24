/**
 * Orphan-path regression check — the exact sequence the user reported.
 *
 * The reported defect: delete one orphan, then arm a DIFFERENT orphan inside the
 * notice window; when the confirmation appears and goes away, the second row
 * lands in the wrong place. The old design reproduced this because the deleted
 * row stayed in the list while the next interaction captured a position from a
 * list that still contained it.
 *
 * This drives a real browser against a running Harness and asserts the new
 * invariants instead:
 *   1. the deleted row leaves IMMEDIATELY on host confirmation
 *   2. the remaining rows keep their order and their pixel positions
 *   3. the result appears in the dedicated notice area, never on a row
 *   4. arming a second row while a notice is alive does not disturb placement
 *
 * Rows are addressed by INDEX, not by title: arming a row rewrites its title to
 * the confirmation prompt, so a title lookup silently stops matching mid-flow
 * (an earlier revision of this check made exactly that mistake and reported a
 * spurious pass while never deleting anything).
 *
 * Exits non-zero on any failure. Launches its own throwaway Chrome profile and
 * kills only that process, so a browser the user already has open is untouched.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2];
const chromePath = process.argv[3];

const FIXTURES = [
  'session-00000000-aaaa-4aaa-8aaa-000000000001',
  'session-00000000-aaaa-4aaa-8aaa-000000000002',
  'session-00000000-aaaa-4aaa-8aaa-000000000003',
];

const port = 9351;
const profile = mkdtempSync(join(tmpdir(), 'asdel-orphan-'));

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let failures = 0;
function check(label, ok, detail) {
  if (ok) {
    console.log('  ok   ' + label);
    return;
  }
  failures += 1;
  console.log('  FAIL ' + label + (detail === undefined ? '' : ' — ' + detail));
}

async function waitForDevtools(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return await r.json();
    } catch (error) {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('devtools never became ready');
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', () => reject(new Error('websocket error')), { once: true });
  });
}

const version = await waitForDevtools(20000);
const ws = await connect(version.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
  }
});
function send(method, params, sessionId) {
  const id = nextId++;
  const payload = { id, method, params: params === undefined ? {} : params };
  if (sessionId !== undefined) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((resolve) => pending.set(id, resolve));
}

/** Evaluate an expression in the page and return its value. */
async function evaluate(session, expression) {
  const reply = await send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    session,
  );
  if (reply && reply.exceptionDetails) {
    throw new Error(
      'page threw: ' +
        String(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text),
    );
  }
  return reply && reply.result ? reply.result.value : undefined;
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// Page-side helpers, installed once and reused by every later evaluation.
const HELPERS = `
window.__asdel = {
  list() {
    const lists = [...document.querySelectorAll('ul.asdel-list')];
    return lists.length ? lists[lists.length - 1] : null;
  },
  nodes() {
    const list = this.list();
    return list ? [...list.querySelectorAll('li.asdel-row')] : [];
  },
  rows() {
    return this.nodes().map((li) => {
      const title = li.querySelector('.asdel-title');
      return {
        title: title ? title.textContent : '',
        top: Math.round(li.getBoundingClientRect().top),
        actions: [...li.querySelectorAll('button')].map((b) => b.textContent),
      };
    });
  },
  titles() { return this.rows().map((r) => r.title); },
  indexOf(id) { return this.titles().indexOf(id); },
  clickAt(index, label) {
    const li = this.nodes()[index];
    if (!li) return 'no-row-at-' + index;
    for (const b of li.querySelectorAll('button')) {
      if (b.textContent === label) {
        if (b.disabled) return 'disabled';
        b.click();
        return 'clicked';
      }
    }
    return 'no-button:' + [...li.querySelectorAll('button')].map((b) => b.textContent).join('|');
  },
  notice() {
    const el = document.querySelector('.asdel-notice');
    if (!el) return null;
    const text = el.querySelector('.asdel-notice-text');
    return {
      kind: el.classList.contains('asdel-notice-err') ? 'error' : 'success',
      text: text ? text.textContent : '',
      hasClose: !!el.querySelector('.asdel-notice-close'),
      live: el.getAttribute('aria-live'),
      path: (() => { const p = []; let n = el; while (n && n !== document.body) { p.push(n.tagName.toLowerCase() + (n.className ? '.' + String(n.className).split(' ')[0] : '')); n = n.parentElement; } return p.reverse().join(' > '); })(),
      noticeTop: Math.round(el.getBoundingClientRect().top),
      anyRowTop: this.nodes().length ? Math.round(this.nodes()[0].getBoundingClientRect().top) : null,
    };
  },
  clickByText(text) {
    const el = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
    if (!el) return 'not-found';
    if (el.disabled) return 'disabled';
    el.click();
    return 'clicked';
  },
};
'ok';
`;

const target = await send('Target.createTarget', { url: 'about:blank' });
const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
const session = attached.sessionId;
await send('Runtime.enable', {}, session);
await send('Page.enable', {}, session);
await send('Page.navigate', { url }, session);
await settle(12000);
await evaluate(session, HELPERS);

console.log('orphan-path regression check\n');

// Open Settings, then the archived-sessions page.
await evaluate(
  session,
  `(() => {
     const btn = [...document.querySelectorAll('button')].find(b => /设置|Settings/.test(b.getAttribute('aria-label') || '') || /设置|Settings/.test(b.textContent || ''));
     if (btn) btn.click();
     return 'ok';
   })()`,
);
await settle(2500);
await evaluate(
  session,
  `(() => {
     const row = [...document.querySelectorAll('button')].find(b => /已归档会话|Archived sessions/.test(b.textContent || ''));
     if (row) row.click();
     return 'ok';
   })()`,
);
await settle(2000);

// Scan for orphans.
check('the Scan button is present', (await evaluate(session, `window.__asdel.clickByText('扫描')`)) === 'clicked');
await settle(3000);

const planted = await evaluate(
  session,
  `(() => { const t = window.__asdel.titles(); return ${JSON.stringify(FIXTURES)}.map(id => t.indexOf(id)); })()`,
);
check(
  'all three planted orphans are listed',
  Array.isArray(planted) && planted.every((at) => at !== -1),
  JSON.stringify(planted),
);

const extract = (expr) => evaluate(session, expr).then(JSON.parse);
// --- delete the SECOND planted orphan via index-addressed clicks -------------
// Deliberately not the first: deleting a row with a row ABOVE it lets us assert
// that the notice's appearance moves nothing, since the notice is appended after
// every row rather than inserted above them.
const firstAt = planted[1];
console.log('\ndelete orphan at index ' + firstAt + ', then arm another inside the notice window');

check('armed the first orphan', (await evaluate(session, `window.__asdel.clickAt(${firstAt}, '删除')`)) === 'clicked');
await settle(400);
const armedRow = (await extract(`JSON.stringify(window.__asdel.rows())`))[firstAt];
check('the same index now shows the confirmation', armedRow.title.indexOf('确认删除') !== -1, JSON.stringify(armedRow));

const beforeConfirm = await extract(`JSON.stringify(window.__asdel.rows())`);

check('confirmed the delete', (await evaluate(session, `window.__asdel.clickAt(${firstAt}, '确认删除')`)) === 'clicked');
await settle(700);

const afterDelete = await extract(`JSON.stringify(window.__asdel.rows())`);
const notice = await extract(`JSON.stringify(window.__asdel.notice())`);

check(
  'the deleted orphan is gone immediately, not on a timer',
  afterDelete.every((r) => r.title !== FIXTURES[1]),
  JSON.stringify(afterDelete.map((r) => r.title)),
);
check(
  'the result appears in the dedicated notice area',
  notice !== null && notice.text.indexOf(FIXTURES[1]) !== -1,
  JSON.stringify(notice),
);
check('the notice area offers a close control', notice !== null && notice.hasClose === true);
check('the notice is an aria-live region', notice !== null && notice.live === 'polite');
check(
  'the notice renders OUTSIDE the list',
  notice !== null && notice.path.indexOf('ul.asdel-list') === -1,
  notice === null ? 'no notice' : notice.path,
);
check(
  'rows ABOVE the deleted row do not move when the notice appears',
  firstAt > 0 &&
    afterDelete.length >= firstAt &&
    afterDelete.slice(0, firstAt).every((r, i) => r.top === beforeConfirm[i].top),
  JSON.stringify({ before: beforeConfirm.slice(0, firstAt).map((r) => r.top), after: afterDelete.slice(0, firstAt).map((r) => r.top) }),
);

// The bug trigger: arm a DIFFERENT row while the notice is still alive.
const secondAt = afterDelete.findIndex((r) => r.title === FIXTURES[2]);
check('the second orphan is still idle and findable', secondAt !== -1, JSON.stringify(afterDelete.map((r) => r.title)));
const untouchedBefore = afterDelete.filter((_, i) => i !== secondAt);

check('armed the second orphan', (await evaluate(session, `window.__asdel.clickAt(${secondAt}, '删除')`)) === 'clicked');
await settle(400);
const armedState = await extract(`JSON.stringify(window.__asdel.rows())`);
const untouchedArmed = armedState.filter((_, i) => i !== secondAt);

check(
  'arming a second orphan does not move it',
  armedState.length === afterDelete.length && armedState[secondAt].title.indexOf('确认删除') !== -1,
  JSON.stringify(armedState.map((r) => r.title)),
);
check(
  'untouched rows keep their pixel positions while a row is armed',
  untouchedBefore.length === untouchedArmed.length &&
    untouchedBefore.every((r, i) => r.top === untouchedArmed[i].top),
  JSON.stringify({ before: untouchedBefore.map((r) => r.top), after: untouchedArmed.map((r) => r.top) }),
);

// Nothing may resurface when the notice expires.
await settle(3600);
const settledState = await extract(`JSON.stringify(window.__asdel.rows())`);
check(
  'the deleted orphan never reappears after the notice expires',
  settledState.every((r) => r.title !== FIXTURES[1]),
  JSON.stringify(settledState.map((r) => r.title)),
);
check('the list did not grow', settledState.length === afterDelete.length, settledState.length + ' vs ' + afterDelete.length);
check(
  'the second orphan is still armed at the same index',
  settledState[secondAt] !== undefined && settledState[secondAt].title.indexOf('确认删除') !== -1,
  JSON.stringify(settledState[secondAt]),
);
check('a success notice dismissed itself', (await extract(`JSON.stringify(window.__asdel.notice())`)) === null);

// Cancelling must leave no trace either.
check('cancelled the confirmation', (await evaluate(session, `window.__asdel.clickAt(${secondAt}, '取消')`)) === 'clicked');
await settle(400);
const cancelled = await extract(`JSON.stringify(window.__asdel.rows())`);
check(
  'cancelling restores the row in place',
  cancelled[secondAt] !== undefined &&
    cancelled[secondAt].title === FIXTURES[2] &&
    cancelled[secondAt].actions.indexOf('删除') !== -1,
  JSON.stringify(cancelled.map((r) => ({ t: r.title, a: r.actions }))),
);
check(
  'cancelling moves nothing',
  cancelled.length === settledState.length &&
    cancelled.every((r, i) => r.top === settledState[i].top || i === secondAt),
  JSON.stringify({ settled: settledState.map((r) => r.top), cancelled: cancelled.map((r) => r.top) }),
);

console.log('\n' + (failures === 0 ? 'all checks passed' : failures + ' check(s) failed'));

ws.close();
chrome.kill();
try { rmSync(profile, { recursive: true, force: true }); } catch (error) {}
process.exit(failures === 0 ? 0 : 1);
