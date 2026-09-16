/**
 * Reproduce the web boot activation for the two settings.section registrants.
 *
 * Loads the REAL shipped client bundle and a stub of ours, gives each a
 * minimal but faithful Cordis-like context, and reports whether either apply()
 * throws and what the slot ledger looks like afterwards.
 */
import { readFileSync } from 'node:fs';

const SHIPPED = process.argv[2];
const MINE = process.argv[3];

/** Minimal slot core faithful to the documented list-slot contract. */
function makeSlots() {
  const entries = [];
  const listeners = new Set();
  return {
    entries,
    inject(key, cb) { cb(); return () => {}; },
    register(options, component) {
      const entry = { options, component, active: true };
      entries.push(entry);
      for (const l of listeners) l();
      return () => {
        entry.active = false;
        const i = entries.indexOf(entry);
        if (i >= 0) entries.splice(i, 1);
      };
    },
    subscribe(_key, listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getVersion() { return entries.length; },
  };
}

function makeLocale() {
  const namespaces = new Map();
  return {
    namespaces,
    register(ns, dict) { namespaces.set(ns, dict); return () => namespaces.delete(ns); },
    bind(ns) { return (key, params) => key; },
    getSnapshot() { return { revision: 1, active: 'zh' }; },
    subscribe() { return () => {}; },
  };
}

/** Load one classic-script client bundle and return its exports. */
function loadBundle(path, React) {
  const src = readFileSync(path, 'utf8');
  let captured = null;
  const win = { __ModuleLoader__: { load: (m) => { captured = m; } } };
  const doc = {
    createElement: () => ({ dataset: {}, style: {}, appendChild() {}, remove() {}, setAttribute() {} }),
    head: { appendChild() {} },
    body: {},
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  new Function('window', 'document', src)(win, doc);
  if (!captured) throw new Error('bundle did not register: ' + path);
  const require = (name) => {
    if (name === 'react') return React;
    if (name === 'react/jsx-runtime') {
      return { jsx: () => ({}), jsxs: () => ({}), Fragment: 'Fragment' };
    }
    // Any other module resolves to a permissive stub: we are testing whether
    // apply() throws, not whether these plugins render.
    return new Proxy({}, { get: () => () => ({}) });
  };
  return captured.factory(require);
}

const React = {
  createElement: () => ({}),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (f) => f(),
  useRef: (v) => ({ current: v }),
  useCallback: (f) => f,
};

function run(label, path, ctx) {
  let mod;
  try {
    mod = loadBundle(path, React);
  } catch (error) {
    console.log(`  ${label}: LOAD FAILED -> ${error.message}`);
    return null;
  }
  if (typeof mod.apply !== 'function') {
    console.log(`  ${label}: no apply() export`);
    return null;
  }
  try {
    mod.apply(ctx);
    console.log(`  ${label}: apply() OK   inject=${JSON.stringify(mod.inject)}`);
  } catch (error) {
    console.log(`  ${label}: apply() THREW -> ${error.message}`);
    console.log(`      stack: ${String(error.stack).split('\n').slice(0, 3).join(' | ')}`);
  }
  return mod;
}

const slots = makeSlots();
const locale = makeLocale();
const baseCtx = {
  effect(fn, label) { const d = fn(); return () => {}; },
  locale,
  slots,
  uiWorkspace: { unarchiveSession: async () => {} },
};

console.log('order: shipped FIRST, then ours (matches boot index 22 vs 47)');
console.log('');
run('shipped', SHIPPED, baseCtx);
run('ours   ', MINE, baseCtx);

console.log('');
console.log('slot entries after both:');
for (const e of slots.entries) {
  console.log(`  id=${JSON.stringify(e.options.id)} order=${e.options.order} label=${JSON.stringify(
    typeof e.options.label === 'function' ? e.options.label() : e.options.label,
  )}`);
}
