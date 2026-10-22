import { fingerprint, record } from './primitives';
import { isClientRef, isTimestamp } from './validation';
import { DamagedSource } from './errors';
import type { AlertFields, AlertRecord, HistoryMode, PublicConfirmationRun, Retraction, StoredEntry } from './alerts';

const hashKey = /^alerts\/(?:revisions|entries|confirmations)\/[a-f0-9]{64}\.json$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export interface ConfirmationNode { version: 1; alert_id: string; run_id: string; entry_id: string; client_ref: string; observed_at: string; received_at: string; previous: string | null }
export interface ConfirmationRun extends PublicConfirmationRun {
  type: 'confirmations'; content_revision: string; source: AlertFields['source']; source_url: string; head: string;
  latest: Pick<ConfirmationNode, 'entry_id' | 'client_ref' | 'observed_at' | 'received_at'>;
}
export interface HistoryRoot {
  version: 2; alert_id: string; base: string; content_revision: string;
  timeline: ({ type: 'entry'; entry_id: string; key: string } | ConfirmationRun)[];
  retractions: Retraction[];
}
export function isHistoryRoot(value: unknown, alertId: string): value is HistoryRoot {
  return record(value) && value.version === 2 && value.alert_id === alertId && typeof value.base === 'string' && /^alerts\/revisions\/[a-f0-9]{64}\.json$/.test(value.base)
    && typeof value.content_revision === 'string' && /^[a-f0-9]{64}$/.test(value.content_revision) && Array.isArray(value.retractions)
    && value.retractions.every(item => record(item) && typeof item.entry_id === 'string' && uuid.test(item.entry_id) && isTimestamp(item.retracted_at))
    && Array.isArray(value.timeline) && value.timeline.every(item => {
      if (!record(item)) return false;
      if (item.type === 'entry') return typeof item.entry_id === 'string' && uuid.test(item.entry_id) && typeof item.key === 'string' && /^alerts\/entries\/[a-f0-9]{64}\.json$/.test(item.key);
      return item.type === 'confirmations' && typeof item.run_id === 'string' && uuid.test(item.run_id) && Number.isSafeInteger(item.count) && Number(item.count) > 0
        && typeof item.content_revision === 'string' && /^[a-f0-9]{64}$/.test(item.content_revision)
        && ['caltrans', 'nws', 'sce'].includes(String(item.source)) && typeof item.source_url === 'string'
        && typeof item.head === 'string' && /^alerts\/confirmations\/[a-f0-9]{64}\.json$/.test(item.head)
        && ['first_observed_at', 'last_observed_at', 'first_received_at', 'last_received_at'].every(key => isTimestamp(item[key]))
        && record(item.latest) && typeof item.latest.entry_id === 'string' && uuid.test(item.latest.entry_id) && isClientRef(item.latest.client_ref)
        && item.latest.observed_at === item.last_observed_at && item.latest.received_at === item.last_received_at;
    });
}
export function confirmationEntry(alertId: string, run: ConfirmationRun, node = run.latest, coalesced = false): StoredEntry {
  const { run_id, count, first_observed_at, last_observed_at, first_received_at, last_received_at } = run;
  return { entry_id: node.entry_id, received_at: node.received_at, publisher_fingerprint: '', entry_type: 'confirmation', retractable: false,
    input: { phase: 'update', alert_id: alertId, client_ref: node.client_ref, source: run.source, source_url: run.source_url, observed_at: node.observed_at },
    ...(coalesced ? { confirmation_run: { run_id, count, first_observed_at, last_observed_at, first_received_at, last_received_at } } : {}) };
}
export async function expandHistory(root: HistoryRoot, mode: HistoryMode, read: (key: string) => Promise<unknown>, validate: (value: unknown) => StoredEntry): Promise<StoredEntry[]> {
  const groups: StoredEntry[][] = [];
  for (let i = 0; i < root.timeline.length; i += 4) {
    const settled = await Promise.allSettled(root.timeline.slice(i, i + 4).map(async item => {
      if (item.type === 'entry') {
        const entry = validate(await read(item.key));
        if (entry.entry_id !== item.entry_id || entry.input.alert_id !== root.alert_id || entry.input.phase === 'open') throw new DamagedSource(item.key, root.alert_id, 'invalid_digest');
        return [entry];
      }
      if (mode === 'coalesced') return [confirmationEntry(root.alert_id, item, item.latest, true)];
      const entries: StoredEntry[] = [];
      const seen = new Set<string>();
      let key: string | null = item.head;
      while (key) {
        if (seen.has(key) || entries.length >= item.count) throw new DamagedSource(key, root.alert_id, 'invalid_digest');
        seen.add(key);
        const node = await read(key);
        if (!isConfirmationNode(node, root.alert_id) || node.run_id !== item.run_id) throw new DamagedSource(key, root.alert_id, 'invalid_digest');
        if (!entries.length && (node.entry_id !== item.latest.entry_id || node.client_ref !== item.latest.client_ref || node.received_at !== item.last_received_at || node.observed_at !== item.last_observed_at)) throw new DamagedSource(key, root.alert_id, 'invalid_digest');
        entries.push(confirmationEntry(root.alert_id, item, node)); key = node.previous;
      }
      if (entries.length !== item.count || entries.at(-1)!.input.observed_at !== item.first_observed_at || entries.at(-1)!.received_at !== item.first_received_at) throw new DamagedSource(item.head, root.alert_id, 'invalid_digest');
      return entries.reverse();
    }));
    for (const result of settled) { if (result.status === 'rejected') throw result.reason; groups.push(result.value); }
  }
  return groups.flat();
}
export function isConfirmationNode(value: unknown, alertId: string): value is ConfirmationNode {
  return record(value) && value.version === 1 && value.alert_id === alertId && typeof value.run_id === 'string' && uuid.test(value.run_id)
    && typeof value.entry_id === 'string' && uuid.test(value.entry_id) && isClientRef(value.client_ref) && isTimestamp(value.observed_at) && isTimestamp(value.received_at)
    && (value.previous === null || typeof value.previous === 'string' && hashKey.test(value.previous) && value.previous.startsWith('alerts/confirmations/'));
}
export function confirmationKey(node: ConfirmationNode): string { return `alerts/confirmations/${fingerprint(JSON.stringify(node))}.json`; }
