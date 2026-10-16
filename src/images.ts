import { createHash } from 'node:crypto';
import { HttpError } from './validation';

export const IMAGE_LIMIT = 10 * 1024 * 1024;
export const IMAGE_CACHE = 'public, max-age=31536000, immutable';
let activeUploads = 0;

export async function withImageUploadSlot<T>(action: () => Promise<T>): Promise<T> {
  if (activeUploads >= 2) throw new HttpError(503, 'Image uploads are busy', { 'Retry-After': '1' });
  activeUploads++;
  try { return await action(); }
  finally { activeUploads--; }
}

export async function imageUpload(request: Request): Promise<{ file: File; hash: string; type: string; extension: string }> {
  const contentType = request.headers.get('content-type');
  if (!contentType?.toLowerCase().startsWith('multipart/form-data;')) throw new HttpError(415, 'Expected multipart/form-data');
  const limit = IMAGE_LIMIT + 64 * 1024;
  if (Number(request.headers.get('content-length')) > limit) throw new HttpError(413, 'Request is too large');
  let size = 0;
  let overflow: HttpError | undefined;
  const bounded = request.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > limit) {
        overflow = new HttpError(413, 'Request is too large');
        throw overflow;
      }
      controller.enqueue(chunk);
    },
  }));
  let form: FormData;
  try { form = await new Response(bounded, { headers: { 'content-type': contentType } }).formData(); }
  catch { throw overflow ?? new HttpError(400, 'Invalid multipart form'); }
  const entries = [...form.entries()];
  const file = form.get('file');
  if (entries.length !== 1 || !(file instanceof File)) throw new HttpError(400, 'Expected one file field named file');
  if (file.size > IMAGE_LIMIT) throw new HttpError(413, 'Image exceeds 10 MiB');
  const header = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const starts = (...values: number[]) => values.every((value, i) => header[i] === value);
  const ascii = (start: number, length: number) => new TextDecoder().decode(header.subarray(start, start + length));
  let type: string;
  let extension: string;
  if (header.length >= 3 && starts(0xff, 0xd8, 0xff)) { type = 'image/jpeg'; extension = 'jpg'; }
  else if (header.length >= 24 && starts(137, 80, 78, 71, 13, 10, 26, 10) && ascii(12, 4) === 'IHDR') { type = 'image/png'; extension = 'png'; }
  else if (header.length >= 13 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6))) { type = 'image/gif'; extension = 'gif'; }
  else if (header.length >= 16 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(ascii(12, 4))) { type = 'image/webp'; extension = 'webp'; }
  else throw new HttpError(415, 'Expected JPEG, PNG, WebP, or GIF image data');
  if (file.type.toLowerCase() !== type) throw new HttpError(415, 'Image media type does not match its contents');
  const hash = createHash('sha256');
  for await (const chunk of file.stream()) hash.update(chunk);
  return { file, hash: hash.digest('hex'), type, extension };
}

export async function hashBytes(bytes: ArrayBuffer | ArrayBufferView): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
