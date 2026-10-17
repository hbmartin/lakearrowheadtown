import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { ASSETS, SITE } from '../src/site.ts';

const root = new URL('../', import.meta.url);
const source = new URL('assets/source/', root);
const read = url => readFileSync(url, 'utf8');
const escapeXml = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
const tree = read(new URL('favicon.svg', root)).match(/<path\b[^>]*\/>/)[0].replace('fill="#171717"', `fill="${SITE.foreground}"`);
const values = { BACKGROUND: SITE.background, FOREGROUND: SITE.foreground, NAME: escapeXml(SITE.name), SUBTITLE: escapeXml(SITE.subtitle), TREE: tree };
const expand = filename => read(new URL(filename, source)).replace(/\{\{(\w+)\}\}/g, (_, name) => {
  if (!(name in values)) throw new Error(`Unknown artwork token: ${name}`);
  return values[name];
});
const fonts = ['InstrumentSerif-Regular.ttf', 'DMSans.ttf'].map(name => fileURLToPath(new URL(`fonts/${name}`, source)));
const png = (svg, width) => new Resvg(svg, {
  fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: false, fontFiles: fonts },
}).render().asPng();
const write = (path, bytes) => writeFileSync(new URL(path.slice(1), root), bytes);
const icon = expand('icon.svg');
write(ASSETS.social, png(expand('social-card.svg'), 1200));
for (const [path, size] of [[ASSETS.favicon48, 48], [ASSETS.appleTouch, 180], [ASSETS.icon192, 192], [ASSETS.icon512, 512]]) {
  write(path, png(icon, size));
}

// ICO directory entries point to PNG-compressed frames at each native size.
const sizes = [16, 32, 48];
const frames = sizes.map(size => png(icon, size));
const directory = Buffer.alloc(6 + sizes.length * 16);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(sizes.length, 4);
let offset = directory.length;
frames.forEach((frame, i) => {
  const entry = 6 + i * 16;
  directory[entry] = directory[entry + 1] = sizes[i];
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(frame.length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += frame.length;
});
write(ASSETS.favicon, Buffer.concat([directory, ...frames]));
console.log('Generated social card and icons from the shared site identity and SVG sources.');
