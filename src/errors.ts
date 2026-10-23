import type { AppendReply, BatchReply, PublicationStatus, PublishFailure, PublishReply, RetractReply } from './types';
import { isTimestamp } from './validation';
import { publicationOperation, alertMutation } from './operations';

export interface ValidationIssue { path: string; code: string; message: string }
interface ErrorOptions {
  stage?: string;
  retry_at?: string;
  code?: string;
  details?: ValidationIssue[] | Record<string, unknown>;
  details_truncated?: boolean;
  retryable?: boolean;
  publication_status?: PublicationStatus;
}

export class HttpError extends Error {
  readonly stage?: string;
  readonly retry_at?: string;
  readonly code: string;
  readonly details: ValidationIssue[] | Record<string, unknown>;
  readonly details_truncated: boolean;
  readonly retryable: boolean;
  readonly publication_status?: PublicationStatus;
  constructor(public status: number, message: string, public headers: HeadersInit = {}, options: ErrorOptions = {}) {
    super(message);
    this.name = 'HttpError';
    this.stage = options.stage;
    this.retry_at = options.retry_at;
    this.code = options.code ?? ({ 400: 'invalid_request', 401: 'unauthorized', 404: 'not_found', 405: 'method_not_allowed', 409: 'conflict', 413: 'body_too_large', 415: 'unsupported_media_type', 503: 'service_unavailable' } as Record<number, string>)[status] ?? 'internal_error';
    this.details = options.details ?? {};
    this.details_truncated = options.details_truncated ?? false;
    this.retryable = options.retryable ?? false;
    this.publication_status = options.publication_status;
  }
}

export class DamagedSource extends HttpError {
  constructor(readonly source_key: string, readonly post_id: string, readonly reason: 'missing' | 'invalid_json' | 'invalid_digest') {
    super(500, 'Published source is damaged. An operator must restore it before retrying.', {}, { code: 'source_damaged', retryable: false });
  }
}

export class DamagedManifest extends HttpError {
  constructor(readonly manifest_key: string, readonly reason: 'missing' | 'invalid_json' | 'invalid_manifest') {
    super(500, 'Committed publication manifest is damaged. An operator must restore it before retrying.', {}, { code: 'manifest_damaged', retryable: false });
  }
}

const failures = {
  storage: { status: 500, code: 'storage_error', retryable: true, error: 'Storage operation failed. Retry the request.' },
  rendering: { status: 500, code: 'render_failed', retryable: false, error: 'Rendering failed. An operator must repair the cause before retrying.' },
  body: { status: 500, code: 'body_read_failed', retryable: true, error: 'Unable to read the request body. Retry the request.' },
  rpc: { status: 503, code: 'service_unavailable', retryable: true, error: 'Publisher service is unavailable. Retry the request.' },
  internal: { status: 500, code: 'internal_error', retryable: false, error: 'An internal error occurred. An operator must repair the cause before retrying.' },
} as const;
type FailureKind = keyof typeof failures;

export class OperationFailure extends Error {
  constructor(readonly kind: FailureKind, readonly cause: unknown) {
    super(failures[kind].error);
    this.name = 'OperationFailure';
  }
}

// Wrap only the operation that supplies the classification, not surrounding logic.
export async function boundary<T>(kind: FailureKind, action: () => T | Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (error instanceof HttpError || error instanceof OperationFailure) throw error;
    throw new OperationFailure(kind, error);
  }
}

export function asHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const failure = failures[error instanceof OperationFailure ? error.kind : 'internal'];
  return new HttpError(failure.status, failure.error, {}, failure);
}

export function detailsWithStage(details: HttpError['details'] | undefined, stage: string): HttpError['details'] {
  return details && (Array.isArray(details) || Object.keys(details).length) ? details : { stage };
}

export const UNKNOWN_PUBLICATION = 'Unable to confirm publication; it may have completed. Retry the unchanged payload within the original 30 Los Angeles receipt-date deduplication window.';

export function committedFailureAdvice(retryable: boolean, operation?: string): string {
  operation = publicationOperation(operation);
  if (!retryable || !operation) return 'Use the request ID to contact the operator.';
  return operation === 'retract'
    ? 'Reconcile the original batch status. An unchanged retry with the original publishing token can confirm an already-retracted result while its record is retained. Contact the operator if subsequent processing still fails.'
    : 'Reconcile the committed stories. Retry only the unchanged payload within the original 30 Los Angeles receipt-date history window. Contact the operator if subsequent processing still fails.';
}

