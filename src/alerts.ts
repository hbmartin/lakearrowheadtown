import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { asHttpError, boundary, DamagedManifest, DamagedSource, HttpError, isPublishReply, type ValidationIssue } from './errors';
import { emit, OperationTrace, safeError } from './diagnostics';
import { localDate, recentDates } from './feed';
import { canonicalJson as canonical, fingerprint, httpUrl, record, text } from './primitives';
import { confirmationEntry, expandHistory, isHistoryRoot, confirmationKey, isConfirmationNode, type ConfirmationNode, type ConfirmationRun, type HistoryRoot } from './alert-history';
import { isClientRef, isTimestamp, validateClientRef } from './validation';
import { instant, timestampPayload } from './instants';
import type { ContentBucket, OperationContext, PublicationWarning, PublishFailure } from './types';

export const ALERTS_KEY = 'alerts/current.json';
export const ALERT_DAY = 24 * 60 * 60 * 1000;
export const ALERT_ROUTES = ['SR-18', 'SR-189', 'SR-330', 'SR-138', 'SR-173'] as const;
const trafficKinds = ['closure', 'chain-control', 'one-way', 'construction', 'storm', 'hazard'] as const;
const powerKinds = ['outage', 'planned-outage', 'psps'] as const;
const sources = ['caltrans', 'nws', 'sce'] as const;
const stages = ['watch', 'warning', 'scheduled', 'in-effect'] as const;
const states = ['open', 'resolved', 'expired-unconfirmed', 'retracted'] as const;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const revisionKey = /^alerts\/revisions\/[a-f0-9]{64}\.json$/;
const snapshotKey = /^alerts\/snapshots\/[a-f0-9]{64}\.json$/;
type Route = typeof ALERT_ROUTES[number];
type Kind = typeof trafficKinds[number] | typeof powerKinds[number];
type Power = { stage: typeof stages[number]; customer_count?: number };
export interface AlertFields {
  category: 'traffic' | 'power'; kind: Kind; headline: string;
  source: typeof sources[number]; source_url: string; observed_at: string;
  detail?: string; starts_at?: string; expected_end?: string; source_event_id?: string;
  routes?: Route[]; area?: string; chain_level?: 'R1' | 'R2' | 'R3'; power?: Power;
}
type NullablePatch<T> = { [P in keyof T]?: T[P] | null };
export interface AlertInput extends Omit<NullablePatch<AlertFields>, 'category' | 'kind' | 'headline' | 'source' | 'source_url' | 'observed_at' | 'power'> {
  client_ref: string; phase: 'open' | 'update' | 'resolved'; alert_id?: string;
  category?: AlertFields['category']; kind?: Kind; headline?: string;
  source: AlertFields['source']; source_url: string; observed_at: string;
  power?: (Omit<Partial<Power>, 'customer_count'> & { customer_count?: number | null }) | null;
}
export interface StoredEntry { entry_id: string; received_at: string; input: AlertInput; publisher_fingerprint: string;
  entry_type?: 'confirmation'; retractable?: false; confirmation_run?: PublicConfirmationRun }
export interface Retraction { entry_id: string; retracted_at: string }
export interface AlertRecord { version: 1; alert_id: string; entries: StoredEntry[]; retractions: Retraction[]; storage?: HistoryRoot; pending_entries?: StoredEntry[] }
export type HistoryMode = 'full' | 'coalesced';
export interface PublicConfirmationRun { run_id: string; count: number; first_observed_at: string; last_observed_at: string; first_received_at: string; last_received_at: string }
export interface AlertView extends AlertFields {
  alert_id: string; state: typeof states[number]; expires_at: string | null; upcoming: boolean;
}
export interface AlertReference { alert_id: string; key: string; last_received_at: string; alert: AlertView; revision?: string; confirmation_count?: number; last_confirmed_at?: string }
interface Receipt { client_ref: string; payload_hash: string; alert_id: string; entry_id: string; received_at: string; kind?: 'confirmation'; confirmation_key?: string }
export interface AlertManifest { version: 1; published_at: string | null; alerts: AlertReference[]; receipts: Receipt[] }
export type PublicEntry = Omit<StoredEntry, 'publisher_fingerprint'> & { client_ref: string; retracted_at?: string };
export interface ReadAlert extends AlertView { history: PublicEntry[] }
export interface AlertIndex extends Omit<AlertView, 'detail'> { revision: string; last_received_at: string; confirmation_count: number; last_confirmed_at?: string }
export interface AlertMutationResult {
  alert_id: string; entry_id: string; client_ref: string; state: AlertView['state']; expires_at: string | null;
  status: 'published' | 'duplicate' | 'found' | 'retracted' | 'already_retracted';
  alert: ReadAlert; entry: PublicEntry; dry_run?: true; committed?: false; checked_at?: string;
  warnings?: PublicationWarning[];
}
export interface AlertListResult<T = ReadAlert> { days: number; fields?: 'full' | 'index'; history?: HistoryMode; as_of: string; published_at: string | null; alerts: T[]; next_cursor: string | null }
export interface AlertReadResult { fields: 'full' | 'index'; history?: HistoryMode; as_of: string; alert: ReadAlert | AlertIndex }
export interface ConfirmationInput { client_ref: string; alert_id: string; source: AlertFields['source']; source_url: string; observed_at: string }
export interface ConfirmationSuccess { index: number; ok: true; status: 'confirmed' | 'duplicate'; client_ref: string; alert_id: string; entry_id: string; received_at: string; alert: AlertIndex }
export interface ConfirmationFailure { index: number; ok: false; status: number; code: string; error: string; retryable: boolean; details: HttpError['details'] }
export interface ConfirmationsResult { counts: { submitted: number; confirmed: number; duplicates: number; failed: number }; items: (ConfirmationSuccess | ConfirmationFailure)[]; dry_run?: true; committed?: false; checked_at?: string }
export type AlertsReply = { ok: true; result: AlertMutationResult | AlertListResult | AlertListResult<AlertIndex> | AlertReadResult | ConfirmationsResult } | { ok: false; failure: PublishFailure & { details?: HttpError['details']; details_truncated?: boolean } };
const emptyManifest = (): AlertManifest => ({ version: 1, published_at: null, alerts: [], receipts: [] });
const member = (value: unknown, values: readonly string[]): value is string => typeof value === 'string' && values.includes(value);

function invalidFields(issues: ValidationIssue[]): never {
  throw new HttpError(400, 'Alert validation failed', {}, { code: 'validation_failed', details: issues.slice(0, 50), details_truncated: issues.length > 50 });
}

