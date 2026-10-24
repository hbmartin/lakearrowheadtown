import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const fragment = readFileSync(new URL('../src/alert-interaction.html', import.meta.url), 'utf8');
const script = fragment.match(/<script id="alert-dismissals">([\s\S]*?)<\/script>/)[1];
const bootstrap = fragment.match(/<script id="alert-dismissal-bootstrap">([\s\S]*?)<\/script>/)[1];
const key = id => 'lakearrowhead-dismissed-alert:v1:' + id;

// Execute the shipped script. Hiding a focused row blurs it as in a native DOM;
// browser validation also exercises focus and scrolling with real elements.
function page({ ids = ['traffic-a', 'traffic-b', 'power-a'], storage = new Map(), weather = false, notice = false,
  readFails = false, writeFails = false, accessFails = false, missingButton, missingRoot = false,
  missingContainer = false, news = true, onRead, onWrite } = {}) {
  const listeners = new Map();
  const classes = new Set(weather ? ['has-weather'] : []);
  const pending = new Set(['conditions-pending']);
  const document = { activeElement: null, documentElement: { classList: {
    add: name => pending.add(name), remove: name => pending.delete(name),
  } } };
  const focusable = tagName => ({ tagName, attributes: new Map(), scrolled: false,
    hasAttribute(name) { return this.attributes.has(name); },
    setAttribute(name, value) { this.attributes.set(name, value); },
    focus() { document.activeElement = this; }, scrollIntoView() { this.scrolled = true; },
  });
  const main = focusable('MAIN'); const heading = focusable('H3'); const weatherHeading = focusable('H2');
  const rows = ids.map((id, index) => {
    let hidden = false;
    const summary = focusable('SUMMARY');
    const button = { addEventListener: (type, callback) => listeners.set(`${index}:${type}`, callback) };
    const source = {};
    const row = { dataset: id ? { alertId: id } : {}, summary, button, source,
      contains: target => [summary, button, source].includes(target),
      querySelector: selector => selector === 'summary' ? summary : index === missingButton ? null : button,
    };
    Object.defineProperty(row, 'hidden', { get: () => hidden, set(value) {
      hidden = value;
      if (value && row.contains(document.activeElement)) document.activeElement = null;
    } });
    return row;
  });
  const groups = ['traffic', 'power'].map(category => ({ hidden: false,
    contains: row => row.dataset.alertId?.startsWith(category),
  }));
  const conditionsRow = { hidden: !weather };
  const root = { hidden: !weather && !notice,
    classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } },
    querySelector: selector => ({ '.conditions-row': missingContainer ? null : conditionsRow, '.weather-card': weather || null,
      '.weather-card h2': weather ? weatherHeading : null, '.conditions-unavailable': notice || null })[selector],
  };
  const banner = { hidden: true, dataset: {}, closest: () => missingRoot ? null : root,
    querySelectorAll: selector => selector === '.alert-item' ? rows : groups,
  };
  document.querySelector = selector => ({ '.alerts-banner': banner, 'main .digest h3, main .empty-state': news ? heading : null, main })[selector];
  const reads = []; const writes = [];
  const context = { document, window: { addEventListener: (type, callback) => listeners.set(type, callback) } };
  Object.defineProperty(context, 'localStorage', { get() {
    if (accessFails) throw new Error('Storage access blocked');
    return {
      getItem(name) {
        reads.push(name); onRead?.({ name, banner, root, rows });
        if (readFails) throw new Error('Storage read blocked');
        return storage.get(name) ?? null;
      },
      setItem(name, value) {
        writes.push([name, value]); onWrite?.({ name, banner, root, rows });
        if (writeFails) throw new Error('Storage full');
        storage.set(name, value);
      },
    };
  } });
  runInNewContext(script, context);
  return { banner, root, rows, groups, conditionsRow, classes, pending, document, main, heading, weatherHeading, reads, writes,
    initialize: () => runInNewContext(script, context),
    emit: (type, persisted = true) => listeners.get(type)?.({ persisted }),
    dismiss(id, focused = true) {
      const index = rows.findIndex(row => row.dataset.alertId === id);
      if (focused) document.activeElement = rows[index].button;
      listeners.get(`${index}:click`)();
    },
    visible: () => rows.filter(row => !row.hidden).map(row => row.dataset.alertId),
  };
}

