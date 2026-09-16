/**
 * Assert the DSH web app boots AND renders its shell, in a real browser.
 *
 * Exits non-zero when the boot banner is present or the shell never painted.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2];
const chromePath = process.argv[3];
const port = 9340;
const profile = mkdtempSync(join(tmpdir(), 'asdel-assert-'));

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

const logs = [];
let nextId = 1;
const pending = new Map();
function send(ws, method, params, sessionId) {
  const id = nextId++;
  const payload = { id, method, params: params === undefined ? {} : params };
  if (sessionId !== undefined) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((resolve) => pending.set(id, resolve));
}

const version = await waitForDevtools(20000);
const ws = await connect(version.webSocketDebuggerUrl);
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    logs.push('EXCEPTION ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    logs.push('CONSOLE ' + (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
  }
});

const target = await send(ws, 'Target.createTarget', { url: 'about:blank' });
const attached = await send(ws, 'Target.attachToTarget', { targetId: target.targetId, flatten: true });
const sessionId = attached.sessionId;
await send(ws, 'Runtime.enable', {}, sessionId);
await send(ws, 'Page.enable', {}, sessionId);
await send(ws, 'Page.navigate', { url }, sessionId);
await new Promise((r) => setTimeout(r, 14000));

const result = await send(
  ws,
  'Runtime.evaluate',
  {
    expression: `(() => {
      const boot = document.querySelector('[data-dsh-boot]');
      const settingsTrigger = document.querySelector('button[aria-label]');
      return JSON.stringify({
        bootBanner: boot === null ? null : (boot.innerText || '').slice(0, 300),
        canvasChildren: document.body.children.length,
        buttonCount: document.querySelectorAll('button').length,
        hasWordmark: (document.body.innerText || '').includes('HARNESS'),
        textSample: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 260),
      });
    })()`,
    returnByValue: true,
  },
  sessionId,
);

const data = JSON.parse(result.result.value);
console.log(JSON.stringify(data, null, 2));
console.log('');
console.log('console errors/ exceptions: ' + logs.length);
for (const l of logs.slice(0, 10)) console.log('  ' + l);

const ok = data.bootBanner === null && data.buttonCount > 0;
console.log('');
console.log(ok ? 'RESULT: BOOT OK — shell rendered, no failure banner' : 'RESULT: FAILED');

ws.close();
chrome.kill();
try { rmSync(profile, { recursive: true, force: true }); } catch (e) {}
process.exit(ok ? 0 : 1);