export function validateAlertInput(value: unknown): AlertInput {
  if (!record(value)) invalidFields([{ path: 'alert', code: 'invalid_type', message: 'Expected an object.' }]);
  const issues: ValidationIssue[] = [];
  const invalid = (path: string, message: string) => issues.push({ path, code: 'invalid_field', message });
  const output: Record<string, unknown> = {};
  if (!isClientRef(value.client_ref)) invalid('client_ref', 'Expected a nonblank reference of at most 128 characters without control characters.');
  output.client_ref = value.client_ref;
  if (!member(value.phase, ['open', 'update', 'resolved'])) invalid('phase', 'Expected open, update, or resolved.');
  output.phase = value.phase;
  if (value.phase !== 'open' || value.alert_id !== undefined) {
    if (typeof value.alert_id !== 'string' || !uuid.test(value.alert_id) || value.phase === 'open') invalid('alert_id', 'Updates and resolutions require an alert UUID; openings must omit it.');
    output.alert_id = value.alert_id;
  }
  for (const [key, values] of [['source', sources], ['category', ['traffic', 'power']], ['kind', [...trafficKinds, ...powerKinds]]] as const) {
    if (value[key] !== undefined || key === 'source' || value.phase === 'open') {
      if (!member(value[key], values)) invalid(key, `Expected one of: ${values.join(', ')}.`);
      output[key] = value[key];
    }
  }
  if (!httpUrl(value.source_url)) invalid('source_url', 'Expected an absolute HTTP(S) URL without credentials.');
  output.source_url = value.source_url;
  if (!isTimestamp(value.observed_at)) invalid('observed_at', 'Expected an ISO timestamp with an explicit timezone.');
  output.observed_at = value.observed_at;
  if (value.headline !== undefined || value.phase === 'open') {
    if (!text(value.headline)) invalid('headline', 'Expected a nonempty headline.');
    output.headline = value.headline;
  }
  for (const key of ['detail', 'area', 'source_event_id', 'starts_at', 'expected_end'] as const) {
    if (value[key] === undefined) continue;
    const field = value[key];
    if (field !== null && (key === 'starts_at' || key === 'expected_end' ? !isTimestamp(field) : typeof field !== 'string' || key !== 'detail' && !field.trim())) {
      invalid(key, key === 'starts_at' || key === 'expected_end' ? 'Expected a timezone-qualified ISO timestamp or null.' : 'Expected a string or null.');
    }
    output[key] = field;
  }
  if (value.routes !== undefined) {
    if (value.routes !== null && (!Array.isArray(value.routes) || !value.routes.length || value.routes.some(route => !member(route, ALERT_ROUTES)) || new Set(value.routes).size !== value.routes.length)) invalid('routes', 'Expected unique supported state routes, or null.');
    output.routes = value.routes;
  }
  if (value.chain_level !== undefined) {
    if (value.chain_level !== null && !member(value.chain_level, ['R1', 'R2', 'R3'])) invalid('chain_level', 'Expected R1, R2, R3, or null.');
    output.chain_level = value.chain_level;
  }
  if (value.power !== undefined) {
    if (value.power === null) output.power = null;
    else if (!record(value.power)) invalid('power', 'Expected a power object or null.');
    else {
      const power: Record<string, unknown> = {};
      if (value.power.stage !== undefined) {
        if (!member(value.power.stage, stages)) invalid('power.stage', `Expected one of: ${stages.join(', ')}.`);
        power.stage = value.power.stage;
      }
      if (value.power.customer_count !== undefined) {
        if (value.power.customer_count !== null && (!Number.isSafeInteger(value.power.customer_count) || Number(value.power.customer_count) < 0)) invalid('power.customer_count', 'Expected a nonnegative safe integer or null.');
        power.customer_count = value.power.customer_count;
      }
      output.power = power;
    }
  }
  if (issues.length) invalidFields(issues);
  const input = output as unknown as AlertInput;
  if (input.phase === 'open') validateEffective(applyFields({} as AlertFields, input));
  return input;
}

function applyFields(previous: AlertFields, input: AlertInput): AlertFields {
  const next = { ...previous } as unknown as Record<string, unknown>;
  for (const key of ['category', 'kind', 'headline', 'source', 'source_url', 'observed_at', 'detail', 'starts_at', 'expected_end', 'source_event_id', 'routes', 'area', 'chain_level'] as const) {
    if (input[key] === null) delete next[key];
    else if (input[key] !== undefined) next[key] = input[key];
  }
  if (input.power === null) delete next.power;
  else if (input.power !== undefined) {
    const power = { ...previous.power, ...input.power };
    if (power.customer_count === null) delete power.customer_count;
    next.power = power;
  }
  return next as unknown as AlertFields;
}

function validateEffective(value: AlertFields): void {
  const issues: ValidationIssue[] = [];
  const invalid = (path: string, message: string) => issues.push({ path, code: 'invalid_field', message });
  if (value.category === 'traffic') {
    if (!member(value.kind, trafficKinds)) invalid('kind', 'Expected a traffic kind.');
    if (!value.routes?.length && !value.area) invalid('routes', 'Traffic alerts require routes or an affected area.');
    if (value.power) invalid('power', 'Power fields belong to power alerts.');
    if (value.kind === 'chain-control' && !value.chain_level) invalid('chain_level', 'Chain controls require a chain level.');
    if (value.kind !== 'chain-control' && value.chain_level) invalid('chain_level', 'Only chain controls have a chain level.');
  } else {
    if (!member(value.kind, powerKinds)) invalid('kind', 'Expected a power kind.');
    if (!value.area) invalid('area', 'Power alerts require an affected area.');
    if (value.routes || value.chain_level) invalid('routes', 'Road and chain fields belong to traffic alerts.');
    const allowed = value.kind === 'outage' ? ['in-effect'] : value.kind === 'planned-outage' ? ['scheduled', 'in-effect'] : stages;
    if (!value.power || !member(value.power.stage, allowed)) invalid('power.stage', `Expected one of: ${allowed.join(', ')}.`);
  }
  if (value.starts_at && value.expected_end && Date.parse(value.expected_end) < Date.parse(value.starts_at)) invalid('expected_end', 'Expected end must not precede the start.');
  if (Date.parse(value.expected_end ?? value.observed_at) + ALERT_DAY > Date.parse('9999-12-31T23:59:59.999Z')) invalid('expected_end', 'The expiry deadline must fit within a four-digit ISO year.');
  if (issues.length) invalidFields(issues);
}

function atTime(alert: AlertView, now: Date): AlertView {
  const open = alert.state === 'open' || alert.state === 'expired-unconfirmed';
  return { ...alert, state: open ? Date.parse(alert.expires_at!) <= now.getTime() ? 'expired-unconfirmed' : 'open' : alert.state,
    upcoming: open && !!alert.starts_at && Date.parse(alert.starts_at) > now.getTime() };
}

