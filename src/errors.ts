import type { AppendReply, PublicationStatus, PublishFailure, PublishReply } from './types';

export interface ValidationIssue { path: string; code: string; message: string }
interface ErrorOptions {
  code?: string;
  details?: ValidationIssue[] | Record<string, unknown>;
  details_truncated?: boolean;
  retryable?: boolean;
  publication_status?: PublicationStatus;
}

export class HttpError extends Error {
  readonly code: string;
  readonly details: ValidationIssue[] | Record<string, unknown>;
  readonly details_truncated: boolean;
  readonly retryable: boolean;
  readonly publication_status?: PublicationStatus;
  constructor(public status: number, message: string, public headers: HeadersInit = {}, options: ErrorOptions = {}) {
    super(message);
    this.name = 'HttpError';
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

export const UNKNOWN_PUBLICATION = 'Unable to confirm publication; it may have completed. Retry the unchanged payload within the original 30 Los Angeles receipt-date deduplication window.';

export function publicationFailure(error: unknown, stage: string, publication_status: PublicationStatus): PublishFailure {
  const failure = asHttpError(error);
  const retryable = publication_status === 'unknown' || failure.retryable;
  const message = publication_status === 'unknown' ? UNKNOWN_PUBLICATION
    : publication_status === 'committed' ? 'Publication committed, but subsequent processing failed. Use the request ID to contact the operator.'
    : retryable ? 'Publication did not commit. Retry the unchanged payload within the original 30 Los Angeles receipt-date deduplication window.'
    : failure.message;
  return { status: failure.status, code: failure.code, error: message, stage, publication_status, retryable };
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
      && typeof f.retryable === 'boolean' && ['not_attempted', 'not_committed', 'committed', 'unknown'].includes(f.publication_status);
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
