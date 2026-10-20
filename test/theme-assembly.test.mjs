import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { runInContext } from 'node:vm';
import test from 'node:test';
import { loadRenderers, pages, renderers } from './helpers/rendered-pages.mjs';
import { paletteRules, themeHead } from './helpers/theme-head.mjs';

test('theme assembly rejects missing, misspelled, duplicate and misplaced markers', () => {
  for (const template of [
    '<head></head>', '<head><!-- theme-haed --></head>',
    '<head><!-- theme-head --><!-- theme-head --></head>',
    '<!-- theme-head --><head></head>', '<head></head><body><!-- theme-head --></body>',
    '<head><!-- theme-head -->',
  ]) assert.throws(() => renderers.withThemeHead(template), /exactly one theme-head marker inside <head>/);
  assert.match(renderers.withThemeHead('<head><!-- theme-head --></head>'), /name="theme-color"/);
  for (const template of ['<HEAD><!-- theme-head --></HEAD>', '<HeAd data-test="head"><!-- theme-head --></hEaD >']) {
    assert.match(renderers.withThemeHead(template), /name="theme-color"/);
    assert.throws(() => renderers.withThemeHead(template.replace('<!-- theme-head -->', '') + '<!-- theme-head -->'), /inside <head>/);
  }
});

test('site placeholders are centrally escaped and unsupported or incomplete markers fail', async () => {
  const hostile = `Town & <script>alert("x")</script> 'quoted' $&`;
  const fixture = await loadRenderers({ name: hostile });
  const template = '<head><!-- theme-head --><title>{{site.name}}</title></head><body><a title="{{site.name}}">{{site.name}}</a></body>';
  const html = fixture.withThemeHead(template);
  assert(!html.includes(hostile));
  assert.equal((html.match(/Town &amp; &lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &#39;quoted&#39; \$&/g) ?? []).length, 3);
  assert(fixture.notFoundPage.includes('Town &amp; &lt;script&gt;'));
  for (const value of ['{{site.unknown}}', '{{site.constructor}}', '{{site.name']) {
    assert.throws(() => renderers.withThemeHead(`<head><!-- theme-head --></head><body>${value}</body>`), /site placeholder/);
  }
  for (const key of ['background', 'foreground']) {
    await assert.rejects(loadRenderers({ [key]: '</style><script>private()</script>' }), /Invalid site CSS color/);
  }
});

test('each renderer owns one ordered theme-color meta and restores it during head parsing', () => {
  const colors = { 'deep-lake-lodge': '#F8F6F1', 'golden-hour-dock': '#F5EEDC', 'morning-mist': '#F2F4F3', 'village-heritage': '#FFF9F0', 'night-sky': '#0B1426' };
  for (const html of Object.values(pages)) {
    assert.equal((html.match(/<meta name="theme-color"/g) ?? []).length, 1);
    assert(html.indexOf('name="theme-color"') < html.indexOf('<script id="theme-color">'));
    assert(html.indexOf('<script id="theme-color">') < html.indexOf('</head>'));
    assert(!/\{\{site\.|<!-- theme-head -->/.test(html));
    for (const [theme, color] of Object.entries(colors)) {
      const view = themeHead(html, theme);
      assert.equal(view.metas.find(meta => meta.name === 'theme-color').content, color);
      assert.equal(runInContext('typeof themeColor', view.context), 'undefined');
      assert.doesNotThrow(() => runInContext('const themeColor = "later script";', view.context));
    }
  }
});

test('essential palettes agree across renderers while only normal pages carry decoration', () => {
  const core = new Map(paletteRules(pages.notFound).map(rule => [rule.theme, rule.values]));
  for (const [name, html] of Object.entries(pages)) {
    if (name === 'notFound') continue;
    const rules = paletteRules(html);
    for (const [theme, values] of core) {
      const combined = new Map(rules.filter(rule => rule.theme === theme).flatMap(rule => rule.values));
      for (const [key, value] of values) assert.equal(combined.get(key), value);
    }
    assert.match(html, /--texture:|--texture-size:/);
    assert.match(html, /data:image\/svg\+xml/);
  }
  assert(!/--(?:texture|atmosphere|surface|shadow|gutter|radius)|data:image\//.test(pages.notFound));
  const full = renderers.withThemeHead('<head><!-- theme-head --></head>');
  const essential = renderers.withThemeHead('<head><!-- theme-head --></head>', { decorations: false });
  assert(Buffer.byteLength(essential) < Buffer.byteLength(full) * 0.6);
  assert(gzipSync(essential).length < gzipSync(full).length);
});