export function deriveAlert(value: AlertRecord, now: Date): AlertView {
  const removed = new Set(value.retractions.map(entry => entry.entry_id));
  const opening = value.entries[0];
  let fields = applyFields({} as AlertFields, opening.input);
  let state: AlertView['state'] = removed.has(opening.entry_id) ? 'retracted' : 'open';
  if (state !== 'retracted') for (const entry of value.entries.slice(1)) {
    if (removed.has(entry.entry_id)) continue;
    fields = applyFields(fields, entry.input);
    if (entry.input.phase === 'resolved') state = 'resolved';
  }
  const expires_at = state === 'open' ? new Date(Date.parse(fields.expected_end ?? fields.observed_at) + ALERT_DAY).toISOString() : null;
  return atTime({ ...fields, alert_id: value.alert_id, state, expires_at, upcoming: false }, now);
}

function publicEntry(value: AlertRecord, entry: StoredEntry): PublicEntry {
  const retracted_at = value.retractions.find(change => change.entry_id === entry.entry_id)?.retracted_at;
  return { entry_id: entry.entry_id, received_at: entry.received_at, client_ref: entry.input.client_ref, input: entry.input, ...(retracted_at ? { retracted_at } : {}),
    ...(entry.entry_type ? { entry_type: entry.entry_type, retractable: false as const } : {}), ...(entry.confirmation_run ? { confirmation_run: entry.confirmation_run } : {}) };
}
export function readAlert(value: AlertRecord, now: Date): ReadAlert {
  return { ...deriveAlert(value, now), history: value.entries.map(entry => publicEntry(value, entry)) };
}
function mutationResult(value: AlertRecord, entry: StoredEntry, status: AlertMutationResult['status'], now: Date): AlertMutationResult {
  const alert = readAlert(value, now);
  return { alert_id: value.alert_id, entry_id: entry.entry_id, client_ref: entry.input.client_ref, status,
    state: alert.state, expires_at: alert.expires_at, entry: publicEntry(value, entry), alert };
}
export function alertIndex(ref: AlertReference, now: Date): AlertIndex {
  const { detail: _detail, ...alert } = atTime(ref.alert, now);
  return { ...alert, revision: fingerprint(canonical([ref.key, ref.revision ?? null, alert.state, alert.upcoming])),
    last_received_at: ref.last_received_at, confirmation_count: ref.confirmation_count ?? 0,
    ...(ref.last_confirmed_at ? { last_confirmed_at: ref.last_confirmed_at } : {}) };
}

function duplicateWarnings(input: AlertInput, manifest: AlertManifest, now: Date): PublicationWarning[] {
  if (input.phase !== 'open') return [];
  const location = (value: { routes?: readonly string[] | null; area?: string | null }) => canonical([
    [...(value.routes ?? [])].sort(), (value.area ?? '').trim().replace(/\s+/g, ' ').toLowerCase()]);
  const matches = manifest.alerts.flatMap<NonNullable<PublicationWarning['matches']>[number]>(ref => {
    const alert = atTime(ref.alert, now);
    if (alert.state !== 'open' || alert.category !== input.category || alert.kind !== input.kind) return [];
    if (input.source_event_id && alert.source_event_id) {
      return input.source === alert.source && input.source_event_id === alert.source_event_id
        ? [{ alert_id: ref.alert_id, reason: 'source_event_id' as const }] : [];
    }
    return location(input) === location(alert) ? [{ alert_id: ref.alert_id, reason: 'location' as const }] : [];
  }).sort((a, b) => a.alert_id.localeCompare(b.alert_id));
  return matches.length ? [{ field: 'phase', code: 'possible_duplicate_alert', value: 'open',
    message: 'An existing open alert may describe this condition. Review the matching alert IDs before opening another occurrence.',
    matches: matches.slice(0, 50), ...(matches.length > 50 ? { matches_truncated: true } : {}) }] : [];
}

