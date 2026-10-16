import { HttpError, readLimited } from './validation';

export const IMAGE_LIMIT = 10 * 1024 * 1024;
export const IMAGE_CACHE = 'public, max-age=31536000, immutable';

export async function imageUpload(request: Request): Promise<{ bytes: ArrayBuffer; type: string; extension: string }> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data;')) throw new HttpError(415, 'Expected multipart/form-data');
  // Bound the full multipart envelope before the form parser allocates it.
  const bytes = await readLimited(request, IMAGE_LIMIT + 64 * 1024);
  let form: FormData;
  try { form = await new Response(bytes, { headers: { 'content-type': request.headers.get('content-type')! } }).formData(); }
  catch { throw new HttpError(400, 'Invalid multipart form'); }
  const entries = [...form.entries()];
  const file = form.get('file');
  if (entries.length !== 1 || !(file instanceof File)) throw new HttpError(400, 'Expected one file field named file');
  if (file.size > IMAGE_LIMIT) throw new HttpError(413, 'Image exceeds 10 MiB');
  const data = await file.arrayBuffer();
  const header = new Uint8Array(data);
  const starts = (...values: number[]) => values.every((value, i) => header[i] === value);
  const ascii = (start: number, length: number) => new TextDecoder().decode(header.slice(start, start + length));
  let type: string;
  let extension: string;
  if (header.length >= 3 && starts(0xff, 0xd8, 0xff)) { type = 'image/jpeg'; extension = 'jpg'; }
  else if (header.length >= 24 && starts(137, 80, 78, 71, 13, 10, 26, 10) && ascii(12, 4) === 'IHDR') { type = 'image/png'; extension = 'png'; }
  else if (header.length >= 13 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6))) { type = 'image/gif'; extension = 'gif'; }
  else if (header.length >= 16 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(ascii(12, 4))) { type = 'image/webp'; extension = 'webp'; }
  else throw new HttpError(415, 'Expected JPEG, PNG, WebP, or GIF image data');
  if (file.type.toLowerCase() !== type) throw new HttpError(415, 'Image media type does not match its contents');
  return { bytes: data, type, extension };
}

export async function hashBytes(bytes: ArrayBuffer): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
