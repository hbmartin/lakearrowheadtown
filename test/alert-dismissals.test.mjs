import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { pages } from './helpers/rendered-pages.mjs';

const script = pages.homepage.match(/<script id="alert-dismissals">([\s\S]*?)<\/script>/)[1];
const key = id => 'lakearrowhead-dismissed-alert:v1:' + id;

// Execute the shipped script with controllable storage, focus, and history events.
function page({ ids = ['traffic-a', 'traffic-b', 'power-a'], storage = new Map(), weather = false, notice = false,
  readFails = false, writeFails = false, accessFails = false, onRead, onWrite } = {}) {
  const listeners = new Map();
  const classes = new Set(weather ? ['has-weather'] : []);
  const document = { activeElement: null };
  const home = { focus() { document.activeElement = this; } };
  const rows = ids.map(id => {
    const row = { dataset: { alertId: id }, hidden: false };
    const summary = { focus() { document.activeElement = this; } };
    const button = { addEventListener: (type, callback) => listeners.set(`${id}:${type}`, callback) };
    const source = {};
    return Object.assign(row, { summary, button, source,
      contains: target => [summary, button, source].includes(target),
      querySelector: selector => selector === 'summary' ? summary : button,
    });
  });
  const groups = ['traffic', 'power'].map(category => ({ hidden: false,
    contains: row => row.dataset.alertId.startsWith(category),
  }));
  const conditionsRow = { hidden: !weather };
  const root = { hidden: !weather && !notice,
    classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } },
    querySelector: selector => ({ '.conditions-row': conditionsRow, '.weather-card': weather || null, '.conditions-unavailable': notice || null })[selector],
  };
  const banner = { hidden: true, closest: () => root,
    querySelectorAll: selector => selector === '.alert-item' ? rows : groups,
  };
  document.querySelector = selector => selector === '.alerts-banner' ? banner : home;
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
  return { banner, root, rows, groups, conditionsRow, classes, document, home, reads, writes,
    emit: type => listeners.get(type)?.(),
    dismiss(id, focused = true) {
      const row = rows.find(row => row.dataset.alertId === id);
      if (focused) document.activeElement = row.button;
      listeners.get(`${id}:click`)();
    },
    visible: () => rows.filter(row => !row.hidden).map(row => row.dataset.alertId),
  };
}

test('keeps the banner hidden until every saved dismissal is checked', () => {
  const view = page({ onRead({ banner }) { assert.equal(banner.hidden, true); } });
  assert.equal(view.reads.length, 3);
  assert.deepEqual(view.visible(), ['traffic-a', 'traffic-b', 'power-a']);
  assert.equal(view.banner.hidden, false);
  assert.equal(view.root.hidden, false);
  assert.equal(view.conditionsRow.hidden, false);
  assert(view.classes.has('has-alerts'));
  assert.equal(view.writes.length, 0);
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
  assert.equal(view.document.activeElement, view.home);
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
  }
});

test('storage read or access failures show alerts, and dismissal still works for this page', () => {
  for (const failure of [{ readFails: true }, { accessFails: true }]) {
    const view = page({ ...failure, storage: new Map([[key('traffic-a'), '1']]) });
    assert.equal(view.banner.hidden, false);
    assert.deepEqual(view.visible(), ['traffic-a', 'traffic-b', 'power-a']);
    view.dismiss('traffic-a'); view.emit('pageshow');
    assert.deepEqual(view.visible(), ['traffic-b', 'power-a']);
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
  assert.equal(view.document.activeElement, view.rows[0].source);
  storage.set(key('traffic-a'), '1');
  view.emit('pageshow');
  assert.deepEqual(view.visible(), ['traffic-b', 'power-a']);
  assert.equal(view.document.activeElement, view.rows[1].summary);
  assert(view.classes.has('has-alerts'));
});

test('cleared stored dismissals are rechecked on history restoration', () => {
  const storage = new Map([[key('traffic-a'), '1']]);
  const view = page({ storage });
  assert.equal(view.rows[0].hidden, true);
  view.emit('pagehide'); storage.clear(); view.emit('pageshow');
  assert.equal(view.rows[0].hidden, false);
});

test('does not steal focus from outside the dismissed alert', () => {
  const view = page();
  view.document.activeElement = view.home;
  view.dismiss('traffic-a', false);
  assert.equal(view.document.activeElement, view.home);
});

test('ignores unrelated storage and invalid dismissal values', () => {
  const storage = new Map([[key('traffic-a'), 'false'], ['lakearrowhead-theme', 'night-sky']]);
  const view = page({ storage });
  assert.equal(view.rows[0].hidden, false);
  assert.equal(storage.get('lakearrowhead-theme'), 'night-sky');
});

test('pages without alerts do not access storage or register history handlers', () => {
  runInNewContext(script, { document: { querySelector: () => null } });
});
