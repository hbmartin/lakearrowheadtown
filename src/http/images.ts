import { Hono } from 'hono';
import { boundary, declaredBodyBytes } from '../errors';
import { metadataKey } from '../image-metadata';
import { IMAGE_CACHE, imageUpload, withImageUploadSlot } from '../images';
import { HttpError } from '../validation';
import type { AppEnv } from './services';

export const images = new Hono<AppEnv>().all('/images', async c => {
  const services = c.var.services;
  const { request, env, state, trace, query, reply } = services;
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed', { Allow: 'POST' });
  await services.authenticate();
  if (query.has('dry_run')) throw new HttpError(400, 'dry_run is not supported for image uploads.', {}, { code: 'invalid_dry_run' });
  state.bytes_received = 0;
  state.body_complete = false;
  state.declared_body_bytes = declaredBodyBytes(request);
  const origin = await services.origin();
  return await withImageUploadSlot(() => trace.run('upload_slot_held', async () => {
    const image = await trace.run('image_validation', () => imageUpload(request, (bytes, complete) => { state.bytes_received = bytes; state.body_complete = complete ?? false; }));
    const key = `images/${image.hash}.${image.extension}`;
    await trace.run('image_write', () => boundary('storage', () => env.SITE_BUCKET.put(key, image.file.stream(), { httpMetadata: { contentType: image.type, cacheControl: IMAGE_CACHE } })));
    await trace.run('image_metadata_write', () => boundary('storage', () => env.SITE_BUCKET.put(metadataKey(image.hash), JSON.stringify(image.metadata), { httpMetadata: { contentType: 'application/json' } })));
    return reply({ ok: true, url: `${origin}/${key}`, width: image.metadata.width, height: image.metadata.height });
  }), trace);
});