test('keeps the banner hidden until every saved dismissal is checked, once on initial arrival', () => {
  const view = page({ onRead({ banner }) { assert.equal(banner.hidden, true); } });
  assert.equal(view.reads.length, 3);
  view.emit('pageshow', false);
  assert.equal(view.reads.length, 3);
  assert.deepEqual(view.visible(), ['traffic-a', 'traffic-b', 'power-a']);
  assert.equal(view.banner.hidden, false);
  assert.equal(view.root.hidden, false);
  assert.equal(view.conditionsRow.hidden, false);
  assert(view.classes.has('has-alerts'));
  assert.equal(view.writes.length, 0);
  assert.equal(view.pending.size, 0);
  view.initialize(); view.dismiss('traffic-a');
  assert.equal(view.reads.length, 3);
  assert.equal(view.writes.length, 1);
});

test('remembers individual dismissals on reload and leaves newer IDs visible', () => {
  const storage = new Map();
  const view = page({ storage, onWrite({ rows }) { assert.equal(rows[0].hidden, true); } });
  view.dismiss('traffic-a');
  assert.equal(storage.get(key('traffic-a')), '1');
  assert.deepEqual(view.visible(), ['traffic-b', 'power-a']);
  assert.equal(view.document.activeElement, view.rows[1].summary);
  // The same ID stays hidden regardless of updated content or confirmations.
  const reload = page({ storage, ids: ['traffic-a', 'traffic-new', 'power-a'] });
  assert.deepEqual(reload.visible(), ['traffic-new', 'power-a']);
  assert.deepEqual(reload.writes, []);
});

test('never drops dismissed IDs that are absent from a homepage snapshot', () => {
  const storage = new Map([[key('traffic-older'), '1']]);
  page({ storage }).dismiss('power-a');
  assert.equal(storage.get(key('traffic-older')), '1');
  const later = page({ storage, ids: ['traffic-older', 'power-a', 'traffic-new'] });
  assert.deepEqual(later.visible(), ['traffic-new']);
});

test('hides empty categories, then the banner and an alert-only conditions section', () => {
  const view = page();
  view.dismiss('traffic-a'); view.dismiss('traffic-b');
  assert.equal(view.groups[0].hidden, true);
  assert.equal(view.groups[1].hidden, false);
  assert.equal(view.banner.hidden, false);
  view.dismiss('power-a');
  assert.equal(view.groups[1].hidden, true);
  assert.equal(view.banner.hidden, true);
  assert.equal(view.conditionsRow.hidden, true);
  assert.equal(view.root.hidden, true);
  assert.equal(view.classes.has('has-alerts'), false);
  assert.equal(view.document.activeElement, view.heading);
  assert.equal(view.heading.attributes.get('tabindex'), '-1');
  assert(view.heading.scrolled);
});

test('all saved dismissals keep the banner and alert-only section hidden on arrival', () => {
  const storage = new Map(['traffic-a', 'traffic-b', 'power-a'].map(id => [key(id), '1']));
  const view = page({ storage });
  assert.equal(view.banner.hidden, true);
  assert.equal(view.root.hidden, true);
  assert(view.groups.every(group => group.hidden));
});

test('preserves weather and availability notices when all alerts are dismissed', () => {
  for (const [weather, notice] of [[true, false], [false, true], [true, true]]) {
    const view = page({ ids: ['traffic-a'], weather, notice });
    view.dismiss('traffic-a');
    assert.equal(view.banner.hidden, true);
    assert.equal(view.root.hidden, false);
    assert.equal(view.conditionsRow.hidden, !weather);
    assert.equal(view.classes.has('has-alerts'), false);
    assert.equal(view.classes.has('has-weather'), weather);
    assert.equal(view.document.activeElement, weather ? view.weatherHeading : view.heading);
  }
});

test('storage read or access failures show alerts after the attempted check', () => {
  for (const failure of [{ readFails: true }, { accessFails: true }]) {
    const view = page({ ...failure, storage: new Map([[key('traffic-a'), '1']]) });
    assert.equal(view.banner.hidden, false);
    assert.deepEqual(view.visible(), ['traffic-a', 'traffic-b', 'power-a']);
    view.dismiss('traffic-a');
    assert.deepEqual(view.visible(), ['traffic-b', 'power-a']);
    view.emit('pageshow');
    assert.deepEqual(view.visible(), failure.accessFails ? ['traffic-b', 'power-a'] : ['traffic-a', 'traffic-b', 'power-a']);
  }
});