export function publicationFailure(error: unknown, stage: string, publication_status: PublicationStatus, operation?: string): PublishFailure {
  const failure = asHttpError(error);
  const retryable = publication_status === 'unknown' || failure.retryable;
  if (alertMutation(operation) && retryable && ['unknown', 'not_committed'].includes(publication_status)) {
    const advice = operation === 'alert_confirm' ? 'Look up each confirmation client_ref or retry the unchanged batch within the original 30 Los Angeles receipt-date reference window.' : operation === 'alert_retract'
      ? 'Reconcile the alert history or retry the same retraction with its original publishing token; a first retraction must commit within 24 hours of the entry receipt.'
      : 'Look up GET /api/alerts?client_ref=YOUR_REFERENCE or retry the unchanged submission within its original 30 Los Angeles receipt-date reference window.';
    return { status: failure.status, code: failure.code, error: `${publication_status === 'unknown' ? 'Unable to confirm the alert operation; it may have completed.' : 'The alert operation did not commit.'} ${advice}`, stage, publication_status, retryable };
  }
  if (operation === 'event' && retryable && ['unknown', 'not_committed'].includes(publication_status)) {
    return { status: failure.status, code: failure.code, error: publication_status === 'unknown'
      ? 'Unable to confirm event publication; it may have completed. Retry the unchanged payload; retained occurrences are deduplicated by source URL and start time.'
      : 'Event publication did not commit. Retry the unchanged payload.', stage, publication_status, retryable };
  }
  operation = publicationOperation(operation);
  const message = failure.code === 'publication_conflict' ? failure.message : publication_status === 'unknown' ? operation === 'retract'
    ? 'Unable to confirm retraction; it may have completed. Reconcile the batch status or retry promptly with the original token. A first retraction must commit within 24 hours of the original batch receipt.' : UNKNOWN_PUBLICATION
    : publication_status === 'committed' ? `${operation === 'retract' ? 'Retraction' : 'Publication'} committed, but subsequent processing failed. ${committedFailureAdvice(retryable, operation)}`
    : retryable ? operation === 'retract'
      ? 'Retraction did not commit. Retry promptly with the original token within 24 hours of the original batch receipt; after that deadline contact the operator.'
      : 'Publication did not commit. Retry the unchanged payload within the original 30 Los Angeles receipt-date deduplication window.'
    : failure.message;
  return { status: failure.status, code: failure.code, error: message, stage, publication_status, retryable, ...(failure.retry_at ? { retry_at: failure.retry_at } : {}) };
}

export function declaredBodyBytes(request: Request): number | undefined {
  const value = request.headers.get('content-length');
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const size = Number(value);
  return Number.isSafeInteger(size) ? size : undefined;
}

// RPC types are compile-time only; an older or unexpected server can return anything.
export function isPublishReply(value: unknown): value is PublishReply {
  if (!value || typeof value !== 'object') return false;
  const reply = value as Record<string, any>;
  const integer = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
  if (reply.ok === false) {
    const f = reply.failure;
    return !!f && Number.isInteger(f.status) && f.status >= 400 && f.status <= 599
      && typeof f.code === 'string' && typeof f.error === 'string' && typeof f.stage === 'string'
      && typeof f.retryable === 'boolean' && (f.retry_at === undefined || isTimestamp(f.retry_at)) && ['not_attempted', 'not_committed', 'committed', 'unknown'].includes(f.publication_status);
  }
  const r = reply.result;
  if (reply.ok !== true || !r || !r.counts || !Array.isArray(r.items)) return false;
  const c = r.counts;
  if (![c.submitted, c.published, c.duplicates].every(integer) || c.submitted < 1 || c.submitted !== c.published + c.duplicates
    || r.items.length !== c.submitted || r.duplicate !== (c.published === 0)) return false;
  if (r.duplicate ? r.post !== null : !r.post || !['id', 'date', 'received_at'].every(key => typeof r.post[key] === 'string')) return false;
  return r.items.every((item: any, index: number) => item && item.index === index && ['published', 'duplicate'].includes(item.status)
    && typeof item.post_id === 'string' && integer(item.item_index))
    && r.items.filter((item: any) => item.status === 'published').length === c.published;
}

export function isAppendReply(value: unknown): value is AppendReply {
  if (!value || typeof value !== 'object') return false;
  const reply = value as Record<string, any>;
  if (reply.ok === false) return isPublishReply(value);
  const r = reply.result;
  return reply.ok === true && !!r && ['appended', 'duplicate'].includes(r.status) && typeof r.post_id === 'string'
    && Number.isSafeInteger(r.item_index) && r.item_index >= 0 && typeof r.message === 'string'
    && (r.update_index === undefined ? r.status === 'duplicate' : Number.isSafeInteger(r.update_index) && r.update_index >= 0);
}

export function isRetractReply(value: unknown): value is RetractReply {
  if (!value || typeof value !== 'object') return false;
  const reply = value as Record<string, any>;
  if (reply.ok === false) return isPublishReply(value);
  return reply.ok === true && !!reply.result && typeof reply.result.post_id === 'string'
    && ['retracted', 'already_retracted'].includes(reply.result.status) && isTimestamp(reply.result.retracted_at);
}

export function isBatchReply(value: unknown): value is BatchReply {
  if (!value || typeof value !== 'object') return false;
  const reply = value as Record<string, any>;
  if (reply.ok === false) return isPublishReply(value);
  const r = reply.result;
  return reply.ok === true && !!r && typeof r.client_ref === 'string' && !!r.post && typeof r.post.id === 'string'
    && typeof r.post.date === 'string' && isTimestamp(r.post.received_at) && ['published', 'retracted'].includes(r.status)
    && (r.status !== 'retracted' || isTimestamp(r.retracted_at));
}

export function retryHeaders(retryAt?: string): HeadersInit {
  return retryAt ? { 'Retry-After': String(Math.max(1, Math.ceil((Date.parse(retryAt) - Date.now()) / 1000))) } : {};
}

// Preserve the complete typed RPC failure, including read-only certainty.
export function failureError(f: PublishFailure): HttpError {
  return new HttpError(f.status, f.error, retryHeaders(f.retry_at), { stage: f.stage, code: f.code,
    retryable: f.retryable, retry_at: f.retry_at, publication_status: f.publication_status,
    details: detailsWithStage(f.details, f.stage), details_truncated: f.details_truncated });
}
