// Changing metadata alone leaves the R2 ETag unchanged. Every supported index
// replacement receives unique bytes so an older conditional PUT cannot become
// eligible again, even when the visible page returns to identical content.
const marker = /\n?<!-- publication-fence:[a-f0-9-]{36} -->/g;
export const withoutIndexFence = (html: string): string => html.replace(marker, '');
export const fenceIndex = (html: string, token = crypto.randomUUID()): string => `${withoutIndexFence(html)}\n<!-- publication-fence:${token} -->`;
