# dsh-archived-session-delete

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai) plugin for the web Settings
dialog: the **Archived sessions** page gains a permanent **Delete** action per
row, and **orphan sessions** can be scanned and deleted too.

DSH otherwise has no session delete — archiving only hides a session, and the
GUI's only "Delete" removes a *workspace registration* while keeping every
session log.

**Deletion is permanent. There is no Recycle Bin.**

## Install

```sh
dsh plugin --profile web add github:mathangler/dsh-archived-session-delete
```

Restart the profile, then open Settings → **Archived sessions**.

To update:

```sh
dsh plugin --profile web update dsh-archived-session-delete
```

DSH targets `0.1.5-rc.1`.

## What a delete removes

Per session, matching the `clean-dsh-sessions` skill:

| Target | Location |
|---|---|
| Session data directory | `<dshHome>/sessions/<project-dir>/<id>/` |
| Cache record | `<dshHome>/storages/session_projcache/sessions/<id>.json*` |
| Index entries | `global.archivedSessionIds`, `tables.workspaces[*].sessionIds` |

**Orphan sessions** are on-disk session directories that no workspace owns and
no archive entry hides. The scan walks every session directory, so it runs on
demand from a **Scan** button rather than automatically.

## How it behaves

Every row offers **Unarchive** and **Delete**. Delete asks for an in-row
confirmation first; the confirm and cancel buttons occupy the same two
fixed-width slots as the buttons they replace, so the pointer target does not
move between the two clicks. The result then appears on that same row — green on
success, red on failure — and a successful row retires about two seconds later.
Nothing outside the operated row moves at any point.

## Implementation notes

- **Index pruning goes through the live registry**, not the file. The running
  Host holds `workspace.json` in memory and rewrites it wholesale on its next
  mutation, so editing that file is silently reverted. The host half prunes via
  `workspaceRegistry.unarchiveSession` and `Workspace.detachSession`.
- **Detach precedes unarchive.** The grouped session list shows a session when a
  workspace owns it *and* it is not archived, so unarchiving first would make the
  session briefly visible. Both writes are idempotent and touch independent
  records, so the final state is the same either way; the order only prevents
  that intermediate frame from being renderable.
- **Results render from a client-owned snapshot at the row's remembered index**,
  because the delete removes the row from the stores as part of the same call.
- **The section is taken over, not extended.** The shipped Archived-sessions
  component renders no child slot, so a row action requires re-registering its
  id. A `list` slot rejects a duplicate id at the same priority, and the shipped
  page registers the same id — so this package registers at `priority: -1`,
  which is the platform's endorsed way to shadow a cell.
- **Transport.** One JSON route (`/archived-session-delete`) on the
  composition's `webServer`, fenced by `connection.requestRejection(req)`
  before any body read. Business failures ride the 200 envelope; only transport
  faults use 4xx/5xx.

## Development

`tools/` holds the verification scripts and is excluded from the published
package. See [tools/README.md](tools/README.md).

When working from a local checkout, install with `file:` instead — it is linked,
so edits apply without reinstalling. `file:` and `github:` specs replace each
other, so switch back before verifying a release.

## License

MIT
