---
description: "Archived-session management for the DSH web Settings dialog: a permanent Delete action on every archived session, plus a scan-and-delete group for orphan sessions."
kind: "package-reference"
---

# dsh-archived-session-delete

English | [中文](README.zh.md)

## Summary

DSH has no session delete. The GUI/CLI/API only **archive** a session (append its
id to `global.archivedSessionIds`), and the only "Delete" removes a **workspace
registration** while explicitly keeping every session log. Nothing removes
`sessions/<project-dir>/<id>/` or `storages/session_projcache/sessions/<id>.json`.

This plugin adds that capability to the Settings dialog. It takes over the
shipped **Archived sessions** page and gives every row a permanent Delete
action, and it can also scan for and delete **orphan sessions** — on-disk
session directories that no workspace references and no archive entry hides.

Deletion is **permanent**. There is no Recycle Bin and no backup copy.

## What it removes

Per session, matching the `clean-dsh-sessions` skill for one session:

| Target | Location |
|---|---|
| Session data directory | `<dshHome>/sessions/<project-dir>/<id>/` |
| Cache record | `<dshHome>/storages/session_projcache/sessions/<id>.json*` |
| Index entries | `global.archivedSessionIds` and `tables.workspaces[*].sessionIds` |

## Use this package

```sh
dsh plugin --profile web add github:mathangler/dsh-archived-session-delete
```

Then **restart the Profile** so the new row is composed, and open Settings →
**Archived sessions**.

> Updating an already-installed copy needs `remove` then `add`: pnpm skips
> resolution when the spec is unchanged, so a plain `add` would keep the old
> commit.
>
> ```sh
> dsh plugin --profile web remove dsh-archived-session-delete
> dsh plugin --profile web add github:mathangler/dsh-archived-session-delete
> ```

Deletion is **permanent** — there is no Recycle Bin. A restricted network can
block `github.com`, but installs resolve through `codeload.github.com`, which is
usually reachable.

Each archived row offers **Unarchive** and **Delete**. Delete asks for an
in-row confirmation first; the confirm and cancel buttons occupy the same two
fixed-width slots as the buttons they replace, so the pointer target does not
move between the two clicks. A result then appears on that same row — green on
success, red on failure — and a successful row is retired about two seconds
later. Nothing outside the operated row moves at any point.

Below the list, **Orphan sessions** offers a **Scan** button (the scan walks
every session directory, so it is on demand rather than automatic). Orphans are
listed by id with their size and can be deleted the same way.

## Implementation notes

**Index pruning goes through the live registry, not the file.** The running Host
holds `workspace.json` in memory and rewrites it wholesale on its next mutation,
so editing that file directly is silently reverted. The host half therefore
prunes through `workspaceRegistry.unarchiveSession` and
`Workspace.detachSession`, which keeps memory and disk consistent and pushes the
change to every UI surface through the normal workspace stream.

**Detach precedes unarchive.** The grouped session list shows a session when it
is owned by a workspace **and** not archived. Unarchiving first would make the
session briefly owned-and-unarchived — that is, visible — until the detach landed
a moment later, which users see as an extra row appearing and vanishing. Both
writes touch independent records and are idempotent, so the final durable state
is identical either way; the order exists purely to keep that intermediate frame
from ever being renderable.

**The result renders from a client-owned snapshot.** The host removes the
session from the archive set and from workspace accounting as part of the same
delete, so the live stores lose the row immediately. A status looked up from
those stores would therefore never appear; the row is snapshotted (plain
scalars) when the delete starts and rendered from that snapshot until the status
expires.

**Transport.** The host half publishes one JSON route (`/archived-session-delete`)
on the composition's `webServer`, fenced by `connection.requestRejection(req)`
before any body read, following the pattern of the shipped
`@deepseek-ai/dsh-host-open-in-app`. Business failures ride the 200 envelope;
only transport faults use 4xx/5xx.

## Known limitations

- **Permanent by design.** There is no undo, no Recycle Bin, and no dry-run.
- **Orphan detection is on demand.** The scan walks every session directory, so
  it is a button rather than an automatic background pass.
- **The shipped page is replaced, not extended.** The Archived sessions
  component renders no child slot, so adding a per-row action requires
  re-registering the section id and reimplementing its list. The Settings shell
  builds its navigation from the whole registration ledger and does not filter
  on the entry's active flag, so the replaced entry would otherwise paint a
  second nav row; this package marks its own row and retires the sibling
  synchronously in a `MutationObserver` callback so the first paint is already
  correct.
