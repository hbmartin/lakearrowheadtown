import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
const html = readFileSync(new URL('../src/theme-head.html', import.meta.url), 'utf8');
const script = html.match(/<script id="theme-fonts">([\s\S]*?)<\/script>/)[1];
function fonts(theme, blocked = false) {
  const links = new Map();
  const document = {
    get cookie() { if (blocked) throw new Error('Cookies unavailable'); return theme ? `lakearrowhead_theme=${theme}` : ''; },
    documentElement: { dataset: { theme: 'deep-lake-lodge' } },
    getElementById: id => links.get(id),
    createElement: () => ({}),
    head: { append(link) { links.set(link.id, link); } },
  };
  const window = {};
  runInNewContext(script, { document, window });
  return { links, window, document };
}
test('default theme uses local fonts without any Google Fonts stylesheet', () => {
  const { links } = fonts();
  assert.equal(links.size, 0);
  assert(!/<link[^>]+href="https:\/\/fonts\./.test(html));
  for (const family of ['dm-sans', 'instrument-serif']) assert(html.includes(`/assets/fonts/${family}-v1.woff2`));
  assert.match(html, /font-display: swap/);
  for (const path of ['../index.html', '../src/not-found.html']) {
    const template = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert(template.includes('<!-- theme-head -->'));
    assert(!template.includes('id="theme-fonts"'));
  }
});
test('all saved themes restore their palette and only their required optional family', () => {
  for (const [theme, family] of [['deep-lake-lodge'], ['golden-hour-dock', 'Newsreader'], ['morning-mist'], ['village-heritage', 'Fraunces'], ['night-sky']]) {
    const { document, links } = fonts(theme);
    assert.equal(document.documentElement.dataset.theme, theme);
    assert.equal(links.size, family ? 1 : 0);
    if (family) assert(links.get(`font-${family}`).href.includes(`family=${family}`));
  }
  assert.match(html, /:root\[data-theme="night-sky"\]\s*\{\s*color-scheme: dark/);
});
test('invalid and unavailable theme cookies retain the default without optional requests', () => {
  for (const [theme, blocked] of [['unknown'], ['__proto__'], ['<script>'], ['night-sky', true]]) {
    const { document, links } = fonts(theme, blocked);
    assert.equal(document.documentElement.dataset.theme, 'deep-lake-lodge');
    assert.equal(links.size, 0);
  }
});
test('optional theme fonts load once, including a restored choice', () => {
  const { links, window, document } = fonts('golden-hour-dock');
  assert.equal(document.documentElement.dataset.theme, 'golden-hour-dock');
  assert.equal(links.size, 1);
  assert.match(links.get('font-Newsreader').href, /family=Newsreader/);
  window.loadThemeFont('golden-hour-dock');
  window.loadThemeFont('village-heritage');
  window.loadThemeFont('village-heritage');
  window.loadThemeFont('morning-mist');
  assert.equal(links.size, 2);
  assert.match(links.get('font-Fraunces').href, /family=Fraunces/);
});
