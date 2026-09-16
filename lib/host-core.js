/**
 * archived-session-delete — transport-free business logic.
 *
 * This module owns the deletion semantics and never touches `req`/`res`. It is
 * deliberately separated from `index.js` so the rules can be unit-tested in
 * plain Node with an injected command runner, and so the HTTP adapter stays a
 * thin, auditable shim.
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

/** Session ids are opaque but must never reach a shell command unquoted. */
const SAFE_ID = /^[A-Za-z0-9_$.-]+$/;

/** PowerShell single-quoted literal; embedded quotes are doubled. */
function psString(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

/** PowerShell array literal of quoted strings. */
function psArray(values) {
  return '@(' + values.map(psString).join(',') + ')';
}

/** Join a base directory and a child without doubling separators. */
function joinPath(base, leaf) {
  return String(base).replace(/[\\/]+$/, '') + '\\' + String(leaf);
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

/**
 * Build the method map over the live runtime.
 *
 * @param ctx - the plugin's Cordis context (used only through optional reads).
 * @param options - injected collaborators.
 * @param options.dshHome - absolute DSH home directory.
 * @param options.runPowerShell - `(script, timeoutMs) => Promise<{code,out,err}>`.
 * @returns the method map keyed by endpoint name.
 */
export function createHandlers(ctx, options) {
  const dshHome = options.dshHome;
  const runPowerShell = options.runPowerShell;
  const sessionsRoot = joinPath(dshHome, 'sessions');
  const cacheRoot = joinPath(dshHome, 'storages\\session_projcache\\sessions');

  /** The workspace registry, read optionally so a composition without it degrades. */
  function registry() {
    return ctx.get('workspaceRegistry');
  }

  /** Run a PowerShell script through the injected runner. */
  async function exec(script, timeoutMs) {
    return await runPowerShell(script, timeoutMs);
  }

  /**
   * Locate one session's on-disk artifacts.
   * @param id - validated session id.
   * @returns the data directories and projcache files that belong to it.
   */
  async function locate(id) {
    const script = [
      '$ErrorActionPreference = "SilentlyContinue"',
      '$id = ' + psString(id),
      '$root = ' + psString(sessionsRoot),
      '$dirs = @(Get-ChildItem -LiteralPath $root -Directory | ForEach-Object { Join-Path $_.FullName $id } | Where-Object { Test-Path -LiteralPath $_ })',
      '$cache = @(Get-ChildItem -LiteralPath ' + psString(cacheRoot) + ' -File -Filter ($id + ".json*") | ForEach-Object { $_.FullName })',
      '[pscustomobject]@{ dirs = $dirs; cache = $cache } | ConvertTo-Json -Compress -Depth 4',
    ].join('\n');
    const result = await exec(script, 60000);
    if (result.code !== 0) {
      throw new Error('could not locate the session on disk: ' + (result.err !== '' ? result.err : result.out));
    }
    const text = String(result.out).trim();
    if (text === '') return { dirs: [], cache: [] };
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error('could not read the session location: ' + text);
    }
    return { dirs: toList(parsed.dirs), cache: toList(parsed.cache) };
  }

  /**
   * Every session directory on disk, with its size.
   * @returns one `{ id, bytes }` entry per directory found.
   */
  async function scanSessions() {
    const script = [
      '$ErrorActionPreference = "SilentlyContinue"',
      '$root = ' + psString(sessionsRoot),
      '$out = @()',
      'Get-ChildItem -LiteralPath $root -Directory | ForEach-Object {',
      '  Get-ChildItem -LiteralPath $_.FullName -Directory | ForEach-Object {',
      '    $bytes = 0',
      '    $sum = (Get-ChildItem -LiteralPath $_.FullName -Recurse -File | Measure-Object -Property Length -Sum).Sum',
      '    if ($sum) { $bytes = [int64]$sum }',
      '    $out += [pscustomobject]@{ id = $_.Name; bytes = $bytes }',
      '  }',
      '}',
      'ConvertTo-Json -Compress -Depth 4 -InputObject @($out)',
    ].join('\n');
    const result = await exec(script, 120000);
    if (result.code !== 0) {
      throw new Error('could not scan session directories: ' + (result.err !== '' ? result.err : result.out));
    }
    const text = String(result.out).trim();
    if (text === '') return [];
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error('could not read the session scan: ' + text);
    }
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    const out = [];
    for (const entry of entries) {
      if (entry === null || entry === undefined || entry.id === undefined) continue;
      const id = String(entry.id);
      if (id === '' || !SAFE_ID.test(id)) continue;
      out.push({ id: id, bytes: Number(entry.bytes) || 0 });
    }
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
    if (paths.length === 0) return { removed: 0, failed: [] };
    const script = [
      '$ErrorActionPreference = "Continue"',
      '$failed = @()',
      '$removed = 0',
      psArray(paths) + ' | ForEach-Object {',
      '  if (-not (Test-Path -LiteralPath $_)) { return }',
      '  try { Remove-Item -LiteralPath $_ -Recurse -Force -ErrorAction Stop; $removed++ }',
      '  catch { $failed += ($_ | Out-String).Trim() }',
      '}',
      '[pscustomobject]@{ removed = $removed; failed = $failed } | ConvertTo-Json -Compress -Depth 4',
    ].join('\n');
    const result = await exec(script, 180000);
    if (result.code !== 0) {
      throw new Error('the delete command failed: ' + (result.err !== '' ? result.err : result.out));
    }
    const text = String(result.out).trim();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error('the delete command reported no result: ' + text);
    }
    return { removed: Number(parsed.removed) || 0, failed: toList(parsed.failed) };
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
        if (options.emitRemoved !== undefined) {
          options.emitRemoved(id);
          steps.push('announced api-session/removed');
        }

        if (reg !== undefined && reg.archivedSessionIds.indexOf(id) !== -1) {
          await reg.unarchiveSession(id);
          steps.push('removed from archivedSessionIds');
        }

        const removal = await removePaths(located.dirs.concat(located.cache));
        steps.push('deleted ' + removal.removed + ' path(s)');
        if (removal.failed.length > 0) {
          return { ok: false, error: 'some paths could not be removed: ' + removal.failed.join(' | '), steps: steps };
        }
        return { ok: true, id: id, steps: steps };
      } catch (error) {
        return { ok: false, error: String(error && error.message ? error.message : error), steps: steps };
      }
    },
  };
}
