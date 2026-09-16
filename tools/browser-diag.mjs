/**
 * Read the DSH web boot failure cause from a real browser.
 *
 * The boot banner names the failing plugin but not why its fiber failed. This
 * arms the page BEFORE navigation by injecting a script that records every
 * console call and unhandled rejection, and by wrapping the loader entry point
 * so the underlying error is captured.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2];
const chromePath = process.argv[3];
const port = 9334;
const profile = mkdtempSync(join(tmpdir(), 'asdel-chrome-'));

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
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('devtools endpoint never became ready');
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
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args || [])
      .map((a) => {
        if (a.value !== undefined) return String(a.value);
        if (a.description !== undefined) return String(a.description);
        if (a.preview && a.preview.description) return String(a.preview.description);
        return JSON.stringify(a);
      })
      .join(' ');
    logs.push(`[${msg.params.type}] ${text}`);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    const desc = d.exception && d.exception.description ? d.exception.description : d.text;
    logs.push(`[exception] ${desc}`);
  }
  if (msg.method === 'Log.entryAdded') {
    logs.push(`[log:${msg.params.entry.level}] ${msg.params.entry.text}`);
  }
});

const target = await send(ws, 'Target.createTarget', { url: 'about:blank' });
const attached = await send(ws, 'Target.attachToTarget', { targetId: target.targetId, flatten: true });
const sessionId = attached.sessionId;

await send(ws, 'Page.enable', {}, sessionId);
await send(ws, 'Runtime.enable', {}, sessionId);
await send(ws, 'Log.enable', {}, sessionId);

// Arm a recorder BEFORE the app script runs, so a failure inside apply() is
// captured with its own stack rather than only the banner's summary.
const prelude = `
(() => {
  const seen = [];
  window.__ASDEL_ERRORS__ = seen;
  const origError = console.error;
  console.error = function (...args) {
    try {
      seen.push(args.map((a) => {
        if (a instanceof Error) return a.stack || String(a);
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch (e) { return String(a); }
      }).join(' '));
    } catch (e) {}
    return origError.apply(console, args);
  };
  window.addEventListener('error', (e) => {
    seen.push('window.error: ' + (e.error && e.error.stack ? e.error.stack : e.message));
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    seen.push('unhandledrejection: ' + (r && r.stack ? r.stack : String(r)));
  });
})();
`;

await send(ws, 'Page.addScriptToEvaluateOnNewDocument', { source: prelude }, sessionId);
await send(ws, 'Page.navigate', { url }, sessionId);

await new Promise((r) => setTimeout(r, 12000));

const result = await send(
  ws,
  'Runtime.evaluate',
  {
    expression: `(() => {
      const boot = document.querySelector('[data-dsh-boot]');
      return JSON.stringify({
        bootText: boot === null ? null : (boot.innerText || '').slice(0, 400),
        captured: window.__ASDEL_ERRORS__ || [],
      }, null, 2);
    })()`,
    returnByValue: true,
  },
  sessionId,
);

console.log('=== captured ===');
console.log(result && result.result ? result.result.value : JSON.stringify(result));
console.log('');
console.log('=== console (' + logs.length + ') ===');
for (const line of logs.slice(0, 80)) console.log(line);

ws.close();
chrome.kill();
try {
  rmSync(profile, { recursive: true, force: true });
} catch (error) {
  /* best effort */
}
process.exit(0);
