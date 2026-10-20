// HeadersInit also accepts Headers and pair lists; object spread cannot merge them.
export function noStoreHeaders(type: string, additional: HeadersInit = {}): Headers {
  const headers = new Headers(additional);
  headers.set('Content-Type', type);
  headers.set('Cache-Control', 'no-store');
  headers.set('Cloudflare-CDN-Cache-Control', 'no-store');
  headers.set('CDN-Cache-Control', 'no-store');
  headers.set('Surrogate-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  return headers;
}
