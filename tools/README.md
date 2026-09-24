# tools — verification scripts

Small, dependency-free scripts used while developing this plugin. They are kept
out of the published package (`files[]` in `package.json` lists only `lib/` plus
the patch and README), so they never ship to users.

Each script takes its inputs as arguments and prints a verdict; none of them
hardcode a machine path.

`npm run check` runs the two platform-neutral suites (`host-core-check` and
`route-check`); neither needs a browser or a running DSH.

## `host-core-check.mjs` — no browser, no shell, no arguments

Runs the real `createHandlers()` from `lib/host-core.js` against a synthetic DSH
home in the OS temp directory, covering `inspect`, `orphans` and `delete`, plus
the containment rules (removals stay inside the DSH home; a symlinked session
directory is unlinked, never its target). It also asserts that no PowerShell
transport has crept back into the module.

```bash
node tools/host-core-check.mjs
```

This is the check that catches the Windows-only regression class: it runs
identically on Windows, macOS and Linux, while the old PowerShell transport only
ever ran on Windows.

## `route-check.mjs` — no browser, no arguments

Boots the real `apply()` from `lib/index.js` against a minimal Cordis-like
context, binds the route it registers to a real loopback HTTP server, and drives
it with real `fetch` requests: the method/content-type/endpoint/size guards, the
`connection.requestRejection` fence, the success and business-failure envelopes,
and a full delete. It also asserts that the plugin no longer injects `shell`.

```bash
node tools/route-check.mjs
```

## `position-check.mjs` — no browser, no arguments

Checks the rule that the operated row keeps its list position in every phase of
a delete: armed, busy, and after the host's stream update has dropped the row
from the archive set. That last phase is the one that used to jump to the bottom.

```bash
node tools/position-check.mjs
```

Exits non-zero if the row moves.

## `orphan-path-check.mjs` — real browser, needs a running Harness

Reproduces the exact sequence reported from the UI: delete one **orphan**, then
arm a *different* orphan while the result notice is still alive, and check where
everything lands. Rows are addressed by index because arming a row rewrites its
title to the confirmation prompt — a title lookup silently stops matching
mid-flow, which is how an earlier revision of this check reported a spurious pass
while never deleting anything.

It asserts the four invariants the rewrite establishes: the deleted row leaves
immediately rather than on a timer; the result appears in the dedicated notice
area and not inside a list; arming a second row moves neither it nor its
neighbours (compared in pixels); and nothing resurfaces once the notice expires.

```bash
node tools/orphan-path-check.mjs "http://127.0.0.1:3220/?token=<TOKEN>" "<chrome.exe>"
```

It needs planted orphan fixtures — empty directories under
`<dshHome>/sessions/<any-project>/<session-id>/` are enough, since the scan
enumerates directories. **Give them no artifact file**: a stray `session.jsonl`
makes the workspace registry refuse to start (the backend expects
`session.v4.jsonl.zstd`).

Validated both ways: it passes on the current build and **fails on the previous
one** (8 failed checks, including the misplacement itself), so it genuinely
discriminates rather than merely passing.

## `bundle-load.mjs` — no browser

Loads the real client bundles with a `window.__ModuleLoader__` stub and a
minimal Cordis-like context, then calls `apply()` on each. This proves the
classic-script bundle contract (the loader id equals the package name, the
factory returns `apply`/`inject`) and that neither registrant throws.

```bash
node tools/bundle-load.mjs \
  <shipped-unarchive-sessions>/lib/client.js \
  lib/client.js
```

It also prints the resulting `settings.section` entries, which is how the
duplicate-id priority requirement was found: on DSH `0.1.6` both plugins
registered id `archived-sessions`, and a `list` slot rejects a duplicate **at
the same priority**. That is why this package registers with `priority: -1`.
On `0.1.7` the shipped page no longer exists, so the id is this package's alone
— the priority and the nav dedup are kept as insurance, not because of a
current collision.

## `boot-check.mjs` — real browser, exits non-zero on failure

Drives headless Chrome over the DevTools protocol, loads a running `dsh web`,
and asserts that the boot banner is absent and the shell painted. Use it after
changing anything the client half registers.

```bash
node tools/boot-check.mjs "http://127.0.0.1:3150/?token=<TOKEN>" "<chrome.exe>"
```

## `nav-check.mjs` — real browser, nav verification

Opens Settings and reports the boot verdict plus every nav row carrying the
Archived-sessions label: how many there are, their text (a zero-width space is
shown as `<ZWSP>`), and whether this package's dedup marker landed.

Use it after a DSH upgrade, or whenever the nav could regress. The expected
result is **one** row reading `已归档会话` / `Archived sessions` with no `<ZWSP>`
left and `hasMarker: true`. On DSH `0.1.7` the shipped page is gone, so a second
row would mean a duplicate arrived from somewhere else.

```bash
node tools/nav-check.mjs "http://127.0.0.1:3200/?token=<TOKEN>" "<chrome.exe>"
```

## `browser-diag.mjs` — real browser, diagnostics

The same harness, but instead of asserting it dumps every captured console
entry, exception, and unhandled rejection. Use it when `boot-check.mjs` fails
and you need the underlying cause.

```bash
node tools/browser-diag.mjs "http://127.0.0.1:3150/?token=<TOKEN>" "<chrome.exe>"
```

## Notes

- Every browser script launches Chrome with its own throwaway
  `--user-data-dir` under the temp directory and kill only that process, so they
  never touch a browser the user already has open.
- `dsh` on PATH is a POSIX shell script on Windows, so start the server with
  `node <nodejs>/node_modules/@deepseek-ai/dsh/lib/bin.js web --port <n> --no-open`
  and scrape the printed `?token=` for the URL.
- A profile installed with `file:` holds a **copy**, not a link, so re-run
  `dsh plugin --profile web remove <pkg>` then `add` after editing `lib/`.
