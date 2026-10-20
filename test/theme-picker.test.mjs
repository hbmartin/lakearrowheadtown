import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const template = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = template.match(/<script id="theme-picker">([\s\S]*?)<\/script>/)[1];

// Exercise the real script's event handlers; browser QA covers native focus/keys.
function page() {
  let triggerBottom = 100;
  const listeners = new Map();
  const focus = [];
  const cookies = [];
  const listen = target => (type, callback) => listeners.set(`${target}:${type}`, callback);
  const emit = (target, type, event = {}) => listeners.get(`${target}:${type}`)?.(event);
  const document = { documentElement: { dataset: { theme: 'deep-lake-lodge' } }, addEventListener: listen('document') };
  const element = name => ({
    name, addEventListener: listen(name),
    focus() {
      const previous = document.activeElement;
      document.activeElement = this;
      focus.push(name);
      if (picker.contains(previous)) emit('picker', 'focusout', { relatedTarget: this });
    },
  });
  const body = element('body');
  const outside = element('outside');
  const attributes = new Map();
  const trigger = { ...element('trigger'), setAttribute: (name, value) => attributes.set(name, value), getBoundingClientRect: () => ({ bottom: triggerBottom }) };
  const panel = { ...element('panel'), hidden: true, style: {}, scrollTop: 0, get clientHeight() { const height = Number.parseFloat(this.style.maxHeight); return Number.isNaN(height) ? 800 : height; } };
  const radios = ['deep-lake-lodge', 'golden-hour-dock', 'morning-mist', 'village-heritage', 'night-sky'].map((value, index) => {
    let checked = index === 0;
    const label = { querySelector: () => ({ textContent: value }), offsetTop: 50 + index * 100, offsetHeight: 90, scrollIntoView() { throw new Error('Picker must not scroll the page'); } };
    const radio = { ...element(value), value, closest: () => label };
    Object.defineProperty(radio, 'checked', {
      get: () => checked,
      set(value) { checked = value; if (value) for (const other of radios) if (other !== radio) other.checked = false; },
    });
    return radio;
  });
  const picker = { hidden: true, addEventListener: listen('picker'), querySelector: () => trigger, querySelectorAll: () => radios, contains: node => [trigger, panel, ...radios].includes(node) };
  const themeColor = {};
  Object.defineProperty(document, 'cookie', { set: value => cookies.push(value) });
  Object.assign(document, {
    activeElement: body,
    querySelector: selector => selector === '.theme-picker' ? picker : themeColor,
    getElementById: () => panel,
  });
  const context = { document, window: { addEventListener: listen('window') }, innerHeight: 800, location: { protocol: 'https:' }, getComputedStyle: () => ({ getPropertyValue: () => '#F8F6F1' }) };
  runInNewContext(script, context);
  const key = (value, target = document.activeElement, shiftKey = false) => {
    const event = { key: value, target, shiftKey, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    emit(target.name, 'keydown', event);
    if (picker.contains(target)) emit('picker', 'keydown', event);
    emit('document', 'keydown', event);
    return event;
  };
  return {
    document, trigger, panel, radios, outside, attributes, focus, cookies, emit, key,
    open: () => emit('trigger', 'click'),
    change(index) { const radio = radios[index]; radio.checked = true; emit(radio.name, 'change'); },
    choose(index) { const radio = radios[index]; emit('document', 'pointerdown', { target: radio }); radio.checked = true; emit(radio.name, 'click'); emit(radio.name, 'change'); },
    resize(height, bottom = triggerBottom) { context.innerHeight = height; triggerBottom = bottom; emit('window', 'resize'); },
  };
}

test('explicit choices and reselecting the current theme save, close, and focus the button after WebKit blur', () => {
  const view = page();
  view.open();
  view.document.activeElement = { name: 'body' };
  view.emit('picker', 'focusout', { relatedTarget: null });
  assert.equal(view.panel.hidden, false);
  view.choose(2);
  assert.equal(view.document.documentElement.dataset.theme, 'morning-mist');
  assert.equal(view.panel.hidden, true);
  assert.equal(view.attributes.get('aria-expanded'), 'false');
  assert.equal(view.document.activeElement, view.trigger);
  assert.match(view.cookies.at(-1), /lakearrowhead_theme=morning-mist;.*Secure/);
  view.open();
  const writes = view.cookies.length;
  view.choose(2);
  assert(view.cookies.length > writes);
  assert.equal(view.panel.hidden, true);
  assert.equal(view.document.activeElement, view.trigger);
});

test('arrow changes keep saving with the panel open; Enter, Space, and Escape close without reverting', () => {
  const view = page();
  view.open();
  assert.equal(view.key('ArrowDown').defaultPrevented, false);
  view.radios[1].checked = true;
  view.emit(view.radios[1].name, 'click');
  view.change(1);
  view.emit('document', 'keyup');
  assert.equal(view.panel.hidden, false);
  assert.equal(view.document.documentElement.dataset.theme, 'golden-hour-dock');
  assert.match(view.cookies.at(-1), /lakearrowhead_theme=golden-hour-dock/);
  view.radios[1].focus();
  assert.equal(view.key('Enter').defaultPrevented, true);
  assert.equal(view.panel.hidden, true);
  assert.equal(view.document.activeElement, view.trigger);
  view.open();
  assert.equal(view.key(' ').defaultPrevented, true);
  assert.equal(view.panel.hidden, true);
  assert.equal(view.document.activeElement, view.trigger);
  view.open();
  view.change(4);
  view.key('Escape');
  assert.equal(view.panel.hidden, true);
  assert.equal(view.document.documentElement.dataset.theme, 'night-sky');
  assert.equal(view.document.activeElement, view.trigger);
});

test('Tab in either direction closes from the button without cancelling native navigation', () => {
  for (const shift of [false, true]) {
    const view = page();
    view.open();
    assert.equal(view.key('Tab', view.radios[0], shift).defaultPrevented, false);
    assert.equal(view.panel.hidden, true);
    assert.equal(view.document.activeElement, view.trigger);
  }
});

test('outside clicks, outside focus, and window blur close without restoring focus', () => {
  for (const departure of ['click', 'focus', 'window']) {
    const view = page();
    view.open();
    const count = view.focus.length;
    if (departure === 'click') view.emit('document', 'pointerdown', { target: view.outside });
    if (departure === 'focus') view.outside.focus();
    if (departure === 'window') view.emit('window', 'blur');
    assert.equal(view.panel.hidden, true);
    assert.equal(view.focus.slice(count).includes('trigger'), false);
    if (departure === 'focus') assert.equal(view.document.activeElement, view.outside);
  }
});

test('fits the selected option within the panel and caps height when the masthead is offscreen', () => {
  const view = page();
  view.radios[4].checked = true;
  view.resize(220);
  view.open();
  assert.equal(view.panel.style.maxHeight, '96px');
  assert.equal(view.panel.scrollTop, 444);
  view.resize(650, -500);
  assert.equal(view.panel.style.maxHeight, '626px');
  assert.equal(view.panel.hidden, false);
  view.resize(24);
  assert.equal(view.panel.style.maxHeight, '0px');
  assert.equal(view.panel.clientHeight, 0);
});

test('pointer selection and document keyup recover from interrupted arrow navigation', () => {
  const pointer = page(); pointer.open(); pointer.key('ArrowDown');
  pointer.choose(3);
  assert.equal(pointer.panel.hidden, true);
  assert.equal(pointer.document.documentElement.dataset.theme, 'village-heritage');
  const keyup = page(); keyup.open(); keyup.key('ArrowDown');
  keyup.document.activeElement = { name: 'body' };
  keyup.emit('document', 'keyup');
  keyup.radios[2].checked = true;
  keyup.emit(keyup.radios[2].name, 'click');
  assert.equal(keyup.panel.hidden, true);
  assert.equal(keyup.document.documentElement.dataset.theme, 'morning-mist');
});

test('restored theme colour is synchronized in the head before body parsing', () => {
  const head = template.split('</head>')[0];
  const restore = head.match(/<script id="theme-fonts">([\s\S]*?)<\/script>/)[1];
  const color = head.match(/<script id="theme-color">([\s\S]*?)<\/script>/)[1];
  const meta = { content: '#F8F6F1' };
  const document = { cookie: 'lakearrowhead_theme=night-sky', documentElement: { dataset: { theme: 'deep-lake-lodge' } }, querySelector: () => meta };
  const context = { document, window: {}, getComputedStyle: element => ({ getPropertyValue: () => element.dataset.theme === 'night-sky' ? '#0B1426' : '#F8F6F1' }) };
  runInNewContext(restore, context);
  runInNewContext(color, context);
  assert.equal(document.documentElement.dataset.theme, 'night-sky');
  assert.equal(meta.content, '#0B1426');
});
