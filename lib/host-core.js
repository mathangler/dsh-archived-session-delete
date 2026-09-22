/**
 * archived-session-delete — transport-free, platform-neutral business logic.
 *
 * This module owns the deletion semantics and never touches `req`/`res`. It is
 * deliberately separated from `index.js` so the rules can be unit-tested in
 * plain Node, and so the HTTP adapter stays a thin, auditable shim.
 *
 * PLATFORM NEUTRALITY (why this file uses `node:fs` rather than a shell):
 * the previous revision built PowerShell scripts and ran them through
 * `ctx.shell`. That seam is NOT a PowerShell seam — `@deepseek-ai/dsh-shell` is
 * an "abstract bash executor", and the host composes exactly one provider:
 *
 *   - win32                     -> `pwsh -NoProfile -Command <script>`
 *   - darwin / linux (and rest) -> `bash -c <script>`
 *
 * So on macOS and Linux the PowerShell text was handed to bash, which answered
 * `bash: =: command not found` / `syntax error near unexpected token '('` and
 * exited non-zero; every operation failed with "could not locate the session on
 * disk". The path construction had the same bug in miniature: a hardcoded
 * `'\\'` joiner produced `~/.dsh\sessions` on POSIX, which is a legal (and
 * useless) filename, not a directory.
 *
 * Node's own filesystem API is the same on all three platforms, needs no
 * shell, no external binary, no quoting rules and no JSON round-trip, so it is
 * the only implementation here. Paths are built with `node:path`, which picks
 * the separator from the runtime platform.
 *
 * What a delete removes, matching the `clean-dsh-sessions` skill for one
 * session:
 *   1. the session data directory   <dshHome>/sessions/<project-dir>/<id>/
 *   2. its projcache record         <dshHome>/storages/session_projcache/sessions/<id>.json*
 *   3. its index entries            global.archivedSessionIds and
 *                                   tables.workspaces[*].sessionIds
 *
 * Index pruning goes through the live `workspaceRegistry` rather than editing
 * `workspace.json`: the running Host keeps that file in memory and rewrites it
 * wholesale on its next mutation, so a direct file edit is silently reverted.
 *
 * @module dsh-archived-session-delete/host-core
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Session ids are opaque, but only this alphabet is ever accepted. */
const SAFE_ID = /^[A-Za-z0-9_$.-]+$/;

/** How many session directories are sized at once; I/O bound, modest pool. */
const SCAN_CONCURRENCY = 8;

/** Recursive-remove retries: Windows AV/indexers transiently lock directories. */
const RM_MAX_RETRIES = 3;
const RM_RETRY_DELAY_MS = 100;

/**
 * Compact human byte size. Kept here (not in the client) so both halves agree.
 * @param value - byte count.
 * @returns a short label such as `1.5 MB`.
 */
export function humanSize(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = n;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size = size / 1024;
    index += 1;
  }
  const text = index === 0 ? String(Math.round(size)) : size.toFixed(size < 10 ? 2 : 1);
  return text + ' ' + units[index];
}

/** Normalize a JSON field that may be absent, a string, or an array. */
function toList(value) {
  if (value === null || value === undefined) return [];
  const items = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of items) {
    if (typeof item === 'string' && item.length > 0) out.push(item);
  }
  return out;
}

/** The `code` of a Node system error, or an empty string. */
function errorCode(error) {
  return error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : '';
}

/**
 * Build the method map over the live runtime.
 *
 * @param ctx - the plugin's Cordis context (used only through optional reads).
 * @param options - injected collaborators.
 * @param options.dshHome - absolute DSH home directory, or a `() => string`
 *   resolver. A resolver is honoured per call, so a changed `$DSH_HOME` is
 *   picked up without a restart.
 * @param options.emitRemoved - optional `(sessionId) => void`, the platform's
 *   `api-session/removed` announcement.
 * @returns the method map keyed by endpoint name.
 */
