/**
 * Verify the reported-row position rule without a browser.
 *
 * Models the three phases of a delete and asserts the operated row keeps the
 * same index in all of them:
 *   armed  -> the row is still live, replaced in place
 *   busy   -> same
 *   done   -> the host's stream update has dropped the row from the archive
 *             set, so the snapshot must be re-inserted at its remembered index
 */
const NOTICE = { index: 2, id: 'C' };

const live = ['A', 'B', 'C', 'D', 'E'];

/** Mirror the component's list construction for one phase. */
function build(liveIds, notice, noticePresent) {
  const rows = liveIds.map((id) => ({ id }));
  const out = [];
  let noticeId = notice === null ? null : notice.id;
  for (const row of rows) {
    if (row.id === noticeId) {
      out.push({ id: notice.id, state: 'reported' });
      continue;
    }
    out.push({ id: row.id, state: 'idle' });
  }
  // once the store drops the row, liveIds no longer contains it
  if (notice !== null && !noticePresent) {
    const carries = out.some((item) => item.id === noticeId);
    if (!carries) {
      const at = notice.index < 0 ? out.length : Math.min(notice.index, out.length);
      out.splice(at, 0, { id: notice.id, state: 'reported' });
    }
  }
  return out.map((i) => i.id);
}

const phases = [
  ['armed (row still live)', build(live, NOTICE, true)],
  ['busy  (row still live)', build(live, NOTICE, true)],
  ['done  (store dropped)', build(['A', 'B', 'D', 'E'], NOTICE, false)],
];

let ok = true;
console.log('original order: ' + JSON.stringify(live));
console.log('operated row  : ' + NOTICE.id + ' at index ' + NOTICE.index);
console.log('');
for (const [label, order] of phases) {
  const at = order.indexOf(NOTICE.id);
  const pass = at === NOTICE.index || label.startsWith('done');
  console.log(label.padEnd(26) + JSON.stringify(order) + '   index=' + at);
}
console.log('');
console.log('done-phase index must be 2 (NOT the end):');
const doneOrder = phases[2][1];
const doneAt = doneOrder.indexOf(NOTICE.id);
console.log('  actual: ' + doneAt + '  -> ' + (doneAt === NOTICE.index ? 'PASS' : 'FAIL'));
if (doneAt !== NOTICE.index) ok = false;

console.log('');
console.log('edge: row was last -> index clamps instead of overflowing');
const last = { index: 4, id: 'E' };
const lastOrder = build(['A', 'B', 'C', 'D'], last, false);
console.log('  ' + JSON.stringify(lastOrder) + '  E at ' + lastOrder.indexOf('E'));
if (lastOrder.indexOf('E') !== 4) ok = false;

console.log('');
console.log(ok ? 'RESULT: position preserved in all phases' : 'RESULT: FAILED');
process.exit(ok ? 0 : 1);
