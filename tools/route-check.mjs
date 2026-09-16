/**
 * route-check.mjs — end-to-end check of the host half's HTTP route.
 *
 * Boots the real `apply()` from `lib/index.js` against a minimal Cordis-like
 * context, binds the handler it registers to a real loopback HTTP server, and
 * drives it with real `fetch` requests over a synthetic DSH home.
 *
 * This is the layer the browser half actually talks to, so it proves the wiring
 * (route prefix, trust fence, envelope, method/content-type/endpoint guards)
 * after the transport rewrite — and, importantly, that the plugin now declares
 * NO dependency on `ctx.shell`.
 *
 * Usage:
 *   node tools/route-check.mjs
 *
 * Exits 0 when every assertion holds, 1 otherwise.
 */
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, inject, CHANNEL } from '../lib/index.js';

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log('  ok   ' + label);
    return;
  }
  failures += 1;
  console.log('  FAIL ' + label + (detail === undefined ? '' : ' — ' + detail));
}

const home = mkdtempSync(join(tmpdir(), 'asdel-route-'));
const PROJECT = '--tmp-project--';
const ARCHIVED = 'session-55555555-5555-4555-8555-555555555555';

function plant(id, bytes) {
  const dir = join(home, 'sessions', PROJECT, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.jsonl'), 'x'.repeat(bytes));
  writeFileSync(join(home, 'storages', 'session_projcache', 'sessions', id + '.json'), '{}');
  return dir;
}

process.env.DSH_HOME = home;

const registry = {
  archivedSessionIds: [ARCHIVED],
  list: () => [],
  unarchiveSession: async (id) => {
    const at = registry.archivedSessionIds.indexOf(id);
    if (at !== -1) registry.archivedSessionIds.splice(at, 1);
  },
};

const emitted = [];
/** The registered route entry, captured from `webServer.register(...)`. */
let route = null;
const ctx = {
  get: (name) => (name === 'workspaceRegistry' ? registry : undefined),
  emit: (event, payload) => emitted.push([event, payload]),
  webServer: {
    register: (entry) => {
      route = entry;
      return () => {};
    },
  },
  connection: {
    requestRejection: (req) => (req.headers['x-test-reject'] === '1' ? 401 : undefined),
  },
  effect: (fn) => {
    fn();
  },
};

apply(ctx);

if (route === null) {
  console.log('apply() registered no route');
  process.exit(1);
}

const server = createServer((req, res) => route.handler(req, res));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port + CHANNEL;
const post = (path, body, headers) =>
  fetch(base + path, {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, headers),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

console.log('route-check on ' + process.platform + ' — route ' + route.path);

try {
  mkdirSync(join(home, 'sessions', PROJECT), { recursive: true });
  mkdirSync(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true });
  const archivedDir = plant(ARCHIVED, 128);

  console.log('\nwiring');
  check('apply() registers a prefix route', route.kind === 'prefix', String(route.kind));
  check('the route path is the client channel', route.path === CHANNEL, String(route.path));
  check('the plugin no longer injects the shell service', inject.indexOf('shell') === -1, inject.join(','));

  console.log('\ntransport guards');
  const getResponse = await fetch(base + '/inspect', { method: 'GET' });
  check('a non-POST is 405', getResponse.status === 405, 'status=' + getResponse.status);
  check('a non-POST advertises Allow: POST', getResponse.headers.get('allow') === 'POST');

  const badType = await post('/inspect', { sessionId: ARCHIVED }, { 'content-type': 'text/plain' });
  check('a non-JSON content type is 415', badType.status === 415, 'status=' + badType.status);

  const unknown = await post('/nope', {});
  check('an unknown endpoint is 404', unknown.status === 404, 'status=' + unknown.status);

  // Percent-encoded, so `fetch` does not collapse it before it reaches the
  // route's own endpoint regex — this really exercises that guard.
  const traversal = await post('/%2e%2e%2f%2e%2e%2fetc%2fpasswd', {});
  check('an encoded traversal endpoint is 404', traversal.status === 404, 'status=' + traversal.status);

  const badJson = await post('/inspect', '{not json');
  check('malformed JSON is 400', badJson.status === 400, 'status=' + badJson.status);

  const huge = await post('/inspect', JSON.stringify({ pad: 'z'.repeat(70 * 1024) }));
  check('an oversized body is 413', huge.status === 413, 'status=' + huge.status);

  const rejected = await post('/inspect', { sessionId: ARCHIVED }, { 'x-test-reject': '1' });
  check('the connection fence is consulted first', rejected.status === 401, 'status=' + rejected.status);

  console.log('\ninspect');
  const inspected = await post('/inspect', { sessionId: ARCHIVED });
  const inspectedBody = await inspected.json();
  check('answers 200', inspected.status === 200, 'status=' + inspected.status);
  check('wraps the value in the success envelope', inspectedBody.ok === true && inspectedBody.value !== undefined, JSON.stringify(inspectedBody));
  const inspectedValue = inspectedBody.ok === true ? inspectedBody.value : null;
  check('locates the on-disk session dir', inspectedValue !== null && inspectedValue.dirs === 1, JSON.stringify(inspectedValue));
  check('locates the projcache record', inspectedValue !== null && inspectedValue.cache === 1, JSON.stringify(inspectedValue));
  check('does not modify anything', existsSync(archivedDir));

  const badId = await post('/inspect', { sessionId: '../../etc' });
  const badIdBody = await badId.json();
  check('a malformed id rides the 200 envelope as a business failure', badId.status === 200 && badIdBody.value.ok === false, JSON.stringify(badIdBody));

  console.log('\norphans');
  const orphans = await post('/orphans', {});
  const orphansBody = await orphans.json();
  check('answers 200', orphans.status === 200, 'status=' + orphans.status);
  check('counts the scanned session', orphansBody.value.scanned === 1, JSON.stringify(orphansBody.value));
  check('the archived session is not an orphan', orphansBody.value.orphans.length === 0, JSON.stringify(orphansBody.value));

  console.log('\ndelete');
  const deleted = await post('/delete', { sessionId: ARCHIVED });
  const deletedBody = await deleted.json();
  check('answers 200', deleted.status === 200, 'status=' + deleted.status);
  check('reports success', deletedBody.value.ok === true, JSON.stringify(deletedBody.value));
  check('removes the data directory', !existsSync(archivedDir));
  check('drops the archive entry', registry.archivedSessionIds.indexOf(ARCHIVED) === -1);
  check('announces api-session/removed', emitted.length === 1 && emitted[0][0] === 'api-session/removed' && emitted[0][1] === ARCHIVED, JSON.stringify(emitted));
  check('reports the ordered steps', Array.isArray(deletedBody.value.steps) && deletedBody.value.steps.length >= 3, JSON.stringify(deletedBody.value.steps));
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(home, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nall checks passed' : '\n' + failures + ' check(s) failed');
process.exit(failures === 0 ? 0 : 1);
