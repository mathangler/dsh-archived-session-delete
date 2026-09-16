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
 * This half takes over the shipped `archived-sessions` Settings section by
 * re-registering the same id (which replaces that cell's content) and adds:
 *   - a permanent Delete action on every archived row;
 *   - an orphan-sessions group that can be scanned and deleted.
 * It talks to the host half over the package's own route, and to the Workspace
 * model over `ctx.uiWorkspace`, so no Host object ever crosses as data.
 *
 * Interaction stability rules (each one exists because an earlier revision got
 * it wrong and the user saw the layout move):
 *   - A row keeps a FIXED height in every state, so arming a confirmation,
 *     showing a result, or removing a row never moves its neighbours.
 *   - The action cell and each button have constant widths, so the destructive
 *     target stays under the same pointer between the two clicks.
 *   - A result is rendered ON the operated row from a client-owned snapshot.
 *     The host drops the session from the archive set and from workspace
 *     accounting as part of the delete, so the live stores lose the row
 *     immediately; rendering the status from a store lookup would therefore
 *     never appear. A page-level results panel was tried first and rejected:
 *     it is inserted into the flow and shoves the whole list down.
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

    /** How long a success status stays on its row before the row is retired. */
    const NOTICE_MS = 2000;

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
      done: '已永久删除',
      doneHint: '数据目录、缓存记录与索引条目已移除',
      fail: '操作失败：{reason}',
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
      done: 'Permanently deleted',
      doneHint: 'data directory, cache record and index entries removed',
      fail: 'Operation failed: {reason}',
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
      '.asdel-row-armed,.asdel-row-done{background:var(--dsw-alias-bg-layer-1)}',
      '.asdel-head{justify-content:space-between;height:auto;padding:4px 10px}',
      '.asdel-head:hover{background:transparent}',
      '.asdel-identity{flex-direction:column;flex:1;gap:2px;min-width:0;display:flex;justify-content:center}',
      '.asdel-title{text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:20px;overflow:hidden}',
      '.asdel-title-armed{color:var(--dsw-alias-state-error-primary)}',
      '.asdel-title-ok{color:var(--dsw-alias-state-success-primary)}',
      '.asdel-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}',
      '.asdel-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}',
      '.asdel-actions{align-items:center;gap:8px;display:flex;flex:none;width:' + ACTION_COL + ';justify-content:flex-end}',
      '.asdel-slot{flex:none;width:' + BTN_SLOT + ';box-sizing:border-box;display:inline-flex;justify-content:flex-end}',
      '.asdel-btn{font:inherit;font-size:12px;line-height:18px;height:28px;padding:0 12px;border-radius:14px;cursor:pointer;border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary);transition:border-color .16s,background .16s,color .16s;box-sizing:border-box;width:100%;display:inline-flex;align-items:center;justify-content:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.asdel-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.asdel-btn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}',
      '.asdel-btn:disabled{opacity:.4;cursor:default}',
      '.asdel-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
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

      // `report` is a CLIENT-OWNED snapshot of the operated row: plain scalars
      // only. The stores drop the row as part of the delete, so the status must
      // render from this snapshot rather than from a live lookup.
      const reportState = React.useState(null);
      const report = reportState[0];
      const setReport = reportState[1];

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

      /** Scan for orphan sessions. A failure is a section-level notice. */
      function scan() {
        setScanning(true);
        setReport(null);
        callHost('orphans', {}).then(
          function (value) {
            setScanning(false);
            if (value === null || typeof value !== 'object' || value.ok !== true) {
              const reason = value !== null && typeof value === 'object' && value.error ? String(value.error) : 'unknown error';
              setReport({ kind: 'error', id: '__scan__', scope: 'orphan', text: t('fail', { reason: reason }), row: null });
              return;
            }
            setOrphans(Array.isArray(value.orphans) ? value.orphans : []);
          },
          function (reason) {
            setScanning(false);
            setReport({ kind: 'error', id: '__scan__', scope: 'orphan', text: t('fail', { reason: String(reason) }), row: null });
          },
        );
      }

      /**
       * Snapshot the row, then delete it. On success the snapshot shows a green
       * status in place for NOTICE_MS and is then dropped; on failure it turns
       * red and stays so the operation can be retried.
       *
       * `index` is the row's position in its section at the moment the delete
       * started. The host removes the session from the archive set as part of
       * this call, so once that stream update lands the live list no longer
       * carries the row; without a remembered index the snapshot could only be
       * appended, which made a successful row jump to the bottom.
       */
      function commit(row, index) {
        const snapshot = {
          id: row.id,
          kind: row.kind,
          title: row.title,
          workspace: row.workspace,
          updatedAt: row.updatedAt,
          size: row.size,
        };
        setReport({ kind: 'busy', id: row.id, scope: 'row', index: index, text: t('busy'), row: snapshot });
        callHost('delete', { sessionId: row.id }).then(
          function (value) {
            if (value === null || typeof value !== 'object' || value.ok !== true) {
              const reason = value !== null && typeof value === 'object' && value.error ? String(value.error) : 'unknown error';
              setReport({ kind: 'error', id: row.id, scope: 'row', index: index, text: t('fail', { reason: reason }), row: snapshot });
              return;
            }
            setReport({ kind: 'done', id: row.id, scope: 'row', index: index, text: t('done'), row: snapshot });
            window.setTimeout(function () {
              setReport(function (current) {
                if (current !== null && current.id === row.id && current.kind === 'done') return null;
                return current;
              });
              setOrphans(function (prev) {
                if (prev === null) return prev;
                return prev.filter(function (item) { return item.id !== row.id; });
              });
            }, NOTICE_MS);
          },
          function (reason) {
            setReport({ kind: 'error', id: row.id, scope: 'row', index: index, text: t('fail', { reason: String(reason) }), row: snapshot });
          },
        );
      }

      /**
       * Arm the in-row confirmation for one row.
       * @param row - the row being armed.
       * @param index - its position in its section, remembered so the row can
       *   be re-inserted at the same place once the stores drop it.
       */
      function arm(row, index) {
        setReport({ kind: 'armed', id: row.id, scope: 'row', index: index, text: t('confirmShort'), row: row });
      }

      /**
       * Render one row. Every state keeps the same fixed box and slots.
       * @param row - the row to render.
       * @param state - idle | armed | busy | done | error.
       * @param index - the row's position in its section, remembered when the
       *   row is operated so a report can be re-inserted at the same place.
       */
      function renderRow(row, state, index) {
        const isArmed = state === 'armed';
        const isBusy = state === 'busy';
        const isDone = state === 'done';
        const isFailed = state === 'error';

        const parts = [];
        if (row.kind === 'orphan') {
          parts.push(ungrouped);
          if (row.size > 0) parts.push(humanSize(row.size));
        } else {
          parts.push(row.workspace);
          const rel = relativeLabel(row.updatedAt, now, t);
          if (rel !== '') parts.push(rel);
        }

        let title = row.title;
        let sub = parts.join(' · ');
        if (isArmed) {
          title = t('confirmShort');
          sub = t('confirmHint');
        } else if (isBusy) {
          sub = t('busy');
        } else if (isDone) {
          title = t('done');
          sub = t('doneHint');
        } else if (isFailed) {
          title = t('confirmHint');
        }

        let titleClass = 'asdel-title';
        if (isArmed || isFailed) titleClass = 'asdel-title asdel-title-armed';
        else if (isDone) titleClass = 'asdel-title asdel-title-ok';
        else if (row.kind === 'orphan') titleClass = 'asdel-title asdel-mono';

        let leftButton = null;
        if (isArmed) {
          leftButton = React.createElement(
            'button',
            {
              type: 'button',
              className: 'asdel-btn',
              disabled: isBusy,
              'aria-label': t('cancelNamed', { title: row.title }),
              onClick: function () { setReport(null); },
            },
            t('cancel'),
          );
        } else if (state === 'idle' && row.kind === 'archived') {
          leftButton = React.createElement(
            'button',
            {
              type: 'button',
              className: 'asdel-btn',
              'aria-label': t('unarchiveNamed', { title: row.title }),
              onClick: function () {
                Promise.resolve(props.unarchiveSession(row.id)).catch(function (reason) {
                  setReport({ kind: 'error', id: row.id, scope: 'row', index: index, text: t('fail', { reason: String(reason) }), row: row });
                });
              },
            },
            t('unarchive'),
          );
        }

        let rightButton = null;
        if (state === 'idle' || isArmed) {
          rightButton = React.createElement(
            'button',
            {
              type: 'button',
              className: 'asdel-btn asdel-btn-danger',
              disabled: isBusy,
              'aria-label': t('removeNamed', { title: row.title }),
              onClick: function () { if (isArmed) commit(row, index); else arm(row, index); },
            },
            isArmed ? t('confirmYes') : t('remove'),
          );
        }

        let rowClass = 'asdel-row';
        if (isArmed) rowClass = 'asdel-row asdel-row-armed';
        else if (isDone || isFailed || isBusy) rowClass = 'asdel-row asdel-row-done';

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
      const noticeRow = report !== null && report.row !== null ? report.row : null;
      const noticeId = noticeRow !== null ? noticeRow.id : null;
      const noticeState = report !== null ? report.kind : 'idle';
      const noticeIndex = report !== null && typeof report.index === 'number' ? report.index : -1;

      // The operated row renders FROM ITS SNAPSHOT while it carries a status,
      // so the report survives the stores dropping it. Two things must hold:
      // the row stays in its original slot, and it renders exactly once.
      //
      // While the row is still live, the snapshot replaces it in place. Once
      // the host's stream update removes it from the archive set, the live list
      // no longer carries it, so the snapshot is re-inserted at the index it
      // occupied when the delete started. That remembered index is what keeps a
      // successful row from jumping to the bottom of the list.
      const visible = [];
      for (const row of liveRows) {
        if (row.id === noticeId) {
          visible.push({ row: noticeRow, state: noticeState });
          continue;
        }
        if (!matches(row, normalized)) continue;
        visible.push({ row: row, state: 'idle' });
      }

      const visibleOrphans = [];
      for (const row of liveOrphans) {
        if (row.id === noticeId) {
          visibleOrphans.push({ row: noticeRow, state: noticeState });
          continue;
        }
        if (!matches(row, normalized)) continue;
        visibleOrphans.push({ row: row, state: 'idle' });
      }

      /** Whether a section's rendered list already carries the reported row. */
      function carries(list) {
        for (const item of list) if (item.row.id === noticeId) return true;
        return false;
      }

      /** Re-insert the snapshot at its remembered index, clamped to the list. */
      function restore(list) {
        if (noticeRow === null || noticeId === null) return;
        if (carries(list)) return;
        const at = noticeIndex < 0 ? list.length : Math.min(noticeIndex, list.length);
        list.splice(at, 0, { row: noticeRow, state: noticeState });
      }

      if (noticeRow !== null && noticeRow.kind === 'archived') restore(visible);
      if (noticeRow !== null && noticeRow.kind === 'orphan') restore(visibleOrphans);

      const archived = archivedSessionIds.length > 0 || noticeRow !== null;
      const scanNotice = report !== null && report.id === '__scan__' ? report : null;

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
            visible.map(function (item, at) { return renderRow(item.row, item.state, at); }),
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
      if (scanNotice !== null) {
        orphanChildren.push(
          React.createElement('p', { key: 'scanerr', className: 'asdel-status asdel-title-armed' }, scanNotice.text),
        );
      }
      if (orphans !== null && visibleOrphans.length === 0) {
        orphanChildren.push(React.createElement('p', { key: 'noorphan', className: 'asdel-status' }, t('orphanEmpty')));
      }
      if (visibleOrphans.length > 0) {
        orphanChildren.push(
          React.createElement(
            'ul',
            { key: 'orphanlist', className: 'asdel-list' },
            visibleOrphans.map(function (item, at) { return renderRow(item.row, item.state, at); }),
          ),
        );
      }
      children.push(React.createElement('div', { key: 'orphans', className: 'asdel-orphans' }, orphanChildren));

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
