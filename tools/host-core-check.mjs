/**
 * host-core-check.mjs — cross-platform behaviour check for `lib/host-core.js`.
 *
 * Builds a synthetic DSH home in the OS temp directory with the real on-disk
 * layout, then drives the three endpoints through the very same
 * `createHandlers()` the host half uses. No shell, no PowerShell, no browser.
 *
 * Why this exists: the first revision of this plugin emitted PowerShell text
 * and ran it through `ctx.shell`. That works only on Windows, because the seam
 * is `pwsh -Command` on win32 and `bash -c` everywhere else — so on macOS and
 * Linux every call failed with `bash: =: command not found`. This script fails
 * loudly if that class of bug ever returns, and it runs on all three platforms.
 *
 * Usage:
 *   node tools/host-core-check.mjs
 *
 * Exits 0 when every assertion holds, 1 otherwise.
 */
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  chmodSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createHandlers } from '../lib/host-core.js';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'lib', 'host-core.js'), 'utf8');
// Comments explain the old bug and therefore NAME it; strip them so this check
// tests the executable code, not the prose that documents the regression.
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log('  ok   ' + label);
    return;
  }
  failures += 1;
  console.log('  FAIL ' + label + (detail === undefined ? '' : ' — ' + detail));
}

/**
 * A workspace-registry double with the surface host-core actually reads.
 * `pinned` is optional: omitting it models a runtime older than DSH `0.1.7`,
 * which has no pin set at all, so the same double covers both versions.
 */
function fakeRegistry(archived, workspaces, pinned) {
  const list = workspaces.map((entry) => ({
    title: entry.title,
    sessionIds: entry.sessionIds.slice(),
    async detachSession(id) {
      const at = this.sessionIds.indexOf(id);
      if (at !== -1) this.sessionIds.splice(at, 1);
    },
  }));
  const reg = {
    archivedSessionIds: archived.slice(),
    list() {
      return list;
    },
    async unarchiveSession(id) {
      const at = this.archivedSessionIds.indexOf(id);
      if (at !== -1) this.archivedSessionIds.splice(at, 1);
    },
  };
  if (pinned !== undefined) {
    reg.pinnedSessionIds = pinned.slice();
    reg.unpinSession = async function (id) {
      const at = this.pinnedSessionIds.indexOf(id);
      if (at !== -1) this.pinnedSessionIds.splice(at, 1);
    };
  }
  return reg;
}

/**
 * A storage-domain double exposing the one path host-core uses: the
 * `session_projcache` domain's `sessions` table. `delete` evicts the record and
 * reports whether one was there, like `KvTable.delete`.
 */
function fakeStorageDomain(records) {
  const table = {
    delete(key) {
      if (!records.has(key)) return Promise.resolve(false);
      records.delete(key);
      return Promise.resolve(true);
    },
  };
  return {
    get(name) {
      if (name !== 'session_projcache') return undefined;
      return { table: (target) => (target === 'sessions' ? table : undefined) };
    },
  };
}

/** A live-session store double: only `get`, which is all the probe reads. */
function fakeSessionStore(liveIds) {
  const present = {};
  for (const id of liveIds) present[id] = { id };
  return { get: (id) => present[id] };
}

const home = mkdtempSync(join(tmpdir(), 'asdel-check-'));
const PROJECT = '--Users-someone-project--';
const LIVE = 'session-11111111-1111-4111-8111-111111111111';
const ARCHIVED = 'session-22222222-2222-4222-8222-222222222222';
const ORPHAN = 'session-33333333-3333-4333-8333-333333333333';

function plant(id, bytes) {
  const dir = join(home, 'sessions', PROJECT, id);
  mkdirSync(join(dir, 'sub'), { recursive: true });
  writeFileSync(join(dir, 'session.jsonl'), 'x'.repeat(bytes));
  writeFileSync(join(dir, 'sub', 'blob.bin'), 'y'.repeat(16));
  writeFileSync(join(home, 'storages', 'session_projcache', 'sessions', id + '.json'), '{}');
  return dir;
}

