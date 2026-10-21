function acceptsGzip(request: Request): boolean {
  // Cloudflare can normalize Accept-Encoding; negotiate using the visitor's original value.
  const original = request.cf?.clientAcceptEncoding;
  const accepted = typeof original === 'string' ? original : request.headers.get('Accept-Encoding') ?? '';
  const qualities = new Map<string, number>();
  for (const part of accepted.split(',')) {
    const match = /^\s*(gzip|\*)\s*(?:;\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?\s*$/i.exec(part);
    if (match) qualities.set(match[1].toLowerCase(), match[2] === undefined ? 1 : Number(match[2]));
  }
  return (qualities.get('gzip') ?? qualities.get('*') ?? 0) > 0;
}

export function htmlResponse(request: Request, response: Response): Response {
  if (![200, 304].includes(response.status) || !response.headers.has('ETag')
    || response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'text/html') return response;
  const headers = new Headers(response.headers);
  // HTML transformations strip ETags at the edge. Keep the representation intact,
  // and explicitly request runtime compression because no-transform disables edge compression.
  if (!/\bno-transform\b/i.test(headers.get('Cache-Control') ?? '')) headers.append('Cache-Control', 'no-transform');
  if (!headers.get('Vary')?.split(',').some(value => /^(accept-encoding|\*)$/i.test(value.trim()))) headers.append('Vary', 'Accept-Encoding');
  if (acceptsGzip(request)) headers.set('Content-Encoding', 'gzip');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers, encodeBody: 'automatic' });
}