test('failed writes preserve in-memory dismissals through history restoration', () => {
  const storage = new Map();
  const view = page({ storage, writeFails: true });
  view.dismiss('traffic-a');
  assert.equal(storage.size, 0);
  view.emit('pagehide');
  assert.equal(view.banner.hidden, true);
  view.emit('pageshow');
  assert.deepEqual(view.visible(), ['traffic-b', 'power-a']);
  assert.deepEqual(page({ storage }).visible(), ['traffic-a', 'traffic-b', 'power-a']);
});

test('history snapshots stay hidden until fresh storage checks, including changes in another tab', () => {
  const storage = new Map(); let restoring = false;
  const view = page({ storage, weather: true, onRead({ banner }) { if (restoring) assert.equal(banner.hidden, true); } });
  view.document.activeElement = view.rows[0].source;
  view.emit('pagehide'); restoring = true;
  assert.equal(view.banner.hidden, true);
  assert.equal(view.classes.has('has-alerts'), false);
  assert.equal(view.root.hidden, false);
  assert.equal(view.document.activeElement, null);
  storage.set(key('traffic-a'), '1');
  view.emit('pageshow');
  assert.deepEqual(view.visible(), ['traffic-b', 'power-a']);
  assert(view.classes.has('has-alerts'));
  assert.equal(view.pending.size, 0);
});

test('clearing storage resets saved dismissals including ones written on the current page', () => {
  for (const dismissedHere of [false, true]) {
    const storage = new Map(dismissedHere ? [] : [[key('traffic-a'), '1']]);
    const view = page({ storage });
    if (dismissedHere) view.dismiss('traffic-a');
    assert.equal(view.rows[0].hidden, true);
    view.emit('pagehide'); storage.clear(); view.emit('pageshow');
    assert.equal(view.rows[0].hidden, false);
    assert.equal(view.reads.length, 6);
  }
});

test('focus moves to the next surviving row then the previous one, even after native blur', () => {
  const view = page();
  view.dismiss('traffic-b');
  assert.equal(view.document.activeElement, view.rows[2].summary);
  assert(view.rows[2].summary.scrolled);
  view.dismiss('power-a');
  assert.equal(view.document.activeElement, view.rows[0].summary);
  const empty = page({ ids: ['traffic-a'], news: false });
  empty.dismiss('traffic-a');
  assert.equal(empty.document.activeElement, empty.main);
  assert.equal(empty.main.attributes.get('tabindex'), '-1');
});

test('does not steal focus from outside the dismissed alert', () => {
  const view = page();
  view.document.activeElement = view.main;
  view.dismiss('traffic-a', false);
  assert.equal(view.document.activeElement, view.main);
});

test('ignores unrelated storage and invalid dismissal values', () => {
  const storage = new Map([[key('traffic-a'), 'false'], ['lakearrowhead-theme', 'night-sky']]);
  const view = page({ storage });
  assert.equal(view.rows[0].hidden, false);
  assert.equal(storage.get('lakearrowhead-theme'), 'night-sky');
});

test('reveals legacy alerts with no rows or missing identifiers without consulting storage', () => {
  for (const ids of [[], [null], ['traffic-a', null]]) {
    const view = page({ ids, storage: new Map([[key('traffic-a'), '1']]) });
    assert.equal(view.banner.hidden, false);
    assert(view.rows.every(row => !row.hidden));
    assert.equal(view.reads.length, 0);
    assert.equal(view.pending.size, 0);
  }
});

test('missing controls and optional containers do not stop initialization', () => {
  for (const options of [{ missingButton: 0 }, { missingRoot: true }, { missingContainer: true }]) {
    const view = page(options);
    assert.deepEqual(view.visible(), ['traffic-a', 'traffic-b', 'power-a']);
    view.dismiss('traffic-b');
    assert.deepEqual(view.visible(), ['traffic-a', 'power-a']);
  }
});

test('pages without alerts do not access storage or register history handlers', () => {
  runInNewContext(script, { document: { querySelector: () => null, documentElement: { classList: { remove() {} } } } });
});

test('the independent bootstrap restores weather visibility after one second if initialization fails', () => {
  const classes = new Set(); let fallback;
  runInNewContext(bootstrap, {
    document: { documentElement: { classList: { add: name => classes.add(name), remove: name => classes.delete(name) } } },
    setTimeout(callback, delay) { assert.equal(delay, 1000); fallback = callback; },
  });
  assert(classes.has('conditions-pending'));
  fallback();
  assert.equal(classes.size, 0);
});
