import template from './not-found.html';
import { withThemeHead } from './theme';

// No origin, storage, or publication rendering is needed on the error path.
export default withThemeHead(template, { decorations: false });
