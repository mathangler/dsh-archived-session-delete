/**
 * dsh-archived-session-delete — browser half.
 *
 * NOT an ES module. A DSH client bundle is a classic script registering one
 * lazy-CJS factory on the page-global facade:
 *   window.__ModuleLoader__.load({ id, factory: (require) => exports })
 * `id` must equal the package name. `require` resolves only against the platform
 * module table and this package's `dsh.client.external` suppliers, so only
 * `react` is required here.
 *
 * This half owns the `archived-sessions` Settings section — on DSH 0.1.7 no
 * shipped package provides that page any more, though the platform still maps
 * the id to the archive nav icon — and adds:
 *   - a permanent Delete action on every archived row;
 *   - an orphan-sessions group that can be scanned and deleted;
 *   - one result notice, in its own area below the lists.
 * It talks to the host half over the package's own route, and to the Workspace
 * model over `ctx.uiWorkspace`, so no Host object ever crosses as data.
 *
 * Interaction stability rules — each one exists because an earlier revision got
 * it wrong and the user watched the layout move:
 *
 *   - A row keeps a FIXED height in EVERY state, and the action cell and each
 *     button have constant widths. Arming a confirmation, entering the busy
 *     state and removing a row therefore never move a neighbour, and the
 *     destructive target stays under the same pointer for both clicks.
 *
 *   - A row is removed only AFTER the host confirms, in the same turn as that
 *     confirmation — never optimistically, and never on a timer.
 *
 *   - The result renders in a dedicated notice area that is the section's LAST
 *     child and `position:sticky` to the panel bottom, so appearing adds height
 *     *after* every row instead of pushing one down.
 *
 * Two earlier designs shipped and were both wrong, and the second one is why
 * the rules above are absolute. Rendering the result ON the operated row
 * required re-inserting that row into its list at a remembered index, which in
 * turn required holding the row in the list for the notice's whole lifetime.
 * That index memory was the defect: the deleted row stayed put while the next
 * interaction captured its position, so the captured number described a list
 * that no longer existed and every later re-insertion landed one slot off — the
 * corruption the user saw after operating a second row. An in-flow results
 * banner above the list was no better, pushing every row down by its height.
 * With no remembered index, no snapshot re-insertion and no lingering row,
 * placement is a pure function of the source order and cannot drift.
 *
 * @module dsh-archived-session-delete/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-archived-session-delete',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');

    /** RPC channel owned by the host half; must match lib/index.js. */
    const CHANNEL = '/archived-session-delete';

    /** Settings section id to take over (the shipped Archived sessions page). */
    const SECTION_ID = 'archived-sessions';

    /** Zero-width space prefixing our nav label so our own row is identifiable. */
    const MARK = '\u200b';

    /** Marker attribute stamped on the nav row we keep. */
    const NAV_ATTR = 'data-asdel-nav';

    /** Constant action-cell width and per-button slot width (px). */
    const ACTION_COL = '248px';
    const BTN_SLOT = '116px';

    /**
     * How long a SUCCESS notice stays before dismissing itself.
     *
     * Deliberately not applied to failures: they are low-frequency and need
     * action, so they persist until closed or superseded. This is no longer the
     * row's lifetime — a deleted row is gone the moment the host confirms.
     */
    const NOTICE_MS = 3000;

    /** Simplified Chinese dictionary and key source of truth. */
    const ZH = {
      nav: '已归档会话',
      search: '搜索会话',
      loading: '正在读取会话…',
      empty: '暂无已归档会话。',
      emptySearch: '没有匹配的会话。',
      unarchive: '取消归档',
      unarchiveNamed: '取消归档 {title}',
      remove: '删除',
      removeNamed: '永久删除 {title}',
      confirmShort: '确认删除？',
      confirmHint: '数据 + 缓存 + 索引，不可恢复',
      confirmYes: '确认删除',
      cancel: '取消',
      cancelNamed: '取消删除 {title}',
      busy: '删除中…',
      ungrouped: '未分组',
      deleted: '已删除：{title}',
      deletedLiveHint: '该会话仍驻留内存，侧边栏条目将在重启 dsh 后消失',
      unarchived: '已取消归档：{title}',
      deleteFailed: '删除失败：{reason}',
      scanDone: '扫描完成，发现 {n} 个孤儿会话',
      scanNone: '扫描完成，没有孤儿会话',
      scanFailed: '扫描失败：{reason}',
      fail: '操作失败：{reason}',
      noticeClose: '关闭提示',
      orphanTitle: '孤儿会话',
      orphanHint: '磁盘上无归属、未归档的会话目录',
      orphanEmpty: '没有孤儿会话。',
      orphanScan: '扫描',
      orphanScanning: '扫描中…',
      'time.now': '刚刚',
      'time.minutes': '{n}分钟',
      'time.hours': '{n}小时',
      'time.days': '{n}天',
      'time.months': '{n}个月',
      'time.years': '{n}年',
    };

    /** English dictionary, kept key-for-key with the Chinese one. */
    const EN = {
      nav: 'Archived sessions',
      search: 'Search sessions',
      loading: 'Reading sessions…',
      empty: 'No archived sessions.',
      emptySearch: 'No matching sessions.',
      unarchive: 'Unarchive',
      unarchiveNamed: 'Unarchive {title}',
      remove: 'Delete',
      removeNamed: 'Permanently delete {title}',
      confirmShort: 'Delete this session?',
      confirmHint: 'data + cache + index; cannot be undone',
      confirmYes: 'Delete',
      cancel: 'Cancel',
      cancelNamed: 'Cancel deleting {title}',
      busy: 'Deleting…',
      ungrouped: 'Ungrouped',
      deleted: 'Deleted: {title}',
      deletedLiveHint: 'still resident in memory; the sidebar entry clears after a dsh restart',
      unarchived: 'Unarchived: {title}',
      deleteFailed: 'Delete failed: {reason}',
      scanDone: 'Scan complete — {n} orphan session(s) found',
      scanNone: 'Scan complete — no orphan sessions',
      scanFailed: 'Scan failed: {reason}',
      fail: 'Operation failed: {reason}',
      noticeClose: 'Dismiss notice',
      orphanTitle: 'Orphan sessions',
      orphanHint: 'on-disk session directories no workspace owns and no archive hides',
      orphanEmpty: 'No orphan sessions.',
      orphanScan: 'Scan',
      orphanScanning: 'Scanning…',
      'time.now': 'now',
      'time.minutes': '{n}min',
      'time.hours': '{n}h',
      'time.days': '{n}d',
      'time.months': '{n}mo',
      'time.years': '{n}y',
    };

    /**
     * Styles are built as an array joined once, and every class name carries the
     * `asdel-` prefix because host and other plugins share one document.
     * Colours are theme alias tokens only, so both themes follow for free.
     */
    const CSS = [
      '.asdel-section{width:100%;max-width:760px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}',
      '.asdel-status{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:20px}',
      '.asdel-search{width:100%;display:flex;position:relative}',
      '.asdel-search input{border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);width:100%;height:32px;color:var(--dsw-alias-label-primary);font:inherit;border-radius:8px;padding:0 12px}',
      '.asdel-search input:focus-visible{outline:none;border-color:var(--dsw-alias-border-l3);box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}',
      '.asdel-list{flex-direction:column;gap:2px;margin:0;padding:0;list-style:none;display:flex}',
      // The two regions are different things — sessions the user archived versus
      // untracked leftovers on disk — so the orphan section is fenced off by a
      // divider and given its own heading rather than reading as a continuation
      // of the list above. A rule plus spacing separates them without adding a
      // card that would fight the surrounding Settings surface.
      '.asdel-orphans{border-top:.5px solid var(--dsw-alias-border-l2);margin-top:10px;padding-top:14px;flex-direction:column;gap:8px;display:flex}',
      '.asdel-orphan-head{align-items:center;gap:12px;padding:0 10px;display:flex;justify-content:space-between}',
      '.asdel-orphan-labels{flex-direction:column;gap:2px;min-width:0;display:flex}',
      '.asdel-orphan-title{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);font-weight:500}',
      '.asdel-orphan-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.asdel-group{flex-direction:column;gap:4px;display:flex}',
      '.asdel-group-title{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-weight:500}',
      '.asdel-row{box-sizing:border-box;border-radius:8px;align-items:center;gap:12px;padding:8px 10px;height:52px;display:flex}',
      '.asdel-row:hover{background:var(--dsw-alias-bg-layer-1)}',
      '.asdel-row-armed,.asdel-row-busy{background:var(--dsw-alias-bg-layer-1)}',
      '.asdel-head{justify-content:space-between;height:auto;padding:4px 10px}',
      '.asdel-head:hover{background:transparent}',
      '.asdel-identity{flex-direction:column;flex:1;gap:2px;min-width:0;display:flex;justify-content:center}',
      '.asdel-title{text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px;overflow:hidden}',
      '.asdel-title-armed{color:var(--dsw-alias-state-error-primary)}',
      '.asdel-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}',
      '.asdel-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}',
      '.asdel-actions{align-items:center;gap:8px;display:flex;flex:none;width:' + ACTION_COL + ';justify-content:flex-end}',
      '.asdel-slot{flex:none;width:' + BTN_SLOT + ';box-sizing:border-box;display:inline-flex;justify-content:flex-end}',
      '.asdel-btn{font:inherit;font-size:12px;line-height:18px;height:28px;padding:0 12px;border-radius:14px;cursor:pointer;border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary);transition:border-color .16s,background .16s,color .16s;box-sizing:border-box;width:100%;display:inline-flex;align-items:center;justify-content:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.asdel-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.asdel-btn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}',
      '.asdel-btn:disabled{opacity:.4;cursor:default}',
      '.asdel-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      // The result notice is deliberately the LAST child of the section and
      // `sticky` rather than `fixed`: it is now the only place a delete's
      // outcome is reported, and it must never move a row. Being last in flow
      // means appearing adds height AFTER every row instead of pushing one
      // down, and sticky keeps it visible when the section is taller than the
      // panel. A `fixed` element would escape the panel and fight other
      // chrome; an in-flow banner above the list would shift every row by its
      // own height — the very defect this rewrite removes.
      //
      // The message WRAPS rather than truncating. A one-line `nowrap` strip cut
      // the longer messages off (a delete with the still-live note is easily
      // wider than the panel), and an ellipsis hid the part that explains why a
      // row survived. Wrapping stays compatible with the rule above because the
      // notice is still the last child: extra lines add height AFTER every row,
      // so nothing moves. Lines are clamped at three so a pathologically long
      // session title cannot grow the pinned strip without bound, and
      // `overflow-wrap:anywhere` lets an unbroken id break instead of forcing
      // the whole strip wider.
      '.asdel-notice{position:sticky;bottom:0;box-sizing:border-box;display:flex;align-items:flex-start;gap:8px;margin-top:14px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:18px}',
      '.asdel-notice-ok{color:var(--dsw-alias-state-success-primary)}',
      '.asdel-notice-err{color:var(--dsw-alias-state-error-primary)}',
      '.asdel-notice-icon{flex:none;width:14px;padding-top:2px;display:inline-flex;align-items:center;justify-content:center}',
      '.asdel-notice-text{flex:1;min-width:0;overflow:hidden;white-space:normal;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}',
      '.asdel-notice-close{flex:none;width:20px;height:20px;padding:0;font:inherit;font-size:14px;line-height:1;cursor:pointer;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);display:inline-flex;align-items:center;justify-content:center}',
      '.asdel-notice-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.asdel-notice-close:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}',
    ].join('');

    /** The style tag, injected once and owned by this plugin's fiber. */
    const STYLE_ID = 'dsh-archived-session-delete/styles';

    /** Locale namespace owned by this plugin. */
    const NS = 'archivedSessionDelete';

    /** Localized compact relative time of one row's last activity. */
    function relativeLabel(updatedAt, now, t) {
      const then = Number(updatedAt);
      if (!isFinite(then) || then <= 0) return '';
      const diff = Math.max(0, now - then);
      const minute = 60000;
      const hour = 60 * minute;
      const day = 24 * hour;
      const month = 30 * day;
      const year = 365 * day;
      if (diff < minute) return t('time.now');
      if (diff < hour) return t('time.minutes', { n: Math.floor(diff / minute) });
      if (diff < day) return t('time.hours', { n: Math.floor(diff / hour) });
      if (diff < month) return t('time.days', { n: Math.floor(diff / day) });
      if (diff < year) return t('time.months', { n: Math.floor(diff / month) });
      return t('time.years', { n: Math.floor(diff / year) });
    }

    /** Whether one row matches the normalized query in its title or owner label. */
    function matches(row, query) {
      return (
        query.length === 0 ||
        row.title.toLowerCase().indexOf(query) !== -1 ||
        row.workspace.toLowerCase().indexOf(query) !== -1
      );
    }

    /**
     * Keep one valid, uniquely-identified entry per orphan.
     *
     * Each orphan row is a React list item keyed by its session id, so a
     * duplicate or missing id would make two rows share one key — the exact
     * class of misplacement this rewrite exists to remove. The host cannot
     * produce either from a directory scan (a directory has one name), so this
     * is a cheap guard against a malformed response, not a repair of one.
     *
     * @param value - the raw `orphans` array from the host.
     * @returns a filtered array safe to key a list by.
     */
    function normalizeOrphans(value) {
      const out = [];
      if (!Array.isArray(value)) return out;
      const seen = {};
      for (const item of value) {
        if (item === null || typeof item !== 'object') continue;
        const id = typeof item.id === 'string' ? item.id : '';
        if (id === '') continue;
        if (seen[id] === true) continue;
        seen[id] = true;
        out.push(item);
      }
      return out;
    }

    /** Compact human byte size for orphan rows. */
    function humanSize(bytes) {
      const n = Number(bytes);
      if (!isFinite(n) || n <= 0) return '0 B';
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
     * Call one host endpoint. The route answers the platform's envelope, so a
     * business failure arrives as `value.ok === false` while a wire fault is a
     * thrown error.
     * @param method - endpoint name.
     * @param args - JSON arguments.
     */
    async function callHost(method, args) {
      const response = await fetch(CHANNEL + '/' + method, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(args === undefined ? {} : args),
      });
      if (!response.ok) throw new Error('request failed: HTTP ' + response.status);
      const envelope = await response.json();
      if (envelope === null || typeof envelope !== 'object' || envelope.ok !== true) {
        const message =
          envelope !== null && typeof envelope === 'object' && envelope.error !== undefined && envelope.error !== null
            ? String(envelope.error.message)
            : 'malformed response';
        throw new Error(message);
      }
      return envelope.value;
    }

    /**
     * Render the archived-session page.
     * @param props - composed slot props.
     */
    function ArchivedSessionsSection(props) {
      const t = props.t;
      const useSessions = props.useSessions;
      const useWorkspaces = props.useWorkspaces;
      const sessions = useSessions(function (s) { return s; });
      const workspaces = useWorkspaces(function (s) { return s.items; });
      const archivedSessionIds = useWorkspaces(function (s) { return s.archivedSessionIds; });

      const queryState = React.useState('');
      const query = queryState[0];
      const setQuery = queryState[1];

      // Three INDEPENDENT pieces of state, deliberately not one shared record.
      // Coupling them was the defect: a single record meant arming one row
      // overwrote another row's in-flight result, and the overwritten row
      // repainted while its position had already been captured from a list that
      // still contained it.
      //
      //   armedId   - the one row showing its delete confirmation.
      //   busyIds   - the rows with a delete in flight at the host.
      //   notice    - the one result notice, rendered OUTSIDE both lists.
      const armedState = React.useState(null);
      const armedId = armedState[0];
      const setArmedId = armedState[1];

      const busyState = React.useState({});
      const busyIds = busyState[0];
      const setBusyIds = busyState[1];

      const noticeState = React.useState(null);
      const notice = noticeState[0];
      const setNotice = noticeState[1];
      const noticeTimer = React.useRef(null);

      const orphansState = React.useState(null);
      const orphans = orphansState[0];
      const setOrphans = orphansState[1];

      const scanningState = React.useState(false);
      const scanning = scanningState[0];
      const setScanning = scanningState[1];

      const ungrouped = t('ungrouped');
      const summaries = sessions.byId;
      const now = Date.now();

      const liveRows = React.useMemo(
        function () {
          const owners = {};
          for (const workspace of workspaces) {
            for (const id of workspace.sessionIds) owners[id] = workspace.title;
          }
          const out = [];
          for (let i = archivedSessionIds.length - 1; i >= 0; i -= 1) {
            const id = archivedSessionIds[i];
            const summary = summaries[id];
            if (summary === undefined) continue;
            out.push({
              id: id,
              kind: 'archived',
              title: summary.displayTitle,
              workspace: owners[id] === undefined ? ungrouped : owners[id],
              updatedAt: summary.updatedAt,
              size: 0,
            });
          }
          return out;
        },
        [archivedSessionIds, workspaces, summaries, ungrouped],
      );

      const liveOrphans = React.useMemo(
        function () {
          const out = [];
          if (orphans === null) return out;
          for (const item of orphans) {
            out.push({
              id: item.id,
              kind: 'orphan',
              title: item.id,
              workspace: ungrouped,
              updatedAt: 0,
              size: Number(item.bytes) || 0,
            });
          }
          return out;
        },
        [orphans, ungrouped],
      );

      /** Cancel the pending auto-dismiss, if any. */
      function clearNoticeTimer() {
        if (noticeTimer.current !== null) {
          window.clearTimeout(noticeTimer.current);
          noticeTimer.current = null;
        }
      }

      /**
       * Report one operation's outcome in the section's dedicated notice area.
       *
       * Success dismisses itself after NOTICE_MS. A failure does NOT: it is
       * low-frequency and needs action, so it stays until the user closes it or
       * the next notice supersedes it. The area is a single slot, so a later
       * notice always replaces an earlier one.
       *
       * @param severity - `success` or `error`.
       * @param text - the already-localized message.
       */
      function showNotice(severity, text) {
        clearNoticeTimer();
        setNotice({ severity: severity, text: text });
        if (severity === 'success') {
          noticeTimer.current = window.setTimeout(function () {
            noticeTimer.current = null;
            setNotice(null);
          }, NOTICE_MS);
        }
      }

      /** Close the notice area and stop its timer. */
      function dismissNotice() {
        clearNoticeTimer();
        setNotice(null);
      }

      /** Drop the timer if the section unmounts mid-countdown. */
      React.useEffect(function () {
        return function () { clearNoticeTimer(); };
      }, []);

      /** Mark or clear one row's in-flight delete. */
      function markBusy(id, busy) {
        setBusyIds(function (prev) {
          const next = {};
          for (const key in prev) {
            if (prev[key] === true) next[key] = true;
          }
          if (busy === true) next[id] = true;
          else delete next[id];
          return next;
        });
      }

      /** Scan for orphan sessions; the outcome goes to the notice area. */
      function scan() {
        setScanning(true);
        callHost('orphans', {}).then(
          function (value) {
            setScanning(false);
            if (value === null || typeof value !== 'object' || value.ok !== true) {
              const reason = value !== null && typeof value === 'object' && value.error ? String(value.error) : 'unknown error';
              showNotice('error', t('scanFailed', { reason: reason }));
              return;
            }
            const found = normalizeOrphans(value.orphans);
            setOrphans(found);
            showNotice('success', found.length === 0 ? t('scanNone') : t('scanDone', { n: found.length }));
          },
          function (reason) {
            setScanning(false);
            showNotice('error', t('scanFailed', { reason: String(reason) }));
          },
        );
      }

      /** Unarchive one archived row, reporting the outcome in the notice area. */
      function unarchive(row) {
        Promise.resolve(props.unarchiveSession(row.id)).then(
          function () { showNotice('success', t('unarchived', { title: row.title })); },
          function (reason) { showNotice('error', t('fail', { reason: String(reason) })); },
        );
      }

      /**
       * Confirm-delete one row.
       *
       * The row leaves its list ONLY once the host confirms, and in the same
       * turn as that confirmation — never on a timer, and never optimistically.
       *
       * A row that outlives its own deletion is what corrupted placement
       * before: the deleted row stayed in the list for the whole notice window,
       * so the next interaction captured an index measured against a list that
       * still carried it, and every later re-insertion landed one slot off.
       * With no remembered index, no snapshot re-insertion and no lingering
       * window there is nothing left to drift.
       *
       * Waiting for the host also means a failure needs no rollback: the row
       * was never removed, so it simply returns to its idle buttons with the
       * reason shown in the notice area.
       */
      function commit(row) {
        setArmedId(null);
        markBusy(row.id, true);
        callHost('delete', { sessionId: row.id }).then(
          function (value) {
            markBusy(row.id, false);
            if (value === null || typeof value !== 'object' || value.ok !== true) {
              const reason = value !== null && typeof value === 'object' && value.error ? String(value.error) : 'unknown error';
              showNotice('error', t('deleteFailed', { reason: reason }));
              return;
            }
            setOrphans(function (prev) {
              if (prev === null) return prev;
              return prev.filter(function (item) { return item.id !== row.id; });
            });
            // `live` says whether the session is still resident in the host's
            // in-memory store. Nothing a plugin can call removes it — the one
            // disposer is a capability held by the agent lifecycle — so a live
            // session keeps being merged into the session list and its sidebar
            // row survives a page reload until the host restarts. Reporting
            // that is all this half can do; the deletion itself is complete.
            const suffix = value.live === true ? ' · ' + t('deletedLiveHint') : '';
            showNotice('success', t('deleted', { title: row.title }) + suffix);
          },
          function (reason) {
            markBusy(row.id, false);
            showNotice('error', t('deleteFailed', { reason: String(reason) }));
          },
        );
      }

      /** The render state of one row, derived from its id alone. */
      function stateOf(id) {
        if (busyIds[id] === true) return 'busy';
        if (armedId === id) return 'armed';
        return 'idle';
      }

      /**
       * Render one row.
       *
       * Every state keeps the same fixed box and the same two fixed-width
       * button slots, so a state change never resizes anything or moves the
       * pointer target between the two clicks of a confirmation. A row carries
       * only `idle`, `armed` and `busy` — there is no result state, because the
       * result is reported in the notice area instead.
       *
       * @param row - the row to render.
       * @param state - `idle` | `armed` | `busy`.
       */
      function renderRow(row, state) {
        const isArmed = state === 'armed';
        const isBusy = state === 'busy';

        const parts = [];
        if (row.kind === 'orphan') {
          parts.push(ungrouped);
          if (row.size > 0) parts.push(humanSize(row.size));
        } else {
          parts.push(row.workspace);
          const rel = relativeLabel(row.updatedAt, now, t);
          if (rel !== '') parts.push(rel);
        }

        const title = isArmed ? t('confirmShort') : row.title;
        const sub = isArmed ? t('confirmHint') : parts.join(' · ');

        let titleClass = 'asdel-title';
        if (isArmed) titleClass = 'asdel-title asdel-title-armed';
        else if (row.kind === 'orphan') titleClass = 'asdel-title asdel-mono';

        // Cancel while armed or busy; unarchive only on an idle archived row.
        let leftButton = null;
        if (isArmed || isBusy) {
          leftButton = React.createElement(
            'button',
            {
              type: 'button',
              className: 'asdel-btn',
              disabled: isBusy,
              'aria-label': t('cancelNamed', { title: row.title }),
              onClick: function () { setArmedId(null); },
            },
            t('cancel'),
          );
        } else if (row.kind === 'archived') {
          leftButton = React.createElement(
            'button',
            {
              type: 'button',
              className: 'asdel-btn',
              'aria-label': t('unarchiveNamed', { title: row.title }),
              onClick: function () { unarchive(row); },
            },
            t('unarchive'),
          );
        }

        // The busy label replaces the button's text INSIDE its fixed slot, so
        // the geometry is unchanged and no neighbouring row can move.
        let rightButton = null;
        if (isBusy) {
          rightButton = React.createElement(
            'button',
            {
              type: 'button',
              className: 'asdel-btn asdel-btn-danger',
              disabled: true,
              'aria-label': t('busy'),
            },
            t('busy'),
          );
        } else {
          rightButton = React.createElement(
            'button',
            {
              type: 'button',
              className: 'asdel-btn asdel-btn-danger',
              'aria-label': t('removeNamed', { title: row.title }),
              onClick: function () {
                if (isArmed) commit(row);
                else setArmedId(row.id);
              },
            },
            isArmed ? t('confirmYes') : t('remove'),
          );
        }

        let rowClass = 'asdel-row';
        if (isArmed) rowClass = 'asdel-row asdel-row-armed';
        else if (isBusy) rowClass = 'asdel-row asdel-row-busy';

        return React.createElement(
          'li',
          { key: row.id, className: rowClass },
          React.createElement(
            'span',
            { className: 'asdel-identity' },
            React.createElement('span', { className: titleClass }, title),
            React.createElement('span', { className: 'asdel-meta' }, sub),
          ),
          React.createElement(
            'span',
            { className: 'asdel-actions' },
            React.createElement('span', { className: 'asdel-slot' }, leftButton),
            React.createElement('span', { className: 'asdel-slot' }, rightButton),
          ),
        );
      }

      if (sessions.phase !== 'ready') {
        return React.createElement('p', { className: 'asdel-status' }, t('loading'));
      }

      const normalized = query.trim().toLowerCase();

      // Both lists are plain projections of their source, filtered by the
      // search box. Nothing is injected into either one: a delete no longer
      // paints a row into the list, because the result is reported in the
      // notice area and the row leaves the moment the host confirms. That is
      // what makes a row's position a function of its source order alone —
      // there is no second writer that could disagree about where a row goes.
      const visible = liveRows.filter(function (row) { return matches(row, normalized); });
      const visibleOrphans = liveOrphans.filter(function (row) { return matches(row, normalized); });

      const archived = archivedSessionIds.length > 0;

      const children = [];
      children.push(
        React.createElement(
          'div',
          { key: 'search', className: 'asdel-search' },
          React.createElement('input', {
            type: 'search',
            value: query,
            placeholder: t('search'),
            'aria-label': t('search'),
            onChange: function (event) { setQuery(event.currentTarget.value); },
          }),
        ),
      );

      if (!archived) children.push(React.createElement('p', { key: 'empty', className: 'asdel-status' }, t('empty')));
      if (archived && visible.length === 0 && visibleOrphans.length === 0) {
        children.push(React.createElement('p', { key: 'emptysearch', className: 'asdel-status' }, t('emptySearch')));
      }

      if (visible.length > 0) {
        children.push(
          React.createElement(
            'ul',
            { key: 'list', className: 'asdel-list' },
            visible.map(function (row) { return renderRow(row, stateOf(row.id)); }),
          ),
        );
      }

      const orphanChildren = [
        React.createElement(
          'div',
          { key: 'head', className: 'asdel-orphan-head' },
          React.createElement(
            'span',
            { className: 'asdel-orphan-labels' },
            React.createElement('span', { className: 'asdel-orphan-title' }, t('orphanTitle')),
            React.createElement('span', { className: 'asdel-orphan-hint' }, t('orphanHint')),
          ),
          React.createElement(
            'span',
            { className: 'asdel-actions' },
            React.createElement('span', { className: 'asdel-slot' }),
            React.createElement(
              'span',
              { className: 'asdel-slot' },
              React.createElement(
                'button',
                { type: 'button', className: 'asdel-btn', disabled: scanning, onClick: scan },
                scanning ? t('orphanScanning') : t('orphanScan'),
              ),
            ),
          ),
        ),
      ];
      if (orphans !== null && visibleOrphans.length === 0) {
        orphanChildren.push(React.createElement('p', { key: 'noorphan', className: 'asdel-status' }, t('orphanEmpty')));
      }
      if (visibleOrphans.length > 0) {
        orphanChildren.push(
          React.createElement(
            'ul',
            { key: 'orphanlist', className: 'asdel-list' },
            visibleOrphans.map(function (row) { return renderRow(row, stateOf(row.id)); }),
          ),
        );
      }
      children.push(React.createElement('div', { key: 'orphans', className: 'asdel-orphans' }, orphanChildren));

      // The notice is the section's LAST child and is `position:sticky` to the
      // panel bottom (see the CSS comment). Being last is what makes it free:
      // appearing adds height after every row rather than pushing one down, so
      // no row ever moves because a result was reported.
      if (notice !== null) {
        const isError = notice.severity === 'error';
        children.push(
          React.createElement(
            'div',
            {
              key: 'notice',
              className: 'asdel-notice ' + (isError ? 'asdel-notice-err' : 'asdel-notice-ok'),
              role: 'status',
              'aria-live': 'polite',
            },
            React.createElement(
              'span',
              { className: 'asdel-notice-icon', 'aria-hidden': 'true' },
              isError ? '\u26a0' : '\u2713',
            ),
            React.createElement('span', { className: 'asdel-notice-text' }, notice.text),
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'asdel-notice-close',
                'aria-label': t('noticeClose'),
                onClick: dismissNotice,
              },
              '\u00d7',
            ),
          ),
        );
      }

      return React.createElement('div', { className: 'asdel-section' }, children);
    }

    /** Services required by the Settings registration and the archive write. */
    const inject = ['slots', 'locale', 'uiWorkspace'];

    /**
     * Contribute the archived-session page to Settings.
     * @param ctx - the client plugin context.
     */
    function apply(ctx) {
      ctx.effect(
        function () {
          const tag = document.createElement('style');
          tag.dataset.plugin = 'dsh-archived-session-delete';
          tag.dataset.pluginCss = STYLE_ID;
          tag.textContent = CSS;
          document.head.appendChild(tag);
          return function () { tag.remove(); };
        },
        'dsh-archived-session-delete: styles',
      );

      ctx.effect(
        function () { return ctx.locale.register(NS, { zh: ZH, en: EN }); },
        'dsh-archived-session-delete: dictionaries',
      );
      const t = ctx.locale.bind(NS);

      // The Settings shell builds its nav from the WHOLE registration ledger
      // (`ctx.slots.entries`), so after we take over the shipped
      // `archived-sessions` id the shipped entry is still listed and paints a
      // second row; only its content-column render is suppressed. We therefore
      // mark our own row through the label and retire the sibling synchronously
      // in the MutationObserver callback, so the first paint is already right.
      const label = function () { return MARK + t('nav'); };

      ctx.effect(
        function () {
          if (typeof MutationObserver !== 'function' || !document.body) return function () {};

          let mine = null;
          const NAV_TAGS = { BUTTON: true, A: true };
          const cleanText = function (node) {
            return String(node.textContent || '').replace(/\u200b/g, '').trim();
          };
          const wanted = function () { return String(t('nav')).trim(); };
          const isMarked = function () {
            return mine !== null && mine.isConnected && mine.getAttribute(NAV_ATTR) === '1';
          };

          const candidates = function () {
            const list = [];
            const nodes = document.querySelectorAll('button, a');
            for (const node of nodes) {
              if (NAV_TAGS[node.tagName] !== true) continue;
              if (cleanText(node) !== wanted()) continue;
              list.push(node);
            }
            return list;
          };

          const reconcile = function () {
            if (isMarked()) return;
            const all = candidates();
            if (all.length === 0) return;
            let target = null;
            for (const node of all) {
              if (String(node.textContent || '').indexOf(MARK) === -1) continue;
              target = node;
              break;
            }
            if (target === null) return;
            const parent = target.parentNode;
            if (parent === null) return;
            target.setAttribute(NAV_ATTR, '1');
            mine = target;
            const span = target.querySelector('span');
            if (span !== null) span.textContent = wanted();
            const doomed = [];
            for (const node of parent.children) {
              if (node === target) continue;
              if (NAV_TAGS[node.tagName] !== true) continue;
              if (cleanText(node) !== wanted()) continue;
              doomed.push(node);
            }
            for (const node of doomed) node.remove();
          };

          const observer = new MutationObserver(function (records) {
            if (isMarked()) return;
            for (const record of records) {
              if (record.addedNodes.length === 0) continue;
              reconcile();
              if (isMarked()) return;
            }
          });
          observer.observe(document.body, { childList: true, subtree: true });
          reconcile();
          return function () { observer.disconnect(); };
        },
        'dsh-archived-session-delete: single nav row',
      );

      function injected() {
        return {
          t: t,
          unarchiveSession: function (sessionId) { return ctx.uiWorkspace.unarchiveSession(sessionId); },
        };
      }

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: SECTION_ID,
            order: 25,
            // A `list` slot REJECTS a second entry with the same id at the SAME
            // priority, and the rejection is thrown inside whichever registrant
            // arrives second. The shipped Archived-sessions page still registers
            // this id, so registering at the default priority 0 makes that
            // shipped entry throw and aborts the whole web boot ("web boot: 1
            // entry did not activate"). A lower priority is the platform's own
            // endorsed way to shadow a cell: its clash message reads "register
            // at a different priority to shadow it (lowest renders)".
            priority: -1,
            label: label,
            locale: NS,
            inject: injected,
          },
          ArchivedSessionsSection,
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
