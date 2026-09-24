# dsh-archived-session-delete

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai) plugin for the web Settings
dialog: the **Archived sessions** page gains a permanent **Delete** action per
row, and **orphan sessions** can be scanned and deleted too.

DSH otherwise has no session delete — archiving only hides a session, and the
GUI's only "Delete" removes a *workspace registration* while keeping every
session log.

> **Deletion is permanent.** There is no Recycle Bin, no undo, and no dry-run.

## Requirements

- DSH `0.1.7-alpha.1`
- Node.js `>=20`
- The `web` profile (this plugin ships a browser half)
- **Windows, macOS or Linux** — no PowerShell/`pwsh` and no POSIX shell is
  required (see [Platform support](#platform-support))

Verified on DSH `0.1.7-alpha.1`, pnpm `12.4.1`.

## Install

```sh
dsh plugin --profile web add github:mathangler/dsh-archived-session-delete
```

Restart the profile, then open **Settings → Archived sessions**.

`dsh plugin` forwards to pnpm inside the profile directory, and DSH folds any
dependency declaring `dsh.bundle.patch` into `dsh.profile.bundles`
automatically — no config edit needed.

## Update

```sh
dsh plugin --profile web update dsh-archived-session-delete
```

`update` re-resolves the `github:` spec and moves to the newest commit
(verified: `5465cd8` → `62c56c1` → `4e3db86`, and a second run reports
"Already up to date"). Restart the profile afterwards.

If an `update` ever appears to be a no-op — for example after re-tagging or
force-pushing — fall back to reinstalling the spec:

```sh
dsh plugin --profile web remove dsh-archived-session-delete
dsh plugin --profile web add github:mathangler/dsh-archived-session-delete
```

## Uninstall

```sh
dsh plugin --profile web remove dsh-archived-session-delete
```

Restart the profile. Removing the row removes its route and its Settings page;
nothing else about the composition changes. **Sessions already deleted stay
deleted** — uninstalling does not bring them back.

## Usage

Each archived row offers **Unarchive** and **Delete**. Delete asks for an
in-row confirmation first: the confirm and cancel buttons occupy the same two
fixed-width slots as the buttons they replace, so the pointer target does not
move between the two clicks. The row leaves only once the host confirms, and a
failure leaves it exactly where it is, back at its idle buttons.

Results are reported in a **notice area pinned to the bottom of the panel**, one
message at a time: success and scan outcomes dismiss themselves after three
seconds and offer a close button, while a failure stays until you close it or the
next notice replaces it. The notice is the section's last child, so it is added
*after* every row rather than pushing one down — **no row ever moves because a
result was reported**. The area is an `aria-live` region.

Below the list, **Orphan sessions** is separated by a divider and offers a
**Scan** button. The scan walks every session directory, so it runs on demand
rather than automatically, and reports its outcome in the same notice area.

### What a delete removes

Per session, matching the `clean-dsh-sessions` skill:

| Target | Location |
|---|---|
| Session data directory | `<dshHome>/sessions/<project-dir>/<id>/` |
| Cache record | `<dshHome>/storages/session_projcache/sessions/<id>.json*` |
| Index entries | `global.archivedSessionIds`, `tables.workspaces[*].sessionIds` |

**Orphan sessions** are on-disk session directories that no workspace owns and
no archive entry hides — what deleted projects and deleted sessions leave behind.

## Platform support

Windows, macOS and Linux are supported by one code path. The host half does its
filesystem work with `node:fs` and builds every path with `node:path`, so the
separator, the encoding and the delete semantics come from the runtime platform
rather than from a generated script.

This was not always true. Up to `0.1.5` the host half assembled **PowerShell**
scripts and ran them through `ctx.shell`. That seam is not a PowerShell seam:
`@deepseek-ai/dsh-shell` is an *abstract bash executor*, and the host composes
exactly one provider —

| Platform | Provider | What actually ran |
|---|---|---|
| Windows (`win32`) | `@deepseek-ai/dsh-pwsh-*` | `pwsh -NoLogo -NoProfile -NonInteractive -Command <script>` |
| macOS (`darwin`), Linux | `@deepseek-ai/dsh-bash-*` | `bash -c <script>` |

So on macOS and Linux the PowerShell text was handed to bash, which answered
`bash: =: command not found` and `syntax error near unexpected token '('` and
exited non-zero. Every operation failed with *"could not locate the session on
disk"* (or *"could not scan session directories"*). Two smaller Windows-only
assumptions failed for the same reason: a hardcoded `'\\'` path joiner produced
`~/.dsh\sessions` — a legal filename on POSIX, not a directory — and the
`cacheRoot` was spelled with backslashes.

`0.2.0` removes the shell dependency entirely. `ctx.shell` is no longer injected
and the composition needs nothing but `webServer` and `connection`.

## Implementation notes

- **Index pruning goes through the live registry**, not the file. The running
  Host holds `workspace.json` in memory and rewrites it wholesale on its next
  mutation, so editing that file is silently reverted. The host half prunes via
  `workspaceRegistry.unarchiveSession` and `Workspace.detachSession`.
- **The delete writes happen in a specific order**, and it is load-bearing:
  1. detach from Workspace accounting, 2. announce `api-session/removed`,
  3. clear the archive entry, 4. remove the data.

  Two separate traps explain it. The grouped list shows a session when a
  workspace owns it *and* it is not archived — but the **ungrouped** bucket keys
  on the opposite (not owned), so detaching alone would relocate the row rather
  than hide it. And the archive set is what *hides* a session everywhere, so
  clearing it while the browser still holds the session's summary makes the row
  appear. `api-session/removed` is the platform's own signal for "this session
  is gone" (the shipped Session controller emits it from `session/disposed`, and
  the browser side answers it with `handleSessionRemoved`), so announcing it
  before step 3 is what lets the row leave the sidebar. A brief flash while the
  writes land is expected; a row that *remains*, or a cleared archive entry
  pointing at nothing, is not.
- **Nothing is ever rendered INTO a list.** Each list is a plain projection of
  its source filtered by the search box, so a row's position is a function of
  that source order alone. An earlier revision painted the operated row (and its
  result) into the list from a client-owned snapshot, re-inserted at a
  remembered index — and that index was measured against a list that still
  contained the deleted row. The next interaction then captured a position that
  no longer existed, so a second delete landed its row one slot off. Removing
  the remembered index, the snapshot re-insertion and the lingering window
  removes the whole class: there is no second writer that could disagree about
  where a row goes. `tools/orphan-path-check.mjs` drives exactly that reported
  sequence and fails on the old build.
- **Every registry-global id set is pruned, and a missing one degrades quietly.**
  DSH `0.1.7` added `pinnedSessionIds` beside `archivedSessionIds`, giving an id
  a second way to outlive its session; the delete clears whichever set holds it,
  so neither can keep a pointer to a session that no longer exists. A runtime
  with no pin set reads as "nothing is pinned" rather than throwing, which is
  how one package covers `0.1.7` and earlier without a version check.
- **This package owns the `archived-sessions` section id.** On DSH `0.1.7` no
  shipped package provides that page, so the section is this package's alone;
  the platform still maps that id to the archive nav icon in the Settings shell,
  which is why the id is kept rather than invented. On `0.1.6` the shipped
  Archived-sessions page did register it, so this package registers at
  `priority: -1` (the platform's endorsed way to shadow a cell) and carries a
  small dedup that retires a second nav row for the same label. Both are
  retained: harmless on `0.1.7`, and they keep the delete action mounted if a
  future release restores a shipped page for this id.
- **Transport.** One JSON route (`/archived-session-delete`) on the
  composition's `webServer`, fenced by `connection.requestRejection(req)`
  before any body read. Business failures ride the 200 envelope; only transport
  faults use 4xx/5xx.
- **Filesystem work lives in `lib/host-core.js` on `node:fs`.** That module is
  transport-free and platform-free, which keeps the HTTP adapter a thin,
  auditable shim and lets the delete rules be exercised with no browser, no
  shell and no DSH process (see [Development](#development)). Removals are
  confined to the DSH home, symlinked directories are counted but never
  traversed, and `fs.rm` removes a symlink rather than what it points at.

## Known limitations

- **Permanent by design.** No undo, no Recycle Bin, no dry-run.
- **Orphan detection is on demand**, not a background sweep.
- **Session-list leftovers.** Removing a session's data does not by itself evict
  it from the browser's in-memory Session list; that is why the delete announces
  `api-session/removed`. A page reload re-reads the list from the Host, so a
  deleted session can briefly reappear in the sidebar's ungrouped bucket until
  the next refresh — a known, reported rough edge rather than a data problem.

## Development

`tools/` holds the verification scripts and is excluded from the published
package — see [tools/README.md](tools/README.md). From a checkout, `npm run
check` runs the host-core and HTTP-route suites.

Working from a local checkout, install with `file:` instead; it is linked, so
edits apply without reinstalling. `file:` and `github:` specs replace each
other, so switch back to `github:` before verifying a release.

## License

MIT — see [LICENSE](LICENSE).
