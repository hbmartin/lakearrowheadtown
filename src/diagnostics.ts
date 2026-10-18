import { createHash } from 'node:crypto';
import type { OperationContext, PublicationStatus } from './types';

export function fingerprint(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

// Never log an exception message: parsers and upstream services can echo inputs.
export function safeError(error: unknown): Record<string, unknown> {
  const known = ['Error', 'TypeError', 'SyntaxError', 'RangeError', 'HttpError', 'PublicationError'];
  if (!(error instanceof Error)) return { error_type: 'UnknownError' };
  const frames = (error.stack ?? '').split('\n').filter(line => /^\s+at /.test(line))
    .map(line => /(?:\(|at )([\w./@:-]+):(\d+):(\d+)\)?$/.exec(line))
    .filter(match => match !== null).slice(0, 12)
    .map(match => `${match[1]}:${match[2]}:${match[3]}`);
  return { error_type: known.includes(error.name) ? error.name : 'Error', stack_frames: frames };
}

export function emit(event: string, context: OperationContext | undefined, fields: Record<string, unknown> = {}, level: 'info' | 'warn' | 'error' = 'info'): void {
  if (!context) return;
  try { console[level]({ message: event, event, ...context, ...fields }); } catch { /* Best effort telemetry must not fail publication. */ }
}

export class OperationTrace {
  stage = 'initialization';
  publication_status: PublicationStatus = 'not_committed';
  constructor(public context?: OperationContext) {}

  async run<T>(stage: string, action: () => T | Promise<T>): Promise<T> {
    this.stage = stage;
    const started = performance.now();
    let outcome = 'ok';
    try { return await action(); }
    catch (error) { outcome = 'error'; throw error; }
    finally { emit('operation_stage', this.context, { stage, outcome, duration_ms: performance.now() - started }); }
  }
}
