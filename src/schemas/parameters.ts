import { array, enum as enumSchema, string } from 'zod';
import { HttpError } from '../errors';

const dryRun = array(enumSchema(['true', 'false'])).max(1);
const history = array(enumSchema(['full', 'coalesced'])).max(1);
const clientRefCount = array(string()).length(1);
const itemIndex = string().regex(/^(?:0|[1-9][0-9]*)$/).refine(value => Number.isSafeInteger(Number(value)));

export function validateDryRun(query: URLSearchParams): boolean {
  if (!dryRun.safeParse(query.getAll('dry_run')).success) throw new HttpError(400, 'dry_run must be true or false.', {}, { code: 'invalid_dry_run' });
  return query.get('dry_run') === 'true';
}
export function validateHistory(query: URLSearchParams): 'full' | 'coalesced' {
  const result = history.safeParse(query.getAll('history'));
  if (!result.success) throw new HttpError(400, 'history must be full or coalesced.', {}, { code: 'invalid_history' });
  return result.data[0] ?? 'full';
}
export function requireClientRef(query: URLSearchParams): void {
  if (!clientRefCount.safeParse(query.getAll('client_ref')).success) throw new HttpError(400, 'Supply exactly one client_ref.');
}
export function validateItemIndex(value: string): number {
  const result = itemIndex.safeParse(value);
  if (!result.success) throw new HttpError(400, 'item_index must be a nonnegative safe integer.');
  return Number(result.data);
}
