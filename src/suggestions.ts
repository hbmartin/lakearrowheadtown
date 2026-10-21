import type { Suggestion } from './types';

export const reviewStory: Suggestion = { action: 'review_existing_story', message: 'Read the 30-day history and inspect the returned post_id and item_index before choosing another source.', method: 'GET', path: '/api/posts?days=30' };
export const duplicateMessage = 'This exact source URL already belongs to a retained story. No content was changed.';

export function errorSuggestion(code: string, retryable: boolean, dryRun = false, operation?: string): Suggestion {
  if (dryRun && retryable) return { action: 'retry_preview', message: 'Retry the unchanged preview. No publication was attempted.' };
  if (code === 'invalid_dry_run' && ['image', 'retract', 'rebuild'].includes(operation ?? '')) return { action: 'remove_dry_run', message: 'Remove the dry_run parameter; this endpoint does not support previews.' };
  if (operation === 'retract' && retryable) return { action: 'reconcile_or_retry_retraction', message: 'Reconcile the original batch status or retry promptly with its publishing token. A first retraction must commit within 24 hours of the original receipt; otherwise contact the operator.' };
  if (code === 'client_ref_conflict') return { action: 'look_up_batch', message: 'Look up the committed batch with GET /api/digests?client_ref=YOUR_REFERENCE, or choose a new client_ref for a new batch.', method: 'GET', path: '/api/digests' };
  if (code === 'batch_not_found') return { action: 'check_batch_reference', message: 'Check the exact client_ref and original 30 Los Angeles receipt-date window. Duplicate-only submissions do not create batch records.' };
  if (code === 'retract_window_expired' || code === 'retract_forbidden') return { action: 'contact_operator', message: 'Self-retraction requires the original publishing token and a batch received less than 24 hours ago. Contact the operator for other corrections.' };
  if (code === 'post_not_found') return { action: 'find_post', message: 'Read the recent posts or look up the original client_ref to find a committed post_id.', method: 'GET', path: '/api/posts?days=30&fields=index' };
  if (code === 'story_not_found') return { action: 'find_story_or_publish', message: 'Read the 30-day history to select a current story, or publish a new story through POST /api/digests.', method: 'GET', path: '/api/posts?days=30' };
  if (code === 'unauthorized') return { action: 'authenticate', message: 'Supply the publishing credential in Authorization: Bearer <token>.' };
  if (code === 'method_not_allowed') return { action: 'use_allowed_method', message: 'Use the HTTP method listed in the Allow response header.' };
  if (code === 'not_found') return { action: 'check_route', message: 'Use GET /api/posts to read stories or POST /api/posts/{post_id}/items/{item_index}/updates to attach a source.' };
  if (code === 'invalid_cursor' || code === 'invalid_days' || code === 'invalid_fields') return { action: 'restart_read', message: 'Start a fresh read with days between 1 and 30 and fields=full or index; follow next_cursor without changing days or fields.', method: 'GET', path: '/api/posts?days=7' };
  if (['validation_failed', 'invalid_json', 'invalid_utf8', 'unsupported_media_type', 'body_too_large', 'invalid_request', 'invalid_dry_run'].includes(code)) return { action: 'correct_request', message: 'Correct the fields described in details, use dry_run=true or false, send UTF-8 application/json, and keep the request within 1 MiB.' };
  return retryable ? { action: 'retry_unchanged', message: 'Retry the unchanged request within the original 30-day history window. An uncertain publication may already have committed.' }
    : { action: 'contact_operator', message: 'Use request_id to investigate this response before retrying.' };
}
