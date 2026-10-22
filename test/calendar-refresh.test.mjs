import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
const result = await build({ stdin: { contents: "export { renderCalendarPage } from './src/calendar';", resolveDir: process.cwd() }, bundle: true, format: 'esm', platform: 'node', write: false, loader: { '.html': 'text', '.svg': 'text', '.wasm': 'binary', '.ttf': 'binary' } });
const { renderCalendarPage } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
const html = renderCalendarPage('https://lakearrowhead.town', { as_of: '2026-10-22T18:00:00Z', days: 30, published_at: null, events: [] });
const script = html.match(/<script id="calendar-window">([\s\S]*?)<\/script>/)[1];
function execute(date, storage = new Map(), broken = false) {
  let reloads = 0; let poll;
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [date])); } }
  runInNewContext(script, { Date: Clock, Intl, document: { visibilityState: 'visible', addEventListener() {} }, location: { reload() { reloads++; } }, setInterval(callback) { poll = callback; }, sessionStorage: { getItem(key) { if (broken) throw Error('disabled'); return storage.get(key); }, setItem(key, value) { if (broken) throw Error('disabled'); storage.set(key, value); } } });
  poll(); poll(); return reloads;
}
test('calendar refresh advances once, guards reload loops, and tolerates disabled storage', () => {
  const storage = new Map();
  assert.equal(execute('2026-10-21T18:00:00Z'), 0);
  assert.equal(execute('2026-10-23T18:00:00Z', storage), 1);
  assert.equal(execute('2026-10-23T18:00:00Z', storage), 0);
  assert.equal(execute('2026-10-23T18:00:00Z', new Map(), true), 0);
});
