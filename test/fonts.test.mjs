import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = html.match(/<script id="theme-fonts">([\s\S]*?)<\/script>/)[1];
function fonts(theme) {
  const links = new Map();
  const document = {
    cookie: theme ? `lakearrowhead_theme=${theme}` : '',
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
