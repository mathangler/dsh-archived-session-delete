/**
 * Check the Settings nav on a running Harness: boot verdict + nav rows.
 *
 * Reports whether the boot banner is absent and how many nav rows carry the
 * Archived-sessions label, plus whether this package's dedup marker landed.
 * Uses its own throwaway Chrome profile and never touches a user's browser.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2];
const chromePath = process.argv[3];
const port = 9350;
const profile = mkdtempSync(join(tmpdir(), 'asdel-nav-'));

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
  throw new Error('devtools never ready');
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
  });
}

const version = await waitForDevtools(20000);
const ws = await connect(version.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
const errors = [];
function send(method, params, sessionId) {
  const id = nextId++;
  const payload = { id, method, params: params === undefined ? {} : params };
  if (sessionId !== undefined) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((resolve) => pending.set(id, resolve));
}
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    errors.push(String(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
  }
});

const target = await send('Target.createTarget', { url: 'about:blank' });
const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
const session = attached.sessionId;
await send('Runtime.enable', {}, session);
await send('Page.enable', {}, session);
await send('Page.navigate', { url }, session);
await new Promise((r) => setTimeout(r, 12000));

// Open Settings. DSH 0.2 moved the entry INSIDE the account menu (its label
// carries the shortcut, e.g. "设置Ctrl+Alt+,"), so no top-level button exists
// any more; older builds expose one directly. Try the direct control first and
// fall back to the account menu, so one check spans both layouts.
const opened = await send(
  'Runtime.evaluate',
  {
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
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
    })()`,
  },
  session,
);
await new Promise((r) => setTimeout(r, 2500));

const result = await send(
  'Runtime.evaluate',
  {
    expression: `(() => {
      const boot = document.querySelector('[data-dsh-boot]');
      const rows = [...document.querySelectorAll('button')].filter(b => /已归档会话|Archived sessions/.test(b.textContent || ''));
      return JSON.stringify({
        bootBanner: boot === null ? null : (boot.innerText || '').slice(0, 200),
        settingsTrigger: ${JSON.stringify('')} || null,
        navRowCount: rows.length,
        navRows: rows.map(b => ({
          text: (b.textContent || '').replace(/\\u200b/g, '<ZWSP>'),
          hasMarker: b.hasAttribute('data-asdel-nav'),
          ariaCurrent: b.getAttribute('aria-current'),
        })),
      }, null, 2);
    })()`,
    returnByValue: true,
  },
  session,
);

console.log('settings open attempt:', opened?.result?.value);
console.log(result.result.value);
console.log('exceptions:', errors.length);
for (const e of errors.slice(0, 5)) console.log('  ' + e);

ws.close();
chrome.kill();
try { rmSync(profile, { recursive: true, force: true }); } catch (error) {}
process.exit(0);
