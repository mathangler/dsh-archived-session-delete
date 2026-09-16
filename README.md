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

- DSH `0.1.6-alpha.1`
- Node.js `>=20`
- The `web` profile (this plugin ships a browser half)

Verified on DSH `0.1.6-alpha.1`, pnpm `12.4.1`.

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
move between the two clicks. The result then appears on that same row — green on
success, red on failure — and a successful row retires about two seconds later.
Nothing outside the operated row moves at any point.

Below the list, **Orphan sessions** is separated by a divider and offers a
**Scan** button. The scan walks every session directory, so it runs on demand
rather than automatically.

### What a delete removes

Per session, matching the `clean-dsh-sessions` skill:

| Target | Location |
|---|---|
| Session data directory | `<dshHome>/sessions/<project-dir>/<id>/` |
| Cache record | `<dshHome>/storages/session_projcache/sessions/<id>.json*` |
| Index entries | `global.archivedSessionIds`, `tables.workspaces[*].sessionIds` |

**Orphan sessions** are on-disk session directories that no workspace owns and
no archive entry hides — what deleted projects and deleted sessions leave behind.

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
- **Results render from a client-owned snapshot at the row's remembered index**,
  because the delete removes the row from the stores as part of the same call.
- **The section is taken over, not extended.** The shipped Archived-sessions
  component renders no child slot, so a row action requires re-registering its
  id. A `list` slot rejects a duplicate id at the same priority, and the shipped
  page registers the same id — so this package registers at `priority: -1`,
  the platform's endorsed way to shadow a cell.
- **Transport.** One JSON route (`/archived-session-delete`) on the
  composition's `webServer`, fenced by `connection.requestRejection(req)`
  before any body read. Business failures ride the 200 envelope; only transport
  faults use 4xx/5xx.

## Known limitations

- **Permanent by design.** No undo, no Recycle Bin, no dry-run.
- **Orphan detection is on demand**, not a background sweep.
- **The shipped page is replaced, not extended** (see above), so this package
  reimplements that list. A DSH upgrade that changes how the Settings shell
  builds its navigation could require revisiting the duplicate-row handling.

## Development

`tools/` holds the verification scripts and is excluded from the published
package — see [tools/README.md](tools/README.md).

Working from a local checkout, install with `file:` instead; it is linked, so
edits apply without reinstalling. `file:` and `github:` specs replace each
other, so switch back to `github:` before verifying a release.

## License

MIT — see [LICENSE](LICENSE).
