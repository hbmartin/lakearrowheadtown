import { Resvg, initWasm } from '@resvg/resvg-wasm';
import wasm from '@resvg/resvg-wasm/index_bg.wasm';
import sans from '../assets/source/fonts/DMSans.ttf';
import serif from '../assets/source/fonts/InstrumentSerif-Regular.ttf';
import favicon from '../favicon.svg';
import { xmlText } from './xml';
import { dateLabel } from './dates';
import { SITE } from './site';

export const DAILY_CARD_VERSION = 1;
let initialized: Promise<void> | undefined;

// Bound both word and line lengths, including long unbroken source titles.
function lines(text: string): string[] {
  const words = text.replace(/\s+/gu, ' ').trim().match(/\S{1,32}/gu) ?? [];
  const output: string[] = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > 32) { output.push(line); line = ''; }
    line = (line + ' ' + word).trim();
  }
  if (line) output.push(line);
  if (output.length > 4) return [...output.slice(0, 3), output[3].slice(0, 30).trimEnd() + '…'];
  return output;
}

export async function dailyCard(date: string, headline: string): Promise<Uint8Array> {
  initialized ??= initWasm(wasm).catch(error => { initialized = undefined; throw error; });
  await initialized;
  const tree = favicon.match(/<path\b[^>]*\/>/)![0].replace(/fill="[^"]*"/, `fill="${SITE.foreground}"`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
    <rect width="1200" height="630" fill="${SITE.background}"/>
    <svg x="64" y="47" width="38" height="54" viewBox="0 0 184 260.4">${tree}</svg>
    <text x="124" y="87" fill="${SITE.foreground}" font-family="DM Sans" font-size="28">${xmlText(SITE.name)}</text>
    <text x="64" y="157" fill="#526057" font-family="DM Sans" font-size="26">${xmlText(dateLabel(date))}</text>
    ${lines(headline).map((line, index) => `<text x="64" y="${250 + index * 73}" fill="${SITE.foreground}" font-family="Instrument Serif" font-size="64">${xmlText(line)}</text>`).join('')}
    <text x="64" y="579" fill="#526057" font-family="DM Sans" font-size="23">Lake Arrowhead news · lakearrowhead.town</text>
  </svg>`;
  const renderer = new Resvg(svg, { font: { fontBuffers: [new Uint8Array(sans), new Uint8Array(serif)], defaultFontFamily: 'DM Sans' } });
  try {
    const rendered = renderer.render();
    try { return rendered.asPng().slice(); }
    finally { rendered.free(); }
  } finally { renderer.free(); }
}
