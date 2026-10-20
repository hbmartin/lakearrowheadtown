import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Bundle the real entry points, including HTML imports, without writing artifacts.
export async function loadRenderers(siteOverrides) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const plugins = siteOverrides ? [{
    name: 'site-fixture',
    setup(builder) {
      builder.onLoad({ filter: /[/\\]src[/\\]site\.ts$/ }, async ({ path }) => ({
        contents: (await readFile(path, 'utf8')).replace('export const SITE =', 'const baseSite =')
          + `\nexport const SITE = { ...baseSite, ...${JSON.stringify(siteOverrides)} };`,
        loader: 'ts',
      }));
    },
  }] : [];
  const result = await build({
    stdin: {
      contents: `export { renderPage, renderContentPage, renderArchivePage } from './src/render';
        export { default as notFoundPage } from './src/not-found';
        export { withThemeHead } from './src/theme'; export { SITE } from './src/site';`,
      resolveDir: root,
    },
    bundle: true, format: 'esm', platform: 'node', write: false, plugins,
    loader: { '.html': 'text', '.svg': 'text', '.wasm': 'binary', '.ttf': 'binary' },
  });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
}

export const renderers = await loadRenderers();
const { SITE, renderPage, renderContentPage, renderArchivePage, notFoundPage } = renderers;
export const pages = {
  homepage: renderPage([], { origin: SITE.origin }),
  archive: renderArchivePage(SITE.origin, { date: '2026-10-19', stories: [], images: {} }, {
    key: `archive-days/${'a'.repeat(64)}.json`, image: `/assets/daily/${'b'.repeat(64)}.png`, identities: [],
  }),
  resource: renderContentPage(SITE.origin, { path: '/road-conditions/', title: 'Road conditions' }, 'Road conditions', '<p>Official information.</p>'),
  notFound: notFoundPage,
};