async function readJson(bucket: ContentBucket, key: string): Promise<unknown> {
  const object = await boundary('storage', () => bucket.get(key));
  if (!object) throw new DamagedManifest(key, 'missing');
  const serialized = await boundary('storage', () => object.text());
  if (key !== ALERTS_KEY && !key.endsWith(`/${fingerprint(serialized)}.json`)) throw new DamagedManifest(key, 'invalid_manifest');
  try { return JSON.parse(serialized); } catch { throw new DamagedManifest(key, 'invalid_json'); }
}
export async function loadAlertManifest(bucket: ContentBucket, snapshot?: string, identity?: { key?: string }): Promise<AlertManifest> {
  if (!snapshot) {
    const object = await boundary('storage', () => bucket.get(ALERTS_KEY));
    if (!object) return emptyManifest();
    let pointer: unknown;
    try { pointer = JSON.parse(await boundary('storage', () => object.text())); } catch (error) {
      if (error instanceof SyntaxError) throw new DamagedManifest(ALERTS_KEY, 'invalid_json');
      throw error;
    }
    if (!record(pointer) || pointer.version !== 1 || typeof pointer.snapshot !== 'string' || !snapshotKey.test(pointer.snapshot)) throw new DamagedManifest(ALERTS_KEY, 'invalid_manifest');
    snapshot = pointer.snapshot;
  }
  const value = await readJson(bucket, snapshot);
  if (!record(value) || value.version !== 1 || !isTimestamp(value.published_at) || !Array.isArray(value.alerts) || !Array.isArray(value.receipts)
    || !value.alerts.every(ref => record(ref) && typeof ref.alert_id === 'string' && uuid.test(ref.alert_id) && typeof ref.key === 'string' && revisionKey.test(ref.key)
      && isTimestamp(ref.last_received_at) && (ref.revision === undefined || typeof ref.revision === 'string' && /^[a-f0-9]{64}$/.test(ref.revision))
      && (ref.confirmation_count === undefined || Number.isSafeInteger(ref.confirmation_count) && Number(ref.confirmation_count) >= 0)
      && (ref.last_confirmed_at === undefined || isTimestamp(ref.last_confirmed_at)) && record(ref.alert) && ref.alert.alert_id === ref.alert_id && member(ref.alert.state, states)
      && (ref.alert.expires_at === null ? ['resolved', 'retracted'].includes(String(ref.alert.state)) : isTimestamp(ref.alert.expires_at)) && isTimestamp(ref.alert.observed_at))
    || new Set(value.alerts.map(ref => ref.alert_id)).size !== value.alerts.length
    || !value.receipts.every(ref => record(ref) && isClientRef(ref.client_ref) && typeof ref.payload_hash === 'string' && /^[a-f0-9]{64}$/.test(ref.payload_hash)
      && (ref.kind === undefined || ref.kind === 'confirmation' && typeof ref.confirmation_key === 'string' && /^alerts\/confirmations\/[a-f0-9]{64}\.json$/.test(ref.confirmation_key))
      && typeof ref.alert_id === 'string' && uuid.test(ref.alert_id) && typeof ref.entry_id === 'string' && uuid.test(ref.entry_id) && isTimestamp(ref.received_at))
    || new Set(value.receipts.map(ref => ref.client_ref)).size !== value.receipts.length) throw new DamagedManifest(snapshot, 'invalid_manifest');
  if (identity) identity.key = snapshot;
  return value as unknown as AlertManifest;
}
function storedEntry(value: unknown): StoredEntry {
  if (!record(value) || typeof value.entry_id !== 'string' || !uuid.test(value.entry_id) || !isTimestamp(value.received_at)
    || typeof value.publisher_fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.publisher_fingerprint)) throw new Error('Invalid stored entry');
  return { entry_id: value.entry_id, received_at: value.received_at, publisher_fingerprint: value.publisher_fingerprint, input: validateAlertInput(value.input) };
}
export async function loadAlertRecord(bucket: ContentBucket, ref: AlertReference, history: HistoryMode = 'full'): Promise<AlertRecord> {
  const value = await readJson(bucket, ref.key);
  try {
    if (record(value) && value.version === 2) {
      if (!isHistoryRoot(value, ref.alert_id)) throw new Error();
      // The shared base is always v1, so malformed references cannot form cycles.
      const baseValue = await readJson(bucket, value.base);
      if (!record(baseValue) || baseValue.version !== 1) throw new Error();
      const base = validateRecord(baseValue, ref.alert_id);
      const entries = [...base.entries, ...await expandHistory(value, history, key => readJson(bucket, key), storedEntry)];
      validateRetractions(value.retractions, entries.filter(entry => !entry.entry_type));
      return { version: 1, alert_id: ref.alert_id, entries, retractions: value.retractions, storage: value };
    }
    return validateRecord(value, ref.alert_id);
  } catch (error) {
    if (error instanceof DamagedManifest || error instanceof DamagedSource) throw error;
    throw new DamagedSource(ref.key, ref.alert_id, 'invalid_digest');
  }
}
function validateRetractions(value: unknown, entries: StoredEntry[]): asserts value is Retraction[] {
  const ids = new Set(entries.map(entry => entry.entry_id));
  if (ids.size !== entries.length || !Array.isArray(value)
    || !value.every(change => record(change) && typeof change.entry_id === 'string' && ids.has(change.entry_id) && isTimestamp(change.retracted_at))
    || new Set(value.map(change => change.entry_id)).size !== value.length) throw new Error('Invalid retractions');
}
function validateRecord(value: unknown, alertId: string): AlertRecord {
  if (!record(value) || value.version !== 1 || value.alert_id !== alertId || !Array.isArray(value.entries) || !value.entries.length) throw new Error('Invalid alert record');
  const entries = value.entries.map(storedEntry);
  entries.forEach((entry, i) => { if (i === 0 ? entry.input.phase !== 'open' : entry.input.phase === 'open' || entry.input.alert_id !== alertId) throw new Error('Invalid alert sequence'); });
  validateRetractions(value.retractions, entries);
  return { version: 1, alert_id: alertId, entries, retractions: value.retractions };
}
const jsonOptions = { httpMetadata: { contentType: 'application/json' } };
async function writeRecord(bucket: ContentBucket, value: AlertRecord, now: Date, trace: OperationTrace): Promise<AlertReference> {
  let stored: AlertRecord | HistoryRoot = { version: 1, alert_id: value.alert_id, entries: value.entries, retractions: value.retractions };
  if (value.storage) {
    const root = { ...value.storage, timeline: [...value.storage.timeline], retractions: value.retractions };
    for (const entry of value.pending_entries ?? []) {
      const serialized = JSON.stringify(entry); const key = `alerts/entries/${fingerprint(serialized)}.json`;
      await trace.run('alert_entry_write', () => boundary('storage', () => bucket.put(key, serialized, jsonOptions)));
      root.timeline.push({ type: 'entry', entry_id: entry.entry_id, key });
    }
    root.content_revision = fingerprint(canonical([root.base, root.timeline.filter(item => item.type === 'entry'), root.retractions]));
    stored = root;
  }
  const serialized = JSON.stringify(stored); const key = `alerts/revisions/${fingerprint(serialized)}.json`;
  await trace.run('alert_revision_write', () => boundary('storage', () => bucket.put(key, serialized, jsonOptions)));
  const runs = value.storage?.timeline.filter((item): item is ConfirmationRun => item.type === 'confirmations') ?? [];
  return { alert_id: value.alert_id, key, last_received_at: now.toISOString(), alert: deriveAlert(value, now), revision: fingerprint(serialized),
    confirmation_count: runs.reduce((count, run) => count + run.count, 0), ...(runs.length ? { last_confirmed_at: runs.at(-1)!.last_observed_at } : {}) };
}
async function commitManifest(bucket: ContentBucket, manifest: AlertManifest, trace: OperationTrace): Promise<void> {
  const serialized = JSON.stringify(manifest); const key = `alerts/snapshots/${fingerprint(serialized)}.json`;
  await trace.run('alert_snapshot_write', () => boundary('storage', () => bucket.put(key, serialized, jsonOptions)));
  trace.publication_status = 'unknown';
  await trace.run('alert_manifest_write', () => boundary('storage', () => bucket.put(ALERTS_KEY, JSON.stringify({ version: 1, snapshot: key }), jsonOptions)));
  trace.publication_status = 'committed';
}
async function commitRecord(bucket: ContentBucket, manifest: AlertManifest, value: AlertRecord, now: Date, trace: OperationTrace, receipt?: Receipt): Promise<void> {
  const ref = await writeRecord(bucket, value, now, trace); const days = recentDates(now, 30);
  await commitManifest(bucket, { version: 1, published_at: now.toISOString(), alerts: [...manifest.alerts.filter(prior => prior.alert_id !== value.alert_id), ref],
    receipts: [...manifest.receipts.filter(prior => days.includes(localDate(new Date(prior.received_at)))), ...(receipt ? [receipt] : [])] }, trace);
}

