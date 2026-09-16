/**
 * dsh-archived-session-delete — host half.
 *
 * A Cordis plugin row (`name: 'archived-session-delete'`) that publishes one
 * JSON route on the composition's `webServer` and dispatches it onto the
 * method map from `host-core.js`.
 *
 * Why it registers its own route instead of using `connection.rpc.handle(...)`:
 * that helper registers the channel through `owner.webServer`, where `owner` is
 * the Connection service's context. In cordis 4.x a service context is a shadow
 * whose service lookups resolve in the PROVIDER's fiber chain, so `webServer`
 * would have to be injected by the *connection* row rather than by this one.
 * Registering directly on our own `webServer` is the pattern the shipped
 * `@deepseek-ai/dsh-host-open-in-app` host plugin uses.
 *
 * Security is not hand-rolled: every request goes through the composition's
 * `connection.requestRejection(req)` first, which applies the platform's
 * Host/Origin fence and its browser login-token check. Only then is a body read
 * or a handler reached.
 *
 * No `shell` service is injected. Earlier revisions ran PowerShell text through
 * `ctx.shell`, which is wrong on every platform but Windows: that seam is an
 * *abstract bash executor*, composed as `bash -c` on macOS/Linux and as
 * `pwsh -Command` only on win32. The filesystem work now lives in
 * `host-core.js` on `node:fs`, so the three platforms run one identical code
 * path and the composition needs nothing but `webServer` and `connection`.
 *
 * @module dsh-archived-session-delete
 */
import { createHandlers } from './host-core.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Cordis plugin name reported to the loader. */
const name = 'archived-session-delete';

/** `webServer` carries the route; `connection` is the trust fence. */
const inject = ['webServer', 'connection'];

/** Absolute route prefix owned by this plugin; must match the client half. */
const CHANNEL = '/archived-session-delete';

/** Requests are small JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024;

/** One endpoint segment: the names host-core exports, and nothing else. */
const ENDPOINT_RE = /^[A-Za-z0-9_$.-]+$/;

/** Endpoints this route answers; anything else is a 404. */
const ENDPOINTS = Object.freeze(['inspect', 'orphans', 'delete']);

/** Success envelope; the client half unwraps `value`. */
const ok = (value) => ({ ok: true, value });

/** Failure envelope; the client half surfaces `error.message`. */
const fail = (code, message) => ({ ok: false, error: { code, message } });

/** JSON response. `no-store`: every answer is a live fact about this machine. */
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

/** Collect a bounded request body as UTF-8 text; null past the ceiling. */
async function readBoundedBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) {
      req.resume();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

/**
 * The DSH home directory: `$DSH_HOME`, else `<homedir>/.dsh`. Passed to the
 * handlers as a resolver, so a changed environment is honoured per call without
 * a restart.
 */
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return join(homedir(), '.dsh');
}

/**
 * Cordis plugin body.
 * @param ctx - the plugin's Cordis context.
 */
function apply(ctx) {
  const handlers = createHandlers(ctx, {
    dshHome: resolveDshHome,
    /**
     * Tell Session-list consumers that this session is gone.
     *
     * `api-session/removed` is the platform's own signal for this (the shipped
     * Session controller emits it from its `session/disposed` listener, and the
     * browser side answers it with `handleSessionRemoved`). Clearing the archive
     * flag alone is not enough: the archive set is what HID the row, so a
     * client that still holds its summary would render it in the ungrouped
     * bucket. Announcing the removal first is what keeps it from surviving.
     */
    emitRemoved: (sessionId) => ctx.emit('api-session/removed', sessionId),
  });

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: CHANNEL,
        handler: async (req, res) => {
          // The platform's fence, first: an untrusted or unauthenticated caller
          // never reaches a handler or a body read.
          const rejection = ctx.connection.requestRejection(req);
          if (rejection !== undefined) {
            res.statusCode = rejection;
            res.end();
            return;
          }
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.setHeader('allow', 'POST');
            res.end();
            return;
          }
          const mediaType = String(req.headers['content-type'] || '')
            .split(';', 1)[0]
            .trim()
            .toLowerCase();
          if (mediaType !== 'application/json') {
            sendJson(res, 415, fail('archived-session-delete/bad-request', 'content type must be application/json'));
            return;
          }
          const pathname = new URL(String(req.url), 'http://localhost').pathname;
          const endpoint = pathname.slice(CHANNEL.length).replace(/^\//, '');
          if (!ENDPOINT_RE.test(endpoint) || ENDPOINTS.indexOf(endpoint) === -1) {
            sendJson(res, 404, fail('archived-session-delete/unknown-endpoint', 'malformed endpoint'));
            return;
          }

          const body = await readBoundedBody(req);
          if (body === null) {
            sendJson(res, 413, fail('archived-session-delete/too-large', 'request body too large'));
            return;
          }
          let args = {};
          if (body.length > 0) {
            try {
              args = JSON.parse(body);
            } catch (error) {
              sendJson(res, 400, fail('archived-session-delete/bad-json', 'request body must be JSON'));
              return;
            }
          }

          try {
            const value = await handlers[endpoint](args);
            sendJson(res, 200, ok(value));
          } catch (error) {
            // Business failures ride the 200 envelope; only transport faults
            // above use 4xx/5xx.
            sendJson(res, 200, ok({ ok: false, error: String(error && error.message ? error.message : error) }));
          }
        },
      }),
    'dsh-archived-session-delete: ' + CHANNEL + ' route',
  );
}

export { apply, inject, name, CHANNEL };
