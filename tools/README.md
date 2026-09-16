# tools — verification scripts

Small, dependency-free scripts used while developing this plugin. They are kept
out of the published package (`files[]` in `package.json` lists only `lib/` plus
the patch and README), so they never ship to users.

Each script takes its inputs as arguments and prints a verdict; none of them
hardcode a machine path.

## `position-check.mjs` — no browser, no arguments

Checks the rule that the operated row keeps its list position in every phase of
a delete: armed, busy, and after the host's stream update has dropped the row
from the archive set. That last phase is the one that used to jump to the bottom.

```bash
node tools/position-check.mjs
```

Exits non-zero if the row moves.

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
duplicate-id priority requirement was found: both plugins register id
`archived-sessions`, and a `list` slot rejects a duplicate **at the same
priority**. That is why this package registers with `priority: -1`.

## `boot-check.mjs` — real browser, exits non-zero on failure

Drives headless Chrome over the DevTools protocol, loads a running `dsh web`,
and asserts that the boot banner is absent and the shell painted. Use it after
changing anything the client half registers.

```bash
node tools/boot-check.mjs "http://127.0.0.1:3150/?token=<TOKEN>" "<chrome.exe>"
```

## `browser-diag.mjs` — real browser, diagnostics

The same harness, but instead of asserting it dumps every captured console
entry, exception, and unhandled rejection. Use it when `boot-check.mjs` fails
and you need the underlying cause.

```bash
node tools/browser-diag.mjs "http://127.0.0.1:3150/?token=<TOKEN>" "<chrome.exe>"
```

## Notes

- Both browser scripts launch Chrome with their own throwaway
  `--user-data-dir` under the temp directory and kill only that process, so they
  never touch a browser the user already has open.
- `dsh` on PATH is a POSIX shell script on Windows, so start the server with
  `node <nodejs>/node_modules/@deepseek-ai/dsh/lib/bin.js web --port <n> --no-open`
  and scrape the printed `?token=` for the URL.
- A profile installed with `file:` holds a **copy**, not a link, so re-run
  `dsh plugin --profile web remove <pkg>` then `add` after editing `lib/`.