export function validateConfirmationBatch(value: unknown): unknown[] {
  if (!record(value) || !Array.isArray(value.confirmations) || value.confirmations.length < 1 || value.confirmations.length > 100) {
    throw new HttpError(400, 'confirmations must contain between 1 and 100 checks.', {}, { code: 'validation_failed',
      details: [{ path: 'confirmations', code: 'invalid_count', message: 'Expected an array of 1–100 confirmations.' }] });
  }
  return value.confirmations;
}
function validateConfirmation(value: unknown): ConfirmationInput {
  if (!record(value)) invalidFields([{ path: 'confirmation', code: 'invalid_type', message: 'Expected a confirmation object.' }]);
  const allowed = ['client_ref', 'alert_id', 'source', 'source_url', 'observed_at'];
  const extras = Object.keys(value).filter(key => !allowed.includes(key));
  if (extras.length) invalidFields(extras.map(path => ({ path, code: 'unsupported_field', message: 'Confirmations cannot change alert content or lifecycle.' })));
  const input = validateAlertInput({ ...value, phase: 'update' });
  return { client_ref: input.client_ref, alert_id: input.alert_id!, source: input.source, source_url: input.source_url, observed_at: input.observed_at };
}
async function rootForConfirmation(bucket: ContentBucket, ref: AlertReference): Promise<HistoryRoot> {
  const raw = await readJson(bucket, ref.key);
  if (record(raw) && raw.version === 2) {
    if (!isHistoryRoot(raw, ref.alert_id)) throw new DamagedSource(ref.key, ref.alert_id, 'invalid_digest');
    return { ...raw, timeline: [...raw.timeline] };
  }
  try {
    const base = validateRecord(raw, ref.alert_id);
    return { version: 2, alert_id: ref.alert_id, base: ref.key, timeline: [], retractions: base.retractions,
      content_revision: fingerprint(canonical([ref.key, [], base.retractions])) };
  } catch { throw new DamagedSource(ref.key, ref.alert_id, 'invalid_digest'); }
}
async function confirmationReceipt(bucket: ContentBucket, ref: AlertReference, receipt: Receipt) {
  if (!receipt.confirmation_key || !/^alerts\/confirmations\/[a-f0-9]{64}\.json$/.test(receipt.confirmation_key)) throw new DamagedManifest(ALERTS_KEY, 'invalid_manifest');
  const root = await rootForConfirmation(bucket, ref);
  const node = await readJson(bucket, receipt.confirmation_key);
  if (!isConfirmationNode(node, ref.alert_id) || node.client_ref !== receipt.client_ref || node.entry_id !== receipt.entry_id || node.received_at !== receipt.received_at) throw new DamagedSource(receipt.confirmation_key, ref.alert_id, 'invalid_digest');
  const run = root.timeline.find((item): item is ConfirmationRun => item.type === 'confirmations' && item.run_id === node.run_id);
  if (!run) throw new DamagedSource(ref.key, ref.alert_id, 'invalid_digest');
  return { node, run, entry: confirmationEntry(ref.alert_id, run, node) };
}
export async function confirmAlerts(bucket: ContentBucket, inputs: unknown[], now = new Date(), context?: OperationContext, dryRun = false, beforeCommit?: () => Promise<void>): Promise<ConfirmationsResult> {
  const trace = new OperationTrace(context);
  try {
    // RPC callers get the same envelope validation as HTTP callers.
    inputs = validateConfirmationBatch({ confirmations: inputs });
    const manifest = await trace.run('alert_manifest_loading', () => loadAlertManifest(bucket));
    const days = recentDates(now, 30);
    const receipts = manifest.receipts.filter(receipt => days.includes(localDate(new Date(receipt.received_at))));
    const claimed = new Set<string>();
    const drafts: { root: HistoryRoot; node: ConfirmationNode; key: string; ref: AlertReference }[] = [];
    const items: ConfirmationsResult['items'] = [];
    for (let index = 0; index < inputs.length; index++) {
      try {
        const input = validateConfirmation(inputs[index]);
        const ref = manifest.alerts.find(ref => ref.alert_id === input.alert_id);
        if (!ref) throw new HttpError(404, 'Alert not found.', {}, { code: 'alert_not_found' });
        if (claimed.has(input.alert_id)) throw new HttpError(400, 'Only one valid check per alert is allowed in a batch.', {}, { code: 'duplicate_alert_id' });
        const payload_hash = fingerprint(canonical({ operation: 'confirmation', ...input }));
        const receipt = receipts.find(receipt => receipt.client_ref === input.client_ref);
        if (receipt) {
          if (receipt.kind !== 'confirmation') throw new HttpError(409, 'client_ref identifies a different alert submission.', {}, { code: 'client_ref_conflict' });
          if (receipt.alert_id !== input.alert_id) throw new HttpError(409, 'client_ref identifies another alert.', {}, { code: 'client_ref_conflict' });
          const prior = await confirmationReceipt(bucket, ref, receipt);
          const { phase: _phase, ...original } = prior.entry.input;
          if (receipt.payload_hash !== payload_hash && canonical(timestampPayload(original)) !== canonical(timestampPayload(input))) throw new HttpError(409, 'client_ref identifies a different confirmation.', {}, { code: 'client_ref_conflict' });
          claimed.add(input.alert_id);
          items.push({ index, ok: true, status: 'duplicate', client_ref: input.client_ref, alert_id: input.alert_id, entry_id: receipt.entry_id, received_at: receipt.received_at, alert: alertIndex(ref, now) });
          continue;
        }
        const effective = atTime(ref.alert, now);
        if (effective.state === 'resolved' || effective.state === 'retracted') throw new HttpError(409, 'A resolved or retracted alert requires a new opening.', {}, { code: 'alert_closed' });
        if (instant(input.observed_at) < instant(effective.observed_at)) throw new HttpError(409, 'Observation precedes the latest surviving observation.', {}, { code: 'stale_observation' });
        const nextFields = applyFields(effective, { ...input, phase: 'update' });
        validateEffective(nextFields);
        const root = await rootForConfirmation(bucket, ref);
        const last = root.timeline.at(-1);
        const extend = last?.type === 'confirmations' && last.content_revision === root.content_revision && last.source === input.source && last.source_url === input.source_url;
        const node: ConfirmationNode = { version: 1, alert_id: input.alert_id, run_id: extend ? last.run_id : crypto.randomUUID(), entry_id: crypto.randomUUID(),
          client_ref: input.client_ref, observed_at: input.observed_at, received_at: now.toISOString(), previous: extend ? last.head : null };
        const nodeKey = confirmationKey(node);
        const run: ConfirmationRun = { type: 'confirmations', run_id: node.run_id, content_revision: root.content_revision, source: input.source, source_url: input.source_url,
          count: extend ? last.count + 1 : 1, first_observed_at: extend ? last.first_observed_at : node.observed_at, last_observed_at: node.observed_at,
          first_received_at: extend ? last.first_received_at : node.received_at, last_received_at: node.received_at, head: nodeKey,
          latest: { entry_id: node.entry_id, client_ref: node.client_ref, observed_at: node.observed_at, received_at: node.received_at } };
        if (extend) root.timeline[root.timeline.length - 1] = run; else root.timeline.push(run);
        const serialized = JSON.stringify(root); const key = `alerts/revisions/${fingerprint(serialized)}.json`;
        const runs = root.timeline.filter((item): item is ConfirmationRun => item.type === 'confirmations');
        const alert = atTime({ ...nextFields, state: 'open', alert_id: input.alert_id, upcoming: false,
          expires_at: new Date(Date.parse(nextFields.expected_end ?? nextFields.observed_at) + ALERT_DAY).toISOString() }, now);
        const next: AlertReference = { alert_id: input.alert_id, key, last_received_at: now.toISOString(), alert, revision: fingerprint(serialized),
          confirmation_count: runs.reduce((count, item) => count + item.count, 0), last_confirmed_at: node.observed_at };
        drafts.push({ root, node, key, ref: next }); claimed.add(input.alert_id);
        receipts.push({ client_ref: input.client_ref, payload_hash, alert_id: input.alert_id, entry_id: node.entry_id, received_at: node.received_at, kind: 'confirmation', confirmation_key: nodeKey });
        items.push({ index, ok: true, status: 'confirmed', client_ref: input.client_ref, alert_id: input.alert_id, entry_id: node.entry_id, received_at: node.received_at, alert: alertIndex(next, now) });
      } catch (error) {
        const failure = asHttpError(error);
        // Storage/transport failures invalidate the operation, not just one item.
        if (failure.status >= 500) throw error;
        items.push({ index, ok: false, status: failure.status, code: failure.code, error: failure.message, retryable: failure.retryable, details: failure.details });
      }
    }
    if (drafts.length && !dryRun) {
      if (beforeCommit) await trace.run('alert_homepage_intent', beforeCommit);
      for (const draft of drafts) {
        const node = JSON.stringify(draft.node); const root = JSON.stringify(draft.root);
        await trace.run('alert_confirmation_write', () => boundary('storage', () => bucket.put(confirmationKey(draft.node), node, jsonOptions)), { bytes_written: new TextEncoder().encode(node).length });
        await trace.run('alert_revision_write', () => boundary('storage', () => bucket.put(draft.key, root, jsonOptions)), { bytes_written: new TextEncoder().encode(root).length });
      }
      const revised = new Map(drafts.map(draft => [draft.ref.alert_id, draft.ref]));
      await commitManifest(bucket, { version: 1, published_at: now.toISOString(), alerts: manifest.alerts.map(ref => revised.get(ref.alert_id) ?? ref), receipts }, trace);
    }
    const counts = { submitted: inputs.length, confirmed: drafts.length, duplicates: items.filter(item => item.ok && item.status === 'duplicate').length, failed: items.filter(item => !item.ok).length };
    emit(dryRun ? 'confirmations_preview_result' : 'confirmations_result', context, { ...counts, publication_status: dryRun ? 'not_attempted' : drafts.length ? 'committed' : 'not_attempted' });
    return { counts, items, ...(dryRun ? { dry_run: true, committed: false, checked_at: now.toISOString() } : {}) };
  } catch (error) { throw alertFailure(error, trace, dryRun); }
}

