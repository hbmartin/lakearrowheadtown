import { array, custom, object } from 'zod';
import { httpUrl } from '../primitives';
import { isClientRef, isTimestamp } from './primitives';
import { textSchema } from './shared';

export const clientRefSchema = custom<string>(isClientRef, {
  error: 'Expected a nonblank string of at most 128 characters without control characters.', params: { api_code: 'invalid_client_ref' },
});
export const urlSchema = textSchema().refine(value => !value.trim() || httpUrl(value), {
  error: 'Expected an absolute HTTP(S) URL without credentials.', params: { api_code: 'invalid_url' },
});
export const timestampSchema = textSchema().refine(value => !value.trim() || isTimestamp(value), {
  error: 'Expected an ISO timestamp with a real calendar date and explicit timezone.', params: { api_code: 'invalid_timestamp' },
});
export const digestItemSchema = object({
  group: textSchema(), group_url: urlSchema, headline: textSchema(), body: textSchema(true),
  post_url: urlSchema, category: textSchema(true), posted_at: timestampSchema,
}, { error: 'Expected an object.' });

const items = array(digestItemSchema, { error: 'Expected an array.' });
const shape = { title: textSchema(), source: textSchema(), client_ref: clientRefSchema.optional(), items };
export const digestSchema = object(shape, { error: 'Expected an object.' }).transform(({ title, source, items, client_ref }) => ({
  title, source, items, ...(client_ref === undefined ? {} : { client_ref }),
}));
export const digestSubmissionSchema = object({ ...shape, items: items.refine(value => value.length > 0, {
  error: 'At least one story is required.', params: { api_code: 'empty_items' },
}) }, { error: 'Expected an object.' }).transform(({ title, source, items, client_ref }) => ({
  title, source, items, ...(client_ref === undefined ? {} : { client_ref }),
}));
export const updateSchema = object({
  group: textSchema(), group_url: urlSchema.optional(), body: textSchema(true).default(''), post_url: urlSchema, posted_at: timestampSchema,
}, { error: 'Expected an object.' }).transform(({ group, group_url, body, post_url, posted_at }) => ({
  group, ...(group_url === undefined ? {} : { group_url }), body, post_url, posted_at,
}));
