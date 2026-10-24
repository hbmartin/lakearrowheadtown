import { type ZodType, string } from 'zod';
import { HttpError, type ValidationIssue } from '../errors';

export function apiIssue(path: PropertyKey[], code: string, message: string) {
  return { code: 'custom' as const, path, message, params: { api_code: code } };
}

export function fieldPath(path: PropertyKey[]): string {
  return path.map((part, i) => typeof part === 'number' ? `[${part}]` : `${i ? '.' : ''}${String(part)}`).join('');
}

// API v3 owns its error vocabulary. Never expose Zod's input or default messages.
export function parseSchema<T>(schema: ZodType<T>, input: unknown, message: string, root: string): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const details: ValidationIssue[] = result.error.issues.slice(0, 50).map(issue => ({
    path: fieldPath(issue.path) || root,
    code: issue.code === 'custom' ? issue.params!.api_code : 'invalid_type',
    message: issue.message,
  }));
  throw new HttpError(400, message, {}, { code: 'validation_failed', details, details_truncated: result.error.issues.length > 50 });
}

export const textSchema = (empty = false) => string({ error: 'Expected a string.' }).refine(
  value => empty || !!value.trim(), { error: 'Expected a nonempty string.', params: { api_code: 'empty_string' } },
);