export async function submitAlert(bucket: ContentBucket, input: AlertInput, owner: string, now = new Date(), context?: OperationContext, dryRun = false, beforeCommit?: () => Promise<void>): Promise<AlertMutationResult> {
  const trace = new OperationTrace(context);
  try {
    // Revalidate at the serialized boundary, not just in the public Worker.
    input = validateAlertInput(input);
    const manifest = await trace.run('alert_manifest_loading', () => loadAlertManifest(bucket));
    const days = recentDates(now, 30);
    const payload_hash = fingerprint(canonical(input));
    const receipt = manifest.receipts.find(ref => ref.client_ref === input.client_ref && days.includes(localDate(new Date(ref.received_at))));
    let result: AlertMutationResult;
    if (receipt) {
      if (receipt.kind === 'confirmation') throw new HttpError(409, 'client_ref identifies a confirmation.', {}, { code: 'client_ref_conflict' });
      const ref = manifest.alerts.find(ref => ref.alert_id === receipt.alert_id);
      if (!ref) throw new DamagedManifest(ALERTS_KEY, 'invalid_manifest');
      const value = await trace.run('alert_revision_loading', () => loadAlertRecord(bucket, ref));
      const entry = value.entries.find(entry => entry.entry_id === receipt.entry_id);
      if (!entry) throw new DamagedSource(ref.key, ref.alert_id, 'invalid_digest');
      if (receipt.payload_hash !== payload_hash && canonical(timestampPayload(entry.input)) !== canonical(timestampPayload(input))) {
        throw new HttpError(409, 'client_ref identifies a different alert submission.', {}, { code: 'client_ref_conflict' });
      }
      result = mutationResult(value, entry, 'duplicate', now);
    } else {
      let value: AlertRecord;
      if (input.phase === 'open') value = { version: 1, alert_id: crypto.randomUUID(), entries: [], retractions: [] };
      else {
        const ref = manifest.alerts.find(ref => ref.alert_id === input.alert_id);
        if (!ref) throw new HttpError(404, 'Alert not found.', {}, { code: 'alert_not_found' });
        value = await trace.run('alert_revision_loading', () => loadAlertRecord(bucket, ref));
        const effective = deriveAlert(value, now);
        if (effective.state === 'resolved' || effective.state === 'retracted') throw new HttpError(409, 'A resolved or retracted alert requires a new opening.', {}, { code: 'alert_closed' });
        if (input.category !== undefined && input.category !== effective.category || input.kind !== undefined && input.kind !== effective.kind) throw new HttpError(409, 'Alert category and kind cannot be changed.', {}, { code: 'alert_identity_conflict' });
        if (instant(input.observed_at) < instant(effective.observed_at)) throw new HttpError(409, 'Observation precedes the latest surviving observation.', {}, { code: 'stale_observation' });
        validateEffective(applyFields(effective, input));
      }
      const entry: StoredEntry = { entry_id: crypto.randomUUID(), received_at: now.toISOString(), input, publisher_fingerprint: owner };
      value = { ...value, entries: [...value.entries, entry], ...(value.storage ? { pending_entries: [entry] } : {}) };
      result = mutationResult(value, entry, 'published', now);
      const warnings = duplicateWarnings(input, manifest, now);
      if (warnings.length) result.warnings = warnings;
      if (!dryRun) {
        if (beforeCommit) await trace.run('alert_homepage_intent', beforeCommit);
        await commitRecord(bucket, manifest, value, now, trace, { client_ref: input.client_ref, payload_hash, alert_id: value.alert_id, entry_id: entry.entry_id, received_at: entry.received_at });
      }
    }
    emit(dryRun ? 'alert_preview_result' : 'alert_publish_result', context, { alert_id: result.alert_id, entry_id: result.entry_id, state: result.state, expires_at: result.expires_at, outcome: dryRun ? 'preview' : result.status });
    return { ...result, ...(dryRun ? { dry_run: true, committed: false, checked_at: now.toISOString() } : {}) };
  } catch (error) { throw alertFailure(error, trace, dryRun); }
}

