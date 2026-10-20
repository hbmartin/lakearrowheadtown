import { boundary } from './errors';
import type { OperationTrace } from './diagnostics';
import type { ContentBucket } from './types';

// All source, renderer-cache, archive, and snapshot writes first land here.
// Reads see staged objects so archive seeding can feed the next preparation.
// Only commit() reaches durable storage; the homepage remains the last write.
export function prepareWrites(bucket: ContentBucket, trace: OperationTrace) {
  trace.phase = 'preparation';
  const writes: { key: string; bytes: Uint8Array; options?: R2PutOptions; stage: string }[] = [];
  const staged = new Map<string, R2ObjectBody>();
  const view: ContentBucket = {
    get: async key => staged.get(key) ?? bucket.get(key),
    head: async key => staged.get(key) ?? bucket.head(key),
    list: options => bucket.list(options),
    async put(key, value, options) {
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value)
        : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice() : new Uint8Array(value).slice();
      const object = {
        key, size: bytes.byteLength, uploaded: new Date(), customMetadata: options?.customMetadata,
        text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.slice().buffer,
      } as R2ObjectBody;
      staged.set(key, object);
      writes.push({ key, bytes, options, stage: trace.stage ?? 'artifact_write' });
      return object;
    },
  };
  return {
    bucket: view,
    async commit() {
      trace.phase = 'commit';
      for (const write of writes) {
        if (write.key === 'pages/index.html') trace.publication_status = 'unknown';
        await trace.run(write.stage, () => boundary('storage', () => bucket.put(write.key, write.bytes, write.options)));
        if (write.key === 'pages/index.html') trace.publication_status = 'committed';
      }
    },
  };
}
