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
 * @module dsh-archived-session-delete
 */
import { createHandlers } from './host-core.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Cordis plugin name reported to the loader. */
const name = 'archived-session-delete';

/**
 * `webServer` carries the route; `connection` is the trust fence. `shell` is
 * resolved optionally through `ctx.get(...)` below, so a composition without a
 * shell provider reports a visible error per call instead of failing to boot.
 */
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
 * The DSH home directory: `$DSH_HOME`, else `<homedir>/.dsh`. Resolved per call
 * so a changed environment is honoured without a restart.
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
  /**
   * Run one PowerShell script through the composition's shell service.
   *
   * Deletion targets live under the DSH home, which is outside any session
   * workspace, so the call declares `danger-full-access`. The fence is the
   * user's own approval policy plus the fact that this plugin only ever names
   * paths it constructed from a validated session id.
   */
  async function runPowerShell(script, timeoutMs) {
    const shell = ctx.get('shell');
    if (shell === undefined) {
      throw new Error('the shell service is unavailable, so nothing can be deleted');
    }
    const home = resolveDshHome();
    const spec = shell.resolve({
      command: script,
      workdir: home,
      timeoutMs: timeoutMs === undefined ? 60000 : timeoutMs,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: home },
    });
    const result = await shell.run(spec);
    const out = result.stdout !== undefined && result.stdout.text !== undefined ? result.stdout.text : '';
    const err = result.stderr !== undefined && result.stderr.text !== undefined ? result.stderr.text : '';
    return { code: result.exitCode, out: out, err: err };
  }

  const handlers = createHandlers(ctx, {
    dshHome: resolveDshHome(),
    runPowerShell: runPowerShell,
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