function alertFailure(error: unknown, trace: OperationTrace, dryRun = false): HttpError {
  // Preserve validation fields and boundary classification across the RPC.
  const failure = asHttpError(error);
  const status = dryRun ? 'not_attempted' : trace.publication_status;
  return Object.assign(new HttpError(failure.status, failure.message, failure.headers, { code: failure.code, details: failure.details,
    details_truncated: failure.details_truncated, retryable: status === 'unknown' || failure.retryable, publication_status: status }),
  { alert_stage: trace.failed_stage ?? 'alerts' });
}

export async function retractAlertEntry(bucket: ContentBucket, alertId: string, entryId: string, owner: string, now = new Date(), context?: OperationContext, beforeCommit?: () => Promise<void>, dryRun = false): Promise<AlertMutationResult> {
  const trace = new OperationTrace(context);
  try {
    const manifest = await trace.run('alert_manifest_loading', () => loadAlertManifest(bucket));
    const ref = manifest.alerts.find(ref => ref.alert_id === alertId);
    if (!ref) throw new HttpError(404, 'Alert not found.', {}, { code: 'alert_not_found' });
    const value = await trace.run('alert_revision_loading', () => loadAlertRecord(bucket, ref));
    const entry = value.entries.find(entry => entry.entry_id === entryId);
    if (!entry) throw new HttpError(404, 'Alert entry not found.', {}, { code: 'alert_entry_not_found' });
    if (entry.entry_type === 'confirmation') throw new HttpError(403, 'Confirmations cannot be retracted. Submit a corrective observation.', {}, { code: 'confirmation_not_retractable' });
    if (entry.publisher_fingerprint !== owner) throw new HttpError(403, 'Retraction requires the original publishing token.', {}, { code: 'retract_forbidden' });
    const preview = dryRun ? { dry_run: true as const, committed: false as const, checked_at: now.toISOString() } : {};
    if (value.retractions.some(change => change.entry_id === entryId)) return { ...mutationResult(value, entry, 'already_retracted', now), ...preview };
    if (now.getTime() - Date.parse(entry.received_at) >= ALERT_DAY) throw new HttpError(403, 'The entry retraction window has expired.', {}, { code: 'retract_window_expired' });
    const next = { ...value, retractions: [...value.retractions, { entry_id: entryId, retracted_at: now.toISOString() }] };
    const effective = deriveAlert(next, now);
    if (effective.state !== 'retracted') {
      try { validateEffective(effective); }
      catch { throw new HttpError(409, 'Later entries depend on this change. Correct their fields before retracting it.', {}, { code: 'retraction_dependency_conflict' }); }
    }
    if (!dryRun) {
      if (beforeCommit) await trace.run('alert_homepage_intent', beforeCommit);
      await commitRecord(bucket, manifest, next, now, trace);
    }
    return { ...mutationResult(next, entry, 'retracted', now), ...preview };
  } catch (error) { throw alertFailure(error, trace, dryRun); }
}

export async function currentAlertViews(bucket: ContentBucket, now = new Date()): Promise<AlertView[]> {
  return (await loadAlertManifest(bucket)).alerts.map(ref => atTime(ref.alert, now)).filter(alert => alert.state === 'open');
}

