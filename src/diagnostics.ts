export { fingerprint } from './primitives';
import type { OperationContext, PublicationStatus } from './types';
import { DamagedManifest, DamagedSource, OperationFailure } from './errors';

// Never log an exception message: parsers and upstream services can echo inputs.
export function safeError(error: unknown): Record<string, unknown> {
  if (error instanceof OperationFailure) return { failure_kind: error.kind, ...safeError(error.cause) };
  const known = ['Error', 'TypeError', 'SyntaxError', 'RangeError', 'HttpError', 'PublicationError'];
  if (!(error instanceof Error)) return { error_type: 'UnknownError' };
  const frames = (error.stack ?? '').split('\n').filter(line => /^\s+at /.test(line))
    .map(line => /(?:\(|at )([\w./@:-]+):(\d+):(\d+)\)?$/.exec(line))
    .filter(match => match !== null).slice(0, 12)
    .map(match => `${match[1]}:${match[2]}:${match[3]}`);
  return { error_type: known.includes(error.name) ? error.name : 'Error', stack_frames: frames,
    ...(error instanceof DamagedSource ? { source_key: error.source_key, post_id: error.post_id, reason: error.reason } : {}),
    ...(error instanceof DamagedManifest ? { manifest_key: error.manifest_key, reason: error.reason } : {}) };
}

export function emit(event: string, context: OperationContext | undefined, fields: Record<string, unknown> = {}, level: 'info' | 'warn' | 'error' = 'info'): void {
  if (!context) return;
  try { console[level]({ message: event, event, ...context, ...fields }); } catch { /* Best effort telemetry must not fail publication. */ }
}

export class OperationTrace {
  stage: string | undefined;
  failed_stage: string | undefined;
  phase?: 'preparation' | 'commit';
  publication_status: PublicationStatus = 'not_committed';
  constructor(public context?: OperationContext) {}

  async run<T>(stage: string, action: () => T | Promise<T>, fields: Record<string, unknown> = {}): Promise<T> {
    const previous = this.stage;
    this.stage = stage;
    const started = performance.now();
    let outcome = 'ok';
    try { return await action(); }
    catch (error) { outcome = 'error'; this.failed_stage ??= stage; throw error; }
    finally {
      this.stage = previous;
      emit('operation_stage', this.context, { stage, ...(this.phase ? { phase: this.phase } : {}), ...fields, outcome, duration_ms: performance.now() - started });
    }
  }
}
