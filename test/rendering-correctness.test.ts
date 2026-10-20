import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/render';
import { dateLabel } from '../src/dates';
import { xmlText } from '../src/xml';
import { validateDigest, validateStoredDigest, validateUpdate } from '../src/validation';
import type { StoredPost } from '../src/types';

const time = '2026-10-20T18:00:00Z';
const item = { group: 'Group', group_url: 'https://example.com/group', headline: 'Story', category: '', body: '', post_url: 'https://example.com/story', posted_at: time };

describe('document boundaries and shared text helpers', () => {
  it('isolates conflicting and missing references across stories and updates while sharing the image counter', () => {
    const post: StoredPost = { id: 'post', date: '2026-10-20', received_at: time, title: 'Batch', source: 'Source', items: [
      { ...item, body: '[ref]: https://example.com/first\n\n[First][ref]\n\n![First](/images/first.png)', updates: [
        { group: 'Update', post_url: 'https://example.com/update', posted_at: time, received_at: time,
          body: '[Update][ref]\n\n[ref]: https://example.com/update-ref\n\n![Update](/images/update.png)' },
        { group: 'Unresolved', post_url: 'https://example.com/unresolved', posted_at: time, received_at: time, body: '[Missing][ref]' },
      ] },
      { ...item, body: '[Second][ref]\n\n[ref]: https://example.com/second\n\n![Second](/images/second.png)' },
      { ...item, body: '[Missing story][ref]' },
    ] };
    const html = renderPage([post], { origin: 'https://lakearrowhead.town', images: {
      'https://lakearrowhead.town/images/first.png': { width: 30, height: 20, type: 'image/png' },
    } });
    expect(html).toContain('href="https://example.com/first">First</a>');
    expect(html).toContain('href="https://example.com/update-ref">Update</a>');
    expect(html).toContain('href="https://example.com/second">Second</a>');
    expect(html).toContain('[Missing][ref]');
    expect(html).toContain('[Missing story][ref]');
    expect(html.match(/loading="eager"/g)).toHaveLength(1);
    expect(html.match(/loading="lazy"/g)).toHaveLength(2);
    expect(html.match(/decoding="async"/g)).toHaveLength(3);
    expect(html).toContain('width="30" height="20"');
  });

  it('normalizes XML text while retaining valid Unicode and existing escaping', () => {
    expect(xmlText('A\r\nB\rC\u0000\u0008\uFFFE\uFFFF\uD800 & <"\' 山 🌲')).toBe('A\nB\nC����� &amp; &lt;&quot;&#39; 山 🌲');
    expect(dateLabel('2026-03-08')).toBe('Sunday, March 8, 2026');
    expect(dateLabel('2026-11-01')).toBe('Sunday, November 1, 2026');
  });
});

describe('update validation', () => {
  it.each([undefined, '', 'not a URL'])('does not invent a group_url error for post_url=%s', post_url => {
    try { validateUpdate({ group: 'Group', posted_at: time, post_url }); throw new Error('Expected validation failure'); }
    catch (error: any) {
      expect(error.code).toBe('validation_failed');
      expect(error.details.map((issue: any) => issue.path)).toEqual(['post_url']);
    }
  });
  it('reports supplied optional fields and preserves defaults and stored updates', () => {
    const update = { group: 'Group', posted_at: time, post_url: 'https://example.com/update' };
    expect(validateUpdate(update)).toEqual({ ...update, body: '' });
    expect(() => validateUpdate({ ...update, group_url: null })).toThrow('Update validation failed');
    try { validateUpdate({ ...update, group_url: 'invalid' }); throw new Error('Expected validation failure'); }
    catch (error: any) { expect(error.details.map((issue: any) => issue.path)).toEqual(['group_url']); }
    const stored = { title: 'Batch', source: 'Source', items: [{ ...item, updates: [{ ...update, received_at: time }] }] };
    expect(validateStoredDigest(stored).items[0].updates).toEqual([{ ...update, body: '', received_at: time }]);
    expect(validateDigest(stored).items[0]).not.toHaveProperty('updates');
    expect(() => validateStoredDigest({ ...stored, items: [{ ...item, updates: [{ ...update, received_at: 'invalid' }] }] })).toThrow('Stored update receipt timestamp is invalid');
  });
});
