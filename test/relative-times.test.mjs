import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const template = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = template.match(/<script id="relative-times">([\s\S]*?)<\/script>/)[1];
const now = Date.parse('2026-10-17T19:00:00Z');

// Run the actual browser script with controllable time and document visibility.
function page(timestamps) {
  let clock = now;
  const elements = timestamps.map(timestamp => {
    const attributes = new Map([['datetime', timestamp]]);
    const visible = { title: 'Exact Los Angeles time', textContent: 'Oct 17, 12:00 PM PDT' };
    const spoken = { textContent: 'Oct 17, 12:00 PM PDT' };
    return {
      visible, spoken,
      getAttribute: name => attributes.get(name),
      querySelector: selector => selector === '[aria-hidden="true"]' ? visible : spoken,
    };
  });
  const listeners = new Map();
  const timers = [];
  const document = {
    hidden: false,
    querySelectorAll: () => elements,
    addEventListener: (event, callback) => listeners.set(event, callback),
  };
  runInNewContext(script, {
    document,
    Date: class extends Date { static now() { return clock; } },
    setInterval: (callback, delay) => timers.push({ callback, delay }),
  });
  return {
    elements, timers,
    advance: milliseconds => { clock += milliseconds; for (const timer of timers) timer.callback(); },
    visibility: hidden => { document.hidden = hidden; listeners.get('visibilitychange')?.(); },
  };
}

test('post ages use minute, hour, and day boundaries without changing original instants', () => {
  const cases = [
    [0, 'just now'], [59, 'just now'], [60, '1 min ago'], [12 * 60, '12 min ago'],
    [3599, '59 min ago'], [3600, '1 hr ago'], [3 * 3600, '3 hr ago'],
    [86399, '23 hr ago'], [86400, '1 day ago'], [2 * 86400, '2 days ago'],
    [40 * 86400, '40 days ago'],
    [-59, 'just now'], [-60, 'in 1 min'], [-3600, 'in 1 hr'],
    [-3 * 3600, 'in 3 hr'], [-86400, 'in 1 day'], [-2 * 86400, 'in 2 days'],
  ];
  const timestamps = cases.map(([seconds]) => new Date(now - seconds * 1000).toISOString());
  const view = page(timestamps);
  for (const [index, [, label]] of cases.entries()) {
    const element = view.elements[index];
    assert.equal(element.visible.textContent, label);
    assert.equal(element.spoken.textContent, label);
    assert.equal(element.getAttribute('datetime'), timestamps[index]);
    assert.equal(element.visible.title, 'Exact Los Angeles time');
    assert.equal(element.getAttribute('aria-label'), undefined);
  }
});

test('relative times refresh each minute and immediately when a hidden page returns', () => {
  const view = page([new Date(now - 59000).toISOString()]);
  assert.equal(view.timers[0].delay, 60000);
  assert.equal(view.elements[0].visible.textContent, 'just now');
  view.advance(60000);
  assert.equal(view.elements[0].visible.textContent, '1 min ago');
  view.visibility(true);
  view.advance(3 * 3600000);
  assert.equal(view.elements[0].visible.textContent, '1 min ago');
  assert.equal(view.elements[0].spoken.textContent, '1 min ago');
  view.visibility(false);
  assert.equal(view.elements[0].visible.textContent, '3 hr ago');
  assert.equal(view.elements[0].spoken.textContent, '3 hr ago');
});

test('equivalent timezone offsets show the same age across a daylight-saving transition', () => {
  const view = page(['2026-11-01T01:30:00-07:00', '2026-11-01T08:30:00Z', '2026-11-01T01:30:00-08:00']);
  view.advance(Date.parse('2026-11-01T10:30:00Z') - now);
  assert.deepEqual(view.elements.map(element => element.visible.textContent), ['2 hr ago', '2 hr ago', '1 hr ago']);
  assert.deepEqual(view.elements.map(element => element.spoken.textContent), ['2 hr ago', '2 hr ago', '1 hr ago']);
});

test('empty feeds and invalid timestamps retain their fallback without starting a timer', () => {
  assert.equal(page([]).timers.length, 0);
  const invalid = page(['not a timestamp']);
  assert.equal(invalid.timers.length, 0);
  assert.equal(invalid.elements[0].visible.textContent, 'Oct 17, 12:00 PM PDT');
  assert.equal(invalid.elements[0].spoken.textContent, 'Oct 17, 12:00 PM PDT');
  assert.equal(invalid.elements[0].getAttribute('aria-label'), undefined);
});
