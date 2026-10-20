import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { compress } from 'wawoff2';
const root = new URL('../', import.meta.url);
await mkdir(new URL('assets/fonts/', root), { recursive: true });
for (const [source, target] of [['DMSans.ttf', 'dm-sans-v1.woff2'], ['InstrumentSerif-Regular.ttf', 'instrument-serif-v1.woff2']]) {
  const bytes = await readFile(new URL(`assets/source/fonts/${source}`, root));
  await writeFile(new URL(`assets/fonts/${target}`, root), await compress(bytes));
}
console.log('Generated versioned WOFF2 fonts from the bundled, licensed TTFs.');
