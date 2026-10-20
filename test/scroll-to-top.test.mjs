import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const template = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = template.match(/<script id="scroll-to-top">([\s\S]*?)<\/script>/)[1];

// Execute the shipped script with controllable scroll geometry and animation frames.
function page({ height = 2800, viewport = 800, offset = 0, reducedMotion = false, resizeObserver = true, scrollingElement = true } = {}) {
  const listeners = new Map();
  const frames = [];
  const scrolls = [];
  const focus = [];
  const observed = [];
  const listen = target => (type, callback, options) => listeners.set(`${target}:${type}`, { callback, options });
  const root = { scrollHeight: height, clientHeight: viewport, scrollTop: offset };
  const ring = { style: {} };
  const button = { hidden: true, querySelector: () => ring, addEventListener: listen('button') };
  const outside = {};
  const home = { focus(options) { focus.push(options); document.activeElement = home; } };
  const document = {
    scrollingElement: scrollingElement ? root : null,
    documentElement: root,
    body: {},
    activeElement: outside,
    getElementById: id => id === 'back-to-top' ? button : null,
    querySelector: selector => selector === '.site-title' ? home : null,
  };
  let resize;
  const Observer = class {
    constructor(callback) { resize = callback; }
    observe(element) { observed.push(element); }
  };
  const window = {
    addEventListener: listen('window'),
    matchMedia: query => ({ matches: query === '(prefers-reduced-motion: reduce)' && reducedMotion }),
    scrollTo: options => scrolls.push(options),
    ...(resizeObserver ? { ResizeObserver: Observer } : {}),
  };
  runInNewContext(script, {
    document, window, ResizeObserver: Observer,
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
  });
  const emit = (type, target = 'window') => listeners.get(`${target}:${type}`)?.callback();
  return {
    root, ring, button, document, home, outside, focus, frames, scrolls, observed, listeners, emit,
    flush() { const pending = frames.splice(0); for (const callback of pending) callback(); },
    scroll(offset) { root.scrollTop = offset; emit('scroll'); },
    resizeContent(height) { root.scrollHeight = height; resize?.(); },
    click() { emit('click', 'button'); },
    reducedMotion(value) { reducedMotion = value; },
  };
}

test('button starts hidden and becomes visible immediately after leaving the top', () => {
  const view = page();
  assert.equal(view.button.hidden, true);
  assert.equal(view.ring.style.strokeDashoffset, '100');
  view.scroll(1);
  view.flush();
  assert.equal(view.button.hidden, false);
  view.scroll(1000);
  view.flush();
  assert.equal(view.ring.style.strokeDashoffset, '50');
  view.scroll(2000);
  view.flush();
  assert.equal(view.ring.style.strokeDashoffset, '0');
  view.scroll(500);
  view.flush();
  assert.equal(view.button.hidden, false);
  assert.equal(view.ring.style.strokeDashoffset, '75');
  view.scroll(0);
  view.flush();
  assert.equal(view.button.hidden, true);
});

test('short pages and elastic overscroll never produce invalid progress', () => {
  for (const height of [400, 800]) {
    const view = page({ height, offset: 10 });
    assert.equal(view.button.hidden, true);
    assert.equal(view.ring.style.strokeDashoffset, '100');
  }
  const view = page();
  view.scroll(-100);
  view.flush();
  assert.equal(view.button.hidden, true);
  assert.equal(view.ring.style.strokeDashoffset, '100');
  view.scroll(2100);
  view.flush();
  assert.equal(view.button.hidden, false);
  assert.equal(view.ring.style.strokeDashoffset, '0');
});

test('initial and restored scroll positions render progress without a new scroll gesture', () => {
  for (const scrollingElement of [true, false]) {
    const view = page({ offset: 1000, scrollingElement });
    assert.equal(view.button.hidden, false);
    assert.equal(view.ring.style.strokeDashoffset, '50');
    view.root.scrollTop = 2000;
    view.emit('pageshow');
    view.flush();
    assert.equal(view.ring.style.strokeDashoffset, '0');
  }
});

test('scroll bursts and resize updates share one animation frame using the latest geometry', () => {
  const view = page();
  assert.equal(view.listeners.get('window:scroll').options.passive, true);
  view.scroll(500);
  view.scroll(750);
  view.scroll(1000);
  view.root.clientHeight = 1800;
  view.emit('resize');
  assert.equal(view.frames.length, 1);
  view.flush();
  assert.equal(view.ring.style.strokeDashoffset, '0');
  view.scroll(500);
  assert.equal(view.frames.length, 1);
  view.flush();
  assert.equal(view.ring.style.strokeDashoffset, '50');
});

test('content-height and image-load changes recompute progress without scrolling', () => {
  const view = page({ offset: 1000 });
  assert.equal(view.observed[0], view.document.body);
  view.resizeContent(4800);
  view.flush();
  assert.equal(view.ring.style.strokeDashoffset, '75');
  view.resizeContent(800);
  view.flush();
  assert.equal(view.button.hidden, true);
  const fallback = page({ offset: 1000, resizeObserver: false });
  assert.equal(fallback.listeners.get('window:load').options, true);
  fallback.root.scrollHeight = 4800;
  fallback.emit('load');
  fallback.flush();
  assert.equal(fallback.ring.style.strokeDashoffset, '75');
});

test('activation returns to the top and respects the current reduced-motion preference', () => {
  const view = page({ offset: 1000 });
  view.click();
  assert.equal(view.scrolls[0].top, 0);
  assert.equal(view.scrolls[0].behavior, 'smooth');
  view.reducedMotion(true);
  view.click();
  assert.equal(view.scrolls[1].top, 0);
  assert.equal(view.scrolls[1].behavior, 'instant');
});

test('hiding transfers focus to the home link only when the button owns focus', () => {
  const view = page({ offset: 1000 });
  view.document.activeElement = view.button;
  view.scroll(500);
  view.flush();
  assert.equal(view.focus.length, 0);
  view.scroll(0);
  view.flush();
  assert.equal(view.button.hidden, true);
  assert.equal(view.document.activeElement, view.home);
  assert.equal(view.focus.length, 1);
  assert.equal(view.focus[0].preventScroll, true);
  view.scroll(500);
  view.flush();
  view.document.activeElement = view.outside;
  view.scroll(0);
  view.flush();
  assert.equal(view.document.activeElement, view.outside);
  assert.equal(view.focus.length, 1);
});
