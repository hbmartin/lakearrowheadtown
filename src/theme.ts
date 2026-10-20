import fragment from './theme-head.html';
import decorations from './theme-decorations.html';
import { escapeHtml } from './html';
import { SITE } from './site';

const marker = '<!-- theme-head -->';
const siteValues = { name: SITE.name, background: SITE.background, foreground: SITE.foreground };

function substituteSite(template: string, css = false): string {
  const rendered = template.replace(/\{\{site\.([^{}]+)\}\}/g, (_match, key: string) => {
    if (!Object.hasOwn(siteValues, key) || (css && key === 'name')) throw new Error(`Unsupported site placeholder: ${key}`);
    const value = siteValues[key as keyof typeof siteValues];
    if (css && !/^#[\da-f]{6}$/i.test(value)) throw new Error(`Invalid site CSS color: ${key}`);
    return css ? value : escapeHtml(value);
  });
  if (rendered.includes('{{site.')) throw new Error('Unresolved site placeholder');
  return rendered;
}

// CSS accepts only the trusted hex colors; outer HTML values are escaped separately.
const themeHead = `<meta name="theme-color" content="${escapeHtml(SITE.background)}">\n${substituteSite(fragment, true)}`;
const themeDecorations = substituteSite(decorations, true);

// Inline the same palette and font setup without another blocking request.
export function withThemeHead(template: string, options: { decorations?: boolean } = {}): string {
  const position = template.indexOf(marker);
  const head = /<head\b[^>]*>/i.exec(template);
  const end = template.indexOf('</head>');
  if (position < 0 || position !== template.lastIndexOf(marker) || !head
    || position < head.index + head[0].length || end < position) {
    throw new Error('Expected exactly one theme-head marker inside <head>');
  }
  // Resolve outer placeholders before inserting CSS, whose values have their own validation.
  return substituteSite(template).replace(marker, () => themeHead + (options.decorations === false ? '' : themeDecorations));
}
