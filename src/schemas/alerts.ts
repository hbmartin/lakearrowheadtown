import { NEVER, type ZodType, array, custom, object, unknown } from 'zod';
import { httpUrl, record, text } from '../primitives';
import { isClientRef, isTimestamp } from './primitives';
import { apiIssue } from './shared';
import type { AlertInput, ConfirmationInput } from '../alerts';

export const ALERT_ROUTES = ['SR-18', 'SR-189', 'SR-330', 'SR-138', 'SR-173'] as const;
export const trafficKinds = ['closure', 'chain-control', 'one-way', 'construction', 'storm', 'hazard'] as const;
export const powerKinds = ['outage', 'planned-outage', 'psps'] as const;
export const sources = ['caltrans', 'nws', 'sce'] as const;
export const stages = ['watch', 'warning', 'scheduled', 'in-effect'] as const;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const field = <T>(check: (value: unknown) => boolean, message: string) => custom<T>(check, { error: message, params: { api_code: 'invalid_field' } });
const member = (values: readonly string[]) => field<string>(value => typeof value === 'string' && values.includes(value), `Expected one of: ${values.join(', ')}.`);
const powerSchema = unknown().transform((value, ctx) => {
  if (!record(value)) { ctx.addIssue(apiIssue([], 'invalid_field', 'Expected a power object or null.')); return NEVER; }
  const result = object({
    stage: member(stages).optional(),
    customer_count: field<number | null>(v => v === null || Number.isSafeInteger(v) && Number(v) >= 0, 'Expected a nonnegative safe integer or null.').optional(),
  }).safeParse(value);
  if (!result.success) { for (const issue of result.error.issues) ctx.addIssue({ ...issue }); return NEVER; }
  return { ...(result.data.stage === undefined ? {} : { stage: result.data.stage }),
    ...(result.data.customer_count === undefined ? {} : { customer_count: result.data.customer_count }) };
}).nullable();

// Conditional presence is intentional: updates inherit omitted fields, while null clears them.
// Shape insertion order also preserves API v3's field-level diagnostic order.
export const alertSchema = unknown().transform((value, ctx): AlertInput => {
  if (!record(value)) { ctx.addIssue(apiIssue([], 'invalid_type', 'Expected an object.')); return NEVER; }
  const opening = value.phase === 'open';
  const shape: Record<string, ZodType> = {
    client_ref: field<string>(isClientRef, 'Expected a nonblank reference of at most 128 characters without control characters.'),
    phase: field<string>(v => ['open', 'update', 'resolved'].includes(v as string), 'Expected open, update, or resolved.'),
    ...(!opening || value.alert_id !== undefined ? { alert_id: field<string>(v => typeof v === 'string' && uuid.test(v) && !opening, 'Updates and resolutions require an alert UUID; openings must omit it.') } : {}),
    source: member(sources),
    ...(opening || value.category !== undefined ? { category: member(['traffic', 'power']) } : {}),
    ...(opening || value.kind !== undefined ? { kind: member([...trafficKinds, ...powerKinds]) } : {}),
    source_url: field<string>(httpUrl, 'Expected an absolute HTTP(S) URL without credentials.'),
    observed_at: field<string>(isTimestamp, 'Expected an ISO timestamp with an explicit timezone.'),
    ...(opening || value.headline !== undefined ? { headline: field<string>(text, 'Expected a nonempty headline.') } : {}),
  };
  for (const key of ['detail', 'area', 'source_event_id', 'starts_at', 'expected_end'] as const) {
    if (value[key] === undefined) continue;
    const time = key === 'starts_at' || key === 'expected_end';
    shape[key] = field<string | null>(v => v === null || (time ? isTimestamp(v) : typeof v === 'string' && (key === 'detail' || !!v.trim())),
      time ? 'Expected a timezone-qualified ISO timestamp or null.' : 'Expected a string or null.');
  }
  if (value.routes !== undefined) shape.routes = field(v => v === null || Array.isArray(v) && v.length > 0 && v.every(route => ALERT_ROUTES.includes(route)) && new Set(v).size === v.length, 'Expected unique supported state routes, or null.');
  if (value.chain_level !== undefined) shape.chain_level = field(v => v === null || ['R1', 'R2', 'R3'].includes(v as string), 'Expected R1, R2, R3, or null.');
  if (value.power !== undefined) shape.power = powerSchema;
  const result = object(shape).safeParse(value);
  if (!result.success) { for (const issue of result.error.issues) ctx.addIssue({ ...issue }); return NEVER; }
  return result.data as unknown as AlertInput;
});

export const confirmationEnvelopeSchema = object({ confirmations: array(unknown()).min(1).max(100) });
export const confirmationSchema = unknown().transform((value, ctx): ConfirmationInput => {
  if (!record(value)) { ctx.addIssue(apiIssue(['confirmation'], 'invalid_type', 'Expected a confirmation object.')); return NEVER; }
  const allowed = ['client_ref', 'alert_id', 'source', 'source_url', 'observed_at'];
  const extras = Object.keys(value).filter(key => !allowed.includes(key));
  if (extras.length) { for (const key of extras) ctx.addIssue(apiIssue([key], 'unsupported_field', 'Confirmations cannot change alert content or lifecycle.')); return NEVER; }
  const result = alertSchema.safeParse({ ...value, phase: 'update' });
  if (!result.success) { for (const issue of result.error.issues) ctx.addIssue({ ...issue }); return NEVER; }
  const { client_ref, alert_id, source, source_url, observed_at } = result.data;
  return { client_ref, alert_id: alert_id!, source, source_url, observed_at };
});
