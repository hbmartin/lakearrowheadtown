export interface IfNoneMatch {
  header: string;
  tags: string[] | '*';
}

// Parse before handing a client header to R2: malformed conditions can throw there.
export function parseIfNoneMatch(value: string | null): IfNoneMatch | undefined {
  if (!value) return;
  const text = value.replace(/^[ \t]+|[ \t]+$/g, '');
  if (text === '*') return { header: '*', tags: '*' };
  const tags: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    // HTTP list syntax permits empty members; omit them from the normalized header.
    if (text[offset] === ',' || text[offset] === ' ' || text[offset] === '\t') { offset++; continue; }
    const tag = /^(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"/.exec(text.slice(offset))?.[0];
    if (!tag) return;
    tags.push(tag);
    offset += tag.length;
    while (text[offset] === ' ' || text[offset] === '\t') offset++;
    if (offset < text.length && text[offset++] !== ',') return;
  }
  return tags.length ? { header: tags.join(', '), tags } : undefined;
}

export function matchesEtag(condition: IfNoneMatch | undefined, etag: string): boolean {
  return condition?.tags === '*' || !!condition?.tags.some(tag => tag.replace(/^W\//, '') === etag.replace(/^W\//, ''));
}
