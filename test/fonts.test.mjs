import assert from 'node:assert/strict';
import test from 'node:test';
import { pages } from './helpers/rendered-pages.mjs';
import { themeHead } from './helpers/theme-head.mjs';

test('every rendered page defaults to local fonts without an unconditional Google Fonts stylesheet', () => {
  for (const [name, html] of Object.entries(pages)) {
    const { links } = themeHead(html);
    assert.equal(links.size, 0, name);
    assert(!/<link\b[^>]*\bhref\s*=\s*["'][^"']*(?:fonts\.googleapis\.com|fonts\.gstatic\.com)/i.test(html), name);
    assert(!/@import\b[^;]*(?:fonts\.googleapis\.com|fonts\.gstatic\.com)/i.test(html), name);
    for (const family of ['dm-sans', 'instrument-serif']) assert(html.includes(`/assets/fonts/${family}-v1.woff2`), name);
    assert.match(html, /font-display: swap/);
  }
});

test('all saved themes restore their palette and only their required optional family on every page', () => {
  for (const html of Object.values(pages)) {
    for (const [theme, family] of [['deep-lake-lodge'], ['golden-hour-dock', 'Newsreader'], ['morning-mist'], ['village-heritage', 'Fraunces'], ['night-sky']]) {
      const { document, links } = themeHead(html, theme);
      assert.equal(document.documentElement.dataset.theme, theme);
      assert.equal(links.size, family ? 1 : 0);
      if (family) assert(links.get(`font-${family}`).href.includes(`family=${family}`));
    }
    assert.match(html, /:root\[data-theme="night-sky"\]\s*\{\s*color-scheme: dark/);
  }
});

test('invalid and unavailable theme cookies retain the default without optional requests', () => {
  for (const html of Object.values(pages)) for (const [theme, blocked] of [['unknown'], ['constructor'], ['__proto__'], ['<script>'], ['night-sky', true]]) {
    const { document, links } = themeHead(html, theme, blocked);
    assert.equal(document.documentElement.dataset.theme, 'deep-lake-lodge');
    assert.equal(links.size, 0);
  }
});

test('optional theme fonts load once and inherited property names cannot select families', () => {
  for (const html of Object.values(pages)) {
    const { links, window, document } = themeHead(html, 'golden-hour-dock');
    assert.equal(document.documentElement.dataset.theme, 'golden-hour-dock');
    assert.equal(links.size, 1);
    assert.match(links.get('font-Newsreader').href, /family=Newsreader/);
    for (const theme of ['golden-hour-dock', 'village-heritage', 'village-heritage', 'morning-mist', 'constructor', '__proto__', 'toString', 'unknown', undefined]) window.loadThemeFont(theme);
    assert.equal(links.size, 2);
    assert.match(links.get('font-Fraunces').href, /family=Fraunces/);
  }
});