console.log('host-core-check on ' + process.platform + ' (path separator ' + JSON.stringify(sep) + ')');

try {
  mkdirSync(join(home, 'sessions', PROJECT), { recursive: true });
  mkdirSync(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true });

  const liveDir = plant(LIVE, 1000);
  const archivedDir = plant(ARCHIVED, 2000);
  const orphanDir = plant(ORPHAN, 33);
  writeFileSync(join(home, 'storages', 'session_projcache', 'sessions', ORPHAN + '.json.tmp'), '{}');

  const registry = fakeRegistry([ARCHIVED], [
    { title: 'alpha', sessionIds: [LIVE] },
    { title: 'beta', sessionIds: [ARCHIVED] },
  ]);

  let removedAnnouncements = [];
  // The projection cache is write-behind: its record lives in the domain's
  // in-memory table and the file is only the durable image. Seed the record so
  // the delete has to evict it through the domain rather than the file.
  const projectionRecords = new Map([[ARCHIVED, { checkpoint: 'seeded' }]]);
  const projectionDomain = fakeStorageDomain(projectionRecords);
  const liveStore = fakeSessionStore([ARCHIVED]);
  const handlers = createHandlers(
    {
      get: (name) => {
        if (name === 'workspaceRegistry') return registry;
        if (name === 'storageDomain') return projectionDomain;
        if (name === 'sessions') return liveStore;
        return undefined;
      },
    },
    { dshHome: home, emitRemoved: (id) => removedAnnouncements.push(id) },
  );

  // --- source hygiene: the PowerShell transport must not come back ---------
  console.log('\nsource hygiene');
  check('no PowerShell invocation left in host-core.js', !/Get-ChildItem|Remove-Item|ConvertTo-Json|pwsh/i.test(code));
  check('no hardcoded backslash path joiner left', !/'\\\\\\\\'/.test(code) && !/\+ '\\\\\\\\' \+/.test(code));
  check('no shell dependency left in host-core.js', !/ctx\.get\('shell'\)/.test(code));

  // --- inspect -------------------------------------------------------------
  console.log('\ninspect');
  const inspected = await handlers.inspect({ sessionId: ARCHIVED });
  check('reports the planted data dir', inspected.dirs === 1, JSON.stringify(inspected));
  check('reports the planted cache record', inspected.cache === 1, JSON.stringify(inspected));
  check('reports the archive flag', inspected.archived === true);
  check('reports the owning workspace title', inspected.owners.join(',') === 'beta');
  check('rejects a malformed session id', await handlers.inspect({ sessionId: '../etc' }).then(() => false, () => true));

  // --- orphans -------------------------------------------------------------
  console.log('\norphans');
  const found = await handlers.orphans();
  check('scans every session directory', found.scanned === 3, 'scanned=' + found.scanned);
  check('hides an archived session from the orphan list', found.orphans.every((o) => o.id !== ARCHIVED));
  check('hides a workspace-accounted session', found.orphans.every((o) => o.id !== LIVE));
  check('finds the untracked session', found.orphans.some((o) => o.id === ORPHAN), JSON.stringify(found.orphans));
  const orphan = found.orphans.find((o) => o.id === ORPHAN);
  check('sizes the tree recursively', orphan !== undefined && orphan.bytes === 33 + 16, 'bytes=' + (orphan && orphan.bytes));

  // --- delete: a normal archived session ----------------------------------
  console.log('\ndelete (archived session)');
  const archivedDelete = await handlers.delete({ sessionId: ARCHIVED });
  check('reports success', archivedDelete.ok === true, JSON.stringify(archivedDelete));
  check('announces api-session/removed exactly once', removedAnnouncements.join(',') === ARCHIVED);
  check('removes the data directory', !existsSync(archivedDir));
  check('removes the projcache record', !existsSync(join(home, 'storages', 'session_projcache', 'sessions', ARCHIVED + '.json')));
  check('drops the archive entry', registry.archivedSessionIds.indexOf(ARCHIVED) === -1);
  check('detaches from workspace accounting', registry.list().every((w) => w.sessionIds.indexOf(ARCHIVED) === -1));

  // --- projection cache: evicted through its domain, not by deleting the file
  // Deleting only the file used to leave the in-memory record, so the next
  // write-back recreated it and the deletion came undone.
  console.log('\nprojection record (write-behind cache)');
  check('evicts the record through the storage domain', projectionRecords.has(ARCHIVED) === false);
  check(
    'reports the eviction step',
    archivedDelete.steps.some((s) => String(s).indexOf('storageDomain') !== -1),
    JSON.stringify(archivedDelete.steps),
  );
  check('reports the session as still live', archivedDelete.live === true, JSON.stringify(archivedDelete));

  // --- pin set: DSH 0.1.7's second registry-global id set -----------------
  // Same double, now carrying a pin set. An id must not survive in EITHER set.
  // ARCHIVED is already deleted above, so re-deleting it here touches no other
  // test; ORPHAN is left intact for the orphan case below.
  console.log('\npin set (DSH 0.1.7)');
  const pinnedRegistry = fakeRegistry([], [], [ARCHIVED, ORPHAN]);
  const pinnedHandlers = createHandlers(
    { get: (name) => (name === 'workspaceRegistry' ? pinnedRegistry : undefined) },
    { dshHome: home, emitRemoved: () => {} },
  );
  const pinnedDelete = await pinnedHandlers.delete({ sessionId: ARCHIVED });
  const pinnedSteps = Array.isArray(pinnedDelete.steps) ? pinnedDelete.steps : [];
  check('unpins the deleted session', pinnedRegistry.pinnedSessionIds.indexOf(ARCHIVED) === -1, JSON.stringify(pinnedRegistry.pinnedSessionIds));
  check('leaves an unrelated pin alone', pinnedRegistry.pinnedSessionIds.indexOf(ORPHAN) !== -1);
  check('reports the unpin step', pinnedSteps.some((s) => String(s).indexOf('pinnedSessionIds') !== -1), JSON.stringify(pinnedDelete));

  // A runtime older than 0.1.7 has no pin set at all: the delete must still
  // work rather than throwing on the missing property.
  console.log('\npin set absent (pre-0.1.7 runtime)');
  const legacyRegistry = fakeRegistry([ARCHIVED], []);
  const legacyHandlers = createHandlers(
    { get: (name) => (name === 'workspaceRegistry' ? legacyRegistry : undefined) },
    { dshHome: home, emitRemoved: () => {} },
  );
  const legacyDelete = await legacyHandlers.delete({ sessionId: ARCHIVED });
  const legacySteps = Array.isArray(legacyDelete.steps) ? legacyDelete.steps : [];
  check('deletes without a pin set present', legacyDelete.ok === true, JSON.stringify(legacyDelete));
  check('drops the archive entry without a pin set', legacyRegistry.archivedSessionIds.indexOf(ARCHIVED) === -1);
  check('reports no unpin step', !legacySteps.some((s) => String(s).indexOf('pinnedSessionIds') !== -1));

  // --- degradation: no storage domain and no live store -------------------
  // A cached record is a cache, not truth, so failing to evict it must not fail
  // the delete; and a composition without a live store must read as "not live"
  // rather than throwing.
  console.log('\ndegradation (no storageDomain / no sessions service)');
  const bareRegistry = fakeRegistry([ARCHIVED], []);
  const bareHandlers = createHandlers(
    { get: (name) => (name === 'workspaceRegistry' ? bareRegistry : undefined) },
    { dshHome: home, emitRemoved: () => {} },
  );
  const bareDelete = await bareHandlers.delete({ sessionId: ARCHIVED });
  const bareSteps = Array.isArray(bareDelete.steps) ? bareDelete.steps : [];
  check('deletes without a storage domain present', bareDelete.ok === true, JSON.stringify(bareDelete));
  check('reports not-live when no live store exists', bareDelete.live === false, JSON.stringify(bareDelete));
  check('reports no eviction step', !bareSteps.some((s) => String(s).indexOf('storageDomain') !== -1));

  // --- delete: an orphan, including its `.json.tmp` sibling ---------------
  console.log('\ndelete (orphan session)');
  const orphanDelete = await handlers.delete({ sessionId: ORPHAN });
  check('reports success', orphanDelete.ok === true, JSON.stringify(orphanDelete));
  check('removes the orphan data directory', !existsSync(orphanDir));
  check('removes the whole <id>.json* family', !existsSync(join(home, 'storages', 'session_projcache', 'sessions', ORPHAN + '.json.tmp')));

  // --- delete: an unknown id is a no-op, not an error ---------------------
  console.log('\ndelete (unknown id)');
  const missing = await handlers.delete({ sessionId: 'session-99999999-9999-4999-8999-999999999999' });
  check('succeeds without touching anything', missing.ok === true, JSON.stringify(missing));
  check('reports zero removed paths', /deleted 0 path\(s\)/.test(missing.steps.join(' | ')), missing.steps.join(' | '));

  // --- degradation rule: a scan survives what a delete must report --------
  // Read-only discovery skips an unreadable subtree; a mutation stays strict.
  console.log('\ndegradation rule');
  const DENIED = 'session-66666666-6666-4666-8666-666666666666';
  const deniedDir = plant(DENIED, 64);
  const locked = join(deniedDir, 'locked');
  mkdirSync(locked);
  writeFileSync(join(locked, 'unreadable.bin'), 'z'.repeat(4096));
  chmodSync(locked, 0o000);
  let trulyDenied = false;
  try {
    readdirSync(locked);
  } catch (error) {
    trulyDenied = true;
  }
  if (!trulyDenied) {
    console.log('  skip unreadable-subtree case — this platform/user still reads mode 000');
  } else {
    const scanWithDenied = await handlers.orphans();
    const deniedOrphan = scanWithDenied.orphans.find((o) => o.id === DENIED);
    check('the scan lists the session despite the locked subtree', deniedOrphan !== undefined);
    // plant() writes exactly 64 + 16 readable bytes; the locked 4096 are skipped.
    check('the scan still counted the readable bytes', deniedOrphan !== undefined && deniedOrphan.bytes === 80, 'bytes=' + (deniedOrphan && deniedOrphan.bytes));
  }
  chmodSync(locked, 0o700);
  const deniedDelete = await handlers.delete({ sessionId: DENIED });
  check('the delete removes the locked subtree too', deniedDelete.ok === true && !existsSync(deniedDir), JSON.stringify(deniedDelete));

  // --- containment: a symlinked session dir never deletes its target ------
  console.log('\ncontainment');
  const outside = mkdtempSync(join(tmpdir(), 'asdel-outside-'));
  const outsideFile = join(outside, 'keep.txt');
  writeFileSync(outsideFile, 'keep');
  const LINKED = 'session-44444444-4444-4444-8444-444444444444';
  const linkPath = join(home, 'sessions', PROJECT, LINKED);
  let symlinked = false;
  try {
    symlinkSync(outside, linkPath, 'junction');
    symlinked = true;
  } catch (error) {
    console.log('  skip symlink case — this platform refused to create the link: ' + error.code);
  }
  if (symlinked) {
    const linkedDelete = await handlers.delete({ sessionId: LINKED });
    check('the symlinked session entry is removed', linkedDelete.ok === true && !existsSync(linkPath), JSON.stringify(linkedDelete));
    check('the file the symlink pointed at survives', existsSync(outsideFile));
  }
  rmSync(outside, { recursive: true, force: true });
} finally {
  rmSync(home, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nall checks passed' : '\n' + failures + ' check(s) failed');
process.exit(failures === 0 ? 0 : 1);
