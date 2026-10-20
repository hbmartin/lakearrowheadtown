import type { Suggestion } from './types';

export const reviewStory: Suggestion = { action: 'review_existing_story', message: 'Read the 30-day history and inspect the returned post_id and item_index before choosing another source.', method: 'GET', path: '/api/posts?days=30' };
export const duplicateMessage = 'This exact source URL already belongs to a retained story. No content was changed.';

export function errorSuggestion(code: string, retryable: boolean): Suggestion {
  if (code === 'story_not_found') return { action: 'find_story_or_publish', message: 'Read the 30-day history to select a current story, or publish a new story through POST /api/digests.', method: 'GET', path: '/api/posts?days=30' };
  if (code === 'unauthorized') return { action: 'authenticate', message: 'Supply the publishing credential in Authorization: Bearer <token>.' };
  if (code === 'method_not_allowed') return { action: 'use_allowed_method', message: 'Use the HTTP method listed in the Allow response header.' };
  if (code === 'not_found') return { action: 'check_route', message: 'Use GET /api/posts to read stories or POST /api/posts/{post_id}/items/{item_index}/updates to attach a source.' };
  if (code === 'invalid_cursor' || code === 'invalid_days') return { action: 'restart_read', message: 'Start a fresh read with days between 1 and 30; follow next_cursor without changing days.', method: 'GET', path: '/api/posts?days=7' };
  if (['validation_failed', 'invalid_json', 'invalid_utf8', 'unsupported_media_type', 'body_too_large', 'invalid_request'].includes(code)) return { action: 'correct_request', message: 'Correct the fields described in details, send UTF-8 application/json, and keep the request within 1 MiB.' };
  return retryable ? { action: 'retry_unchanged', message: 'Retry the unchanged request within the original 30-day history window. An uncertain publication may already have committed.' }
    : { action: 'contact_operator', message: 'Use request_id to investigate this response before retrying.' };
}