interface Cursor { snapshot: string; as_of: string; days: number; offset: number; fields?: 'full' | 'index'; history?: HistoryMode }
const badCursor = () => new HttpError(400, 'Invalid alert cursor. Start a fresh read.', {}, { code: 'invalid_cursor' });
const signature = (payload: string, secret: string) => createHmac('sha256', secret).update(`alerts-v1:${payload}`).digest();
function encodeCursor(value: Cursor, secret: string): string {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${payload}.${signature(payload, secret).toString('base64url')}`;
}
function decodeCursor(value: string, secret: string): Cursor {
  if (value.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) throw badCursor();
  const [payload, hash] = value.split('.');
  const actual = Buffer.from(hash, 'base64url');
  const expected = signature(payload, secret);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw badCursor();
  let cursor: unknown;
  try { cursor = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { throw badCursor(); }
  if (!record(cursor) || typeof cursor.snapshot !== 'string' || !snapshotKey.test(cursor.snapshot) || !isTimestamp(cursor.as_of)
    || !Number.isInteger(cursor.days) || Number(cursor.days) < 1 || Number(cursor.days) > 30 || !Number.isSafeInteger(cursor.offset) || Number(cursor.offset) < 0
    || cursor.fields !== undefined && !member(cursor.fields, ['full', 'index']) || cursor.history !== undefined && !member(cursor.history, ['full', 'coalesced'])) throw badCursor();
  return cursor as unknown as Cursor;
}

export async function readAlerts(bucket: ContentBucket, query: URLSearchParams, secret: string, now = new Date(), alertId?: string): Promise<AlertMutationResult | AlertListResult | AlertListResult<AlertIndex> | AlertReadResult> {
  if (query.getAll('fields').length > 1 || query.has('fields') && !member(query.get('fields'), ['full', 'index'])) throw new HttpError(400, 'fields must be full or index.', {}, { code: 'invalid_fields' });
  if (query.getAll('history').length > 1 || query.has('history') && !member(query.get('history'), ['full', 'coalesced'])) throw new HttpError(400, 'history must be full or coalesced.', {}, { code: 'invalid_history' });
  if (query.get('fields') === 'index' && query.has('history')) throw new HttpError(400, 'Index reads do not include history.', {}, { code: 'invalid_history' });
  const requestedHistory = (query.get('history') ?? 'full') as HistoryMode;
  if (alertId !== undefined) {
    if (!uuid.test(alertId)) throw new HttpError(400, 'Invalid alert UUID.', {}, { code: 'validation_failed' });
    if (['client_ref', 'cursor', 'days'].some(key => query.has(key))) throw new HttpError(400, 'Direct alert reads do not accept lookup or pagination parameters.');
    const manifest = await loadAlertManifest(bucket);
    const ref = manifest.alerts.find(ref => ref.alert_id === alertId);
    if (!ref) throw new HttpError(404, 'Alert not found.', {}, { code: 'alert_not_found' });
    const fields = query.get('fields') === 'index' ? 'index' : 'full';
    return { fields, ...(fields === 'full' ? { history: requestedHistory } : {}), as_of: now.toISOString(), alert: fields === 'index' ? alertIndex(ref, now) : readAlert(await loadAlertRecord(bucket, ref, requestedHistory), now) };
  }
  if (query.has('client_ref')) {
    if (query.getAll('client_ref').length !== 1 || query.has('cursor') || query.has('days') || query.has('fields')) throw new HttpError(400, 'Use one client_ref without pagination or fields parameters.');
    const clientRef = validateClientRef(query.get('client_ref'));
    const manifest = await loadAlertManifest(bucket);
    const days = recentDates(now, 30);
    const receipt = manifest.receipts.find(ref => ref.client_ref === clientRef && days.includes(localDate(new Date(ref.received_at))));
    if (!receipt) throw new HttpError(404, 'No submission with this client_ref exists in the 30-day receipt window.', {}, { code: 'alert_reference_not_found' });
    const ref = manifest.alerts.find(ref => ref.alert_id === receipt.alert_id);
    if (!ref) throw new DamagedManifest(ALERTS_KEY, 'invalid_manifest');
    const value = await loadAlertRecord(bucket, ref, requestedHistory);
    const entry = receipt.kind === 'confirmation' ? (await confirmationReceipt(bucket, ref, receipt)).entry : value.entries.find(entry => entry.entry_id === receipt.entry_id);
    if (!entry) throw new DamagedSource(ref.key, ref.alert_id, 'invalid_digest');
    return mutationResult(value, entry, 'found', now);
  }
  if (query.getAll('days').length > 1 || query.has('days') && !/^(?:[1-9]|[12][0-9]|30)$/.test(query.get('days')!)) throw new HttpError(400, 'days must be between 1 and 30.', {}, { code: 'invalid_days' });
  if (query.getAll('cursor').length > 1) throw badCursor();
  const cursor = query.has('cursor') ? decodeCursor(query.get('cursor')!, secret) : undefined;
  const fields = (query.get('fields') ?? cursor?.fields ?? 'full') as 'full' | 'index';
  const history = (query.get('history') ?? cursor?.history ?? 'full') as HistoryMode;
  if (fields === 'index' && history !== 'full' || cursor && ((cursor.fields ?? 'full') !== fields || (cursor.history ?? 'full') !== history)) throw badCursor();
  const days = Number(query.get('days') ?? cursor?.days ?? 30);
  if (cursor && cursor.days !== days) throw badCursor();
  const identity: { key?: string } = {};
  const manifest = await loadAlertManifest(bucket, cursor?.snapshot, identity);
  // Preserve the actual committed key, including operator-restored JSON formatting.
  const snapshot = identity.key;
  const as_of = cursor?.as_of ?? now.toISOString();
  const at = new Date(as_of);
  const dates = recentDates(at, days);
  const selected = manifest.alerts.filter(ref => atTime(ref.alert, at).state === 'open' || dates.includes(localDate(new Date(ref.last_received_at))))
    .sort((a, b) => Date.parse(b.alert.observed_at) - Date.parse(a.alert.observed_at) || a.alert_id.localeCompare(b.alert_id));
  const offset = cursor?.offset ?? 0;
  if (offset > selected.length) throw badCursor();
  const refs = selected.slice(offset, offset + 20);
  const alerts: (ReadAlert | AlertIndex)[] = [];
  for (let i = 0; i < refs.length; i += 4) {
    const results = await Promise.allSettled(refs.slice(i, i + 4).map(async ref => fields === 'index' ? alertIndex(ref, at) : readAlert(await loadAlertRecord(bucket, ref, history), at)));
    for (const result of results) { if (result.status === 'rejected') throw result.reason; alerts.push(result.value); }
  }
  return { days, fields, ...(fields === 'full' ? { history } : {}), as_of, published_at: manifest.published_at, alerts,
    next_cursor: snapshot && offset + refs.length < selected.length ? encodeCursor({ snapshot, as_of, days, offset: offset + refs.length, fields, history }, secret) : null } as AlertListResult | AlertListResult<AlertIndex>;
}

export function isAlertsReply(value: unknown): value is AlertsReply {
  if (!record(value)) return false;
  if (value.ok === false) return isPublishReply(value);
  if (value.ok !== true || !record(value.result)) return false;
  const r = value.result;
  const counts = r.counts;
  if (record(counts) && Array.isArray(r.items)) return ['submitted', 'confirmed', 'duplicates', 'failed'].every(key => Number.isSafeInteger(counts[key]) && Number(counts[key]) >= 0)
    && r.items.every(item => record(item) && Number.isInteger(item.index) && (item.ok === true ? member(item.status, ['confirmed', 'duplicate']) && typeof item.alert_id === 'string' && typeof item.entry_id === 'string' && record(item.alert) : item.ok === false && typeof item.code === 'string' && typeof item.error === 'string'));
  if (r.fields && !member(r.fields, ['full', 'index'])) return false;
  if (r.alert && !r.entry) return member(r.fields, ['full', 'index']) && isTimestamp(r.as_of) && record(r.alert) && typeof r.alert.alert_id === 'string';
  if (Array.isArray(r.alerts)) return Number.isInteger(r.days) && Number(r.days) >= 1 && Number(r.days) <= 30 && isTimestamp(r.as_of)
    && (r.published_at === null || isTimestamp(r.published_at)) && (r.next_cursor === null || typeof r.next_cursor === 'string');
  return typeof r.alert_id === 'string' && uuid.test(r.alert_id) && typeof r.entry_id === 'string' && uuid.test(r.entry_id) && isClientRef(r.client_ref)
    && member(r.state, states) && (r.expires_at === null || isTimestamp(r.expires_at)) && record(r.alert) && Array.isArray(r.alert.history)
    && record(r.entry) && member(r.status, ['published', 'duplicate', 'found', 'retracted', 'already_retracted']);
}

export function alertRpcFailure(error: unknown, context?: OperationContext): Extract<AlertsReply, { ok: false }> {
  const failure = asHttpError(error);
  const stage = (error as { alert_stage?: string })?.alert_stage ?? 'alerts';
  emit('alert_operation_failed', context, { error_code: failure.code, stage, ...safeError(error) }, failure.status >= 500 ? 'error' : 'warn');
  return { ok: false, failure: { status: failure.status, code: failure.code, error: failure.message, stage,
    publication_status: failure.publication_status ?? 'not_attempted', retryable: failure.retryable,
    details: failure.details, details_truncated: failure.details_truncated } };
}