export function createHandlers(ctx, options) {
  const settings = options === null || options === undefined ? {} : options;
  const emitRemoved = settings.emitRemoved;
  const configuredHome = settings.dshHome;
  const homeOf = typeof configuredHome === 'function' ? configuredHome : function () { return configuredHome; };

  /** The DSH home, absolute and normalized, resolved per call. */
  function dshHome() {
    const value = homeOf();
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('the DSH home directory could not be resolved');
    }
    return resolve(value);
  }

  /** `<dshHome>/sessions`, using this platform's separator. */
  function sessionsRoot() {
    return join(dshHome(), 'sessions');
  }

  /** `<dshHome>/storages/session_projcache/sessions`. */
  function cacheRoot() {
    return join(dshHome(), 'storages', 'session_projcache', 'sessions');
  }

  /** The workspace registry, read optionally so a composition without it degrades. */
  function registry() {
    return ctx.get('workspaceRegistry');
  }

  /**
   * Membership set for the registry-global pin set, which DSH `0.1.7` added
   * alongside `archivedSessionIds`.
   *
   * A pin is a second way an id can outlive its session, so the delete clears
   * it for the same reason it clears the archive entry. Runtimes older than
   * `0.1.7` expose no such property; a missing or non-array value degrades to
   * "nothing is pinned" rather than throwing, so one package covers both
   * without gating on a version string.
   */
  function pinnedIds(reg) {
    const pinned = {};
    const list = reg.pinnedSessionIds;
    if (!Array.isArray(list)) return pinned;
    for (const id of list) pinned[String(id)] = true;
    return pinned;
  }

  /**
   * Whether `target` is STRICTLY inside the DSH home.
   *
   * Defence in depth, not the primary fence: every path this module removes is
   * already constructed from the DSH home plus a validated id or a scanned
   * directory name. It exists so that a future edit, or an unexpected symlink
   * in the scan, can never widen a delete beyond the data directory the plugin
   * claims to own. `path.relative` is used instead of a string prefix test
   * because it is case- and separator-correct on Windows.
   *
   * @param target - a path to test.
   * @returns whether removal of `target` is in scope for this plugin.
   */
  function insideHome(target) {
    let rel;
    try {
      rel = relative(dshHome(), resolve(target));
    } catch (error) {
      return false;
    }
    if (rel === '') return false;
    if (isAbsolute(rel)) return false;
    return rel !== '..' && rel.indexOf('..' + sep) !== 0;
  }

  /**
   * Read one directory, treating "does not exist" as "empty".
   *
   * The `tolerant` flag encodes the rule this module follows: read-only
   * DISCOVERY degrades (an unreadable subtree is skipped so one bad directory
   * cannot block the whole orphan scan), while anything feeding a MUTATION
   * stays strict — a delete must fail loudly rather than silently do nothing
   * because the sessions root could not be listed.
   *
   * @param dir - absolute directory path.
   * @param tolerant - skip an unreadable directory instead of throwing.
   * @returns its `Dirent` entries, or an empty list.
   */
  async function readEntries(dir, tolerant) {
    try {
      return await readdir(dir, { withFileTypes: true });
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') return [];
      if (tolerant) return [];
      throw new Error('could not read ' + dir + ': ' + (error && error.message ? error.message : error));
    }
  }

  /**
   * `stat` that follows symlinks, reporting absence instead of throwing.
   * @param path - absolute path.
   * @returns the `Stats`, or null when nothing is there.
   */
  async function statOrNull(path) {
    try {
      return await stat(path);
    } catch (error) {
      return null;
    }
  }

  /**
   * Recursive byte size of one session directory.
   *
   * Symlinked directories are counted as links, never traversed: a session
   * directory must not be able to make the scan walk the whole filesystem.
   *
   * @param root - absolute directory path.
   * @returns the summed size of the regular files beneath it.
   */
  async function treeSize(root) {
    let total = 0;
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop();
      const entries = await readEntries(dir, true);
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!entry.isFile()) continue;
        const info = await statOrNull(full);
        if (info !== null && info.isFile()) total += info.size;
      }
    }
    return total;
  }

  /**
   * Locate one session's on-disk artifacts.
   * @param id - validated session id.
   * @returns the data paths and projcache files that belong to it.
   */
  async function locate(id) {
    const dirs = [];
    for (const project of await readEntries(sessionsRoot())) {
      if (!project.isDirectory()) continue;
      const candidate = join(sessionsRoot(), project.name, id);
      if ((await statOrNull(candidate)) !== null) dirs.push(candidate);
    }

    const cache = [];
    const cacheDir = cacheRoot();
    for (const entry of await readEntries(cacheDir)) {
      if (!entry.name.startsWith(id + '.json')) continue;
      if (!entry.isFile()) continue;
      cache.push(join(cacheDir, entry.name));
    }

    return { dirs: dirs, cache: cache };
  }

  /**
   * Every session directory on disk, with its size.
   * @returns one `{ id, bytes }` entry per session directory found.
   */
  async function scanSessions() {
    const projects = [];
    for (const entry of await readEntries(sessionsRoot(), true)) {
      if (entry.isDirectory()) projects.push(join(sessionsRoot(), entry.name));
    }

    const found = [];
    for (const project of projects) {
      for (const entry of await readEntries(project, true)) {
        if (!entry.isDirectory()) continue;
        if (entry.name === '' || !SAFE_ID.test(entry.name)) continue;
        found.push({ id: entry.name, dir: join(project, entry.name) });
      }
    }

    const out = new Array(found.length);
    let next = 0;
    async function worker() {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= found.length) return;
        const item = found[index];
        out[index] = { id: item.id, bytes: await treeSize(item.dir) };
      }
    }
    const workers = [];
    const width = Math.min(SCAN_CONCURRENCY, found.length);
    for (let i = 0; i < width; i += 1) workers.push(worker());
    await Promise.all(workers);
    return out;
  }

  /** Ids the archive set currently hides. */
  function archivedIds() {
    const archived = {};
    const reg = registry();
    if (reg === undefined) return archived;
    for (const id of reg.archivedSessionIds) archived[String(id)] = true;
    return archived;
  }

  /** Ids accounted for by at least one workspace. */
  function accountedIds() {
    const accounted = {};
    const reg = registry();
    if (reg === undefined) return accounted;
    for (const workspace of reg.list()) {
      for (const id of workspace.sessionIds) accounted[String(id)] = true;
    }
    return accounted;
  }

  /**
   * Delete the given paths, reporting per-path failures instead of throwing
   * them away.
   * @param paths - absolute paths to remove recursively.
   * @returns how many were removed and the failures that were collected.
   */
  async function removePaths(paths) {
    let removed = 0;
    const failed = [];
    for (const target of paths) {
      const absolute = resolve(target);
      if (!insideHome(absolute)) {
        failed.push(absolute + ': refusing to delete outside the DSH home');
        continue;
      }
      const info = await statOrNull(absolute);
      if (info === null) continue;
      try {
        await rm(absolute, {
          recursive: true,
          force: true,
          maxRetries: RM_MAX_RETRIES,
          retryDelay: RM_RETRY_DELAY_MS,
        });
        removed += 1;
      } catch (error) {
        failed.push(absolute + ': ' + (error && error.message ? error.message : String(error)));
      }
    }
    return { removed: removed, failed: failed };
  }

  /** Reject anything that is not one well-formed session id. */
  function requireId(args) {
    const raw = args !== null && args !== undefined && args.sessionId !== undefined ? String(args.sessionId) : '';
    if (raw === '' || !SAFE_ID.test(raw)) throw new Error('invalid session id');
    return raw;
  }

  /** Titles of the workspaces accounting for one session. */
  function ownersOf(id) {
    const names = [];
    const reg = registry();
    if (reg === undefined) return names;
    for (const workspace of reg.list()) {
      if (workspace.sessionIds.indexOf(id) !== -1) names.push(String(workspace.title));
    }
    return names;
  }

  return {
    /**
     * Report what a delete would touch, without changing anything.
     * @param args - `{ sessionId }`.
     */
    async inspect(args) {
      const id = requireId(args);
      const located = await locate(id);
      return {
        ok: true,
        id: id,
        dirs: located.dirs.length,
        cache: located.cache.length,
        archived: archivedIds()[id] === true,
        owners: ownersOf(id),
      };
    },

    /**
     * Orphan sessions: on disk, hidden by no archive entry and owned by no
     * workspace. This is the `clean-dsh-sessions` orphan definition.
     */
    async orphans() {
      const entries = await scanSessions();
      const archived = archivedIds();
      const accounted = accountedIds();
      const orphans = [];
      for (const entry of entries) {
        if (archived[entry.id] === true) continue;
        if (accounted[entry.id] === true) continue;
        orphans.push(entry);
      }
      return { ok: true, orphans: orphans, scanned: entries.length };
    },

    /**
     * Permanently delete one session: data directory, projcache record, and
     * index entries.
     *
     * ORDER MATTERS for what the user sees, and the three writes are not
     * interchangeable:
     *
     *   1. Detach from Workspace accounting, so no Workspace claims it.
     *   2. Announce it as removed from the Session list, which is the only
     *      signal Session-list consumers act on to drop a row. Without it the
     *      client keeps its boot-time summary and the row survives — and since
     *      step 3 clears the archive flag, that surviving row would be a
     *      "visible" one, landing in the sidebar's ungrouped bucket.
     *   3. Clear the archive entry, so no dangling id is left behind. The
     *      archive set is what hid the session, so this must come AFTER the
     *      list has already dropped it.
     *   4. Remove the data on disk.
     *
     * A brief flash while the writes land is expected and acceptable; what must
     * not happen is the row REMAINING afterwards, or an id being left in the
     * archive set that points at nothing.
     *
     * @param args - `{ sessionId }`.
     */
    async delete(args) {
      const id = requireId(args);
      const steps = [];
      try {
        const located = await locate(id);
        steps.push('found ' + located.dirs.length + ' session data dir(s), ' + located.cache.length + ' projcache record(s)');

        const reg = registry();
        if (reg !== undefined) {
          const detached = [];
          for (const workspace of reg.list()) {
            if (workspace.sessionIds.indexOf(id) === -1) continue;
            await workspace.detachSession(id);
            detached.push(String(workspace.title));
          }
          if (detached.length > 0) steps.push('detached from workspace accounting: ' + detached.join(', '));
        }

        // Drop it from every Session-list consumer before clearing the archive
        // flag, otherwise clearing the flag is what makes the row appear.
        if (emitRemoved !== undefined) {
          emitRemoved(id);
          steps.push('announced api-session/removed');
        }

        // DSH 0.1.7 added a registry-global pin set beside the archive set. An
        // id can outlive its session through either, so both are cleared. Unpin
        // needs no existence check and is a no-op for an unpinned id. Pins
        // order the list; they hide nothing, so this cannot make a row appear.
        if (reg !== undefined && pinnedIds(reg)[id] === true) {
          await reg.unpinSession(id);
          steps.push('removed from pinnedSessionIds');
        }

        if (reg !== undefined && reg.archivedSessionIds.indexOf(id) !== -1) {
          await reg.unarchiveSession(id);
          steps.push('removed from archivedSessionIds');
        }

        const removal = await removePaths(located.dirs.concat(located.cache));
        steps.push('deleted ' + removal.removed + ' path(s)');
        if (removal.failed.length > 0) {
          return { ok: false, error: 'some paths could not be removed: ' + toList(removal.failed).join(' | '), steps: steps };
        }
        return { ok: true, id: id, steps: steps };
      } catch (error) {
        return { ok: false, error: String(error && error.message ? error.message : error), steps: steps };
      }
    },
  };
}
