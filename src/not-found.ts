import template from './not-found.html';
import { escapeHtml } from './html';
import { SITE } from './site';
import { withThemeHead } from './theme';

// No origin, storage, or publication rendering is needed on the error path.
export default withThemeHead(template)
  .replaceAll('{{site.name}}', () => escapeHtml(SITE.name))
  .replaceAll('{{site.background}}', () => escapeHtml(SITE.background));
