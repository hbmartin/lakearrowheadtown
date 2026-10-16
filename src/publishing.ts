import { recentDates, renderPage } from './render';
import type { ContentBucket, Digest } from './types';

export const HTML_CACHE = 'public, max-age=0, must-revalidate, no-transform';
const htmlOptions: R2PutOptions = { httpMetadata: { contentType: 'text/html; charset=utf-8', cacheControl: HTML_CACHE } };

export async function publishDigest(bucket: ContentBucket, digest: Digest, origin: string, now = new Date()): Promise<void> {
  // Persist the source first. Any later failure is repaired by reposting the date.
  await bucket.put(`digests/${digest.date}.json`, JSON.stringify(digest), { httpMetadata: { contentType: 'application/json' } });
  const days = await Promise.all(recentDates(now).map(async date => {
    const source = await bucket.get(`digests/${date}.json`);
    return source ? source.json<Digest>() : null;
  }));
  const homepage = renderPage(days.filter((day): day is Digest => day !== null), { origin });
  const daily = renderPage([digest], { origin, daily: true });
  await bucket.put(`pages/digests/${digest.date}.html`, daily, htmlOptions);
  await bucket.put('pages/index.html', homepage, htmlOptions);
}
