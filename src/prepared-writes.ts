import { boundary } from './errors';
import { indexCondition, PublicationConflict } from './publication-conflict';
import { OperationTrace } from './diagnostics';
import type { ContentBucket } from './types';

// All source, renderer-cache, archive, and snapshot writes first land here.
// Reads see staged objects so archive seeding can feed the next preparation.
// Only commit() reaches durable storage; the homepage remains the last write.
export function prepareWrites(bucket: ContentBucket, trace: OperationTrace) {
  const previousPhase = trace.phase;
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
    close() { trace.phase = previousPhase; },
    async commit(index: R2Object | null = null) {
      let committedIndex: R2Object | undefined;
      // A child trace per write avoids concurrent stage-stack mutation.
      const persist = async (write: typeof writes[number]) => {
        const child = new OperationTrace(trace.context);
        child.phase = 'commit';
        try {
          return await child.run(write.stage, () => boundary('storage', async () => {
            const result = await bucket.put(write.key, write.bytes, write.key === 'pages/index.html'
              ? { ...write.options, onlyIf: indexCondition(index) } : write.options);
            if (write.key === 'pages/index.html' && result === null) throw new PublicationConflict();
            return result;
          }));
        }
        catch (error) { trace.failed_stage ??= child.failed_stage; throw error; }
      };
      try {
        const groups = new Map<string, typeof writes>();
        for (const write of writes) {
          if (write.key === 'pages/index.html') continue;
          if (!groups.has(write.key)) groups.set(write.key, []);
          groups.get(write.key)!.push(write);
        }
        const pending = [...groups.values()];
        let next = 0;
        let failed = false;
        let failure: unknown;
        await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
          while (!failed && next < pending.length) {
            const group = pending[next++];
            try {
              for (const write of group) {
                if (failed) break;
                await persist(write);
              }
            } catch (error) { if (!failed) failure = error; failed = true; }
          }
        }));
        if (failed) throw failure;
        for (const write of writes.filter(write => write.key === 'pages/index.html')) {
          trace.publication_status = 'unknown';
          try { committedIndex = (await persist(write))!; }
          catch (error) { if (error instanceof PublicationConflict) trace.publication_status = 'not_committed'; throw error; }
          trace.publication_status = 'committed';
        }
        return committedIndex;
      } finally {
        trace.phase = previousPhase;
        writes.length = 0;
        staged.clear();
      }
    },
  };
}
