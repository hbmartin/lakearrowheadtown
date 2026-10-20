import fragment from './theme-head.html';
import { SITE } from './site';

const themeHead = fragment
  .replaceAll('{{site.background}}', () => SITE.background)
  .replaceAll('{{site.foreground}}', () => SITE.foreground);

// Inline the same palette and font setup without another blocking request.
export function withThemeHead(template: string): string {
  return template.replace('<!-- theme-head -->', () => themeHead);
}
