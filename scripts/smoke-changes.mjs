import assert from 'node:assert/strict';

// Invoked only after smoke-preview validates a preview/local origin and credential.
export async function smokeChanges(origin, request, headers) {
  const send = async (path, input) => {
    const response = await request(origin + path, { headers: { ...headers, ...(input ? { 'Content-Type': 'application/json' } : {}) },
      ...(input ? { method: 'POST', body: JSON.stringify(input) } : {}) });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('X-API-Version'), '3'); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const result = await response.json(); assert.equal(result.ok, true); assert.equal(result.request_id, response.headers.get('X-Request-ID')); return result;
  };
  const collect = async since => {
    let page = await send(since ? `/api/changes?since=${encodeURIComponent(since)}` : '/api/changes');
    const asOf = page.as_of; const changes = [...page.changes];
    assert(page.changes.length <= 20);
    while (page.next_cursor) { assert.equal(page.sync_cursor, null); page = await send(`/api/changes?cursor=${encodeURIComponent(page.next_cursor)}`); assert.equal(page.as_of, asOf); assert(page.changes.length <= 20); changes.push(...page.changes); }
    assert(page.sync_cursor); assert.equal(new Set(changes.map(change => JSON.stringify([change.resource, change.identity]))).size, changes.length);
    return { ...page, changes };
  };
  const initial = await collect();
  for (const change of initial.changes) { assert.equal(change.operation, 'upsert'); assert.match(change.revision, /^[a-f0-9]{64}$/); assert(change.data); assert(!('publisher_fingerprint' in change.data)); assert(!('source_key' in change.data)); }
  const run = `Reconciliation smoke ${crypto.randomUUID()}`; const posted_at = new Date().toISOString();
  const item = { group: 'Preview verification', group_url: origin + '/', headline: run, body: 'Preview reconciliation fixture.', post_url: origin + '/?sync-smoke=' + encodeURIComponent(run), category: 'announcement', posted_at };
  let published;
  try {
    published = await send('/api/digests', { title: run, source: 'deployment-smoke-test', client_ref: run, items: [item] });
    const dateParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const date = ['year', 'month', 'day'].map(part => dateParts.find(value => value.type === part).value).join('-');
    const calendar = await send('/api/events', { title: run, source: 'deployment-smoke-test', items: [{ ...item, post_url: item.post_url + '&event=1', category: 'event', all_day: true, starts_at: date }] });
    const delta = await collect(initial.sync_cursor);
    const found = delta.changes.find(change => change.resource === 'story' && change.identity.post_id === published.post.id && change.identity.item_index === 0);
    assert.equal(found?.operation, 'upsert'); assert.equal(found.data.headline, run);
    assert(delta.changes.some(change => change.resource === 'event' && change.identity.post_id === calendar.post.id && change.data.starts_at === date));
    const update = { group: item.group, post_url: item.post_url + '&update=1', body: 'Reconciliation update.', posted_at: new Date().toISOString() };
    await send(`/api/posts/${published.post.id}/items/0/updates`, update);
    const changed = await collect(delta.sync_cursor);
    const updated = changed.changes.find(change => change.resource === 'story' && change.identity.post_id === published.post.id);
    assert(updated.data.updates.some(value => value.body === update.body));
    await send(`/api/posts/${published.post.id}/items/0/updates`, update);
    const duplicate = await collect(changed.sync_cursor);
    assert(!duplicate.changes.some(change => change.resource === 'story' && change.identity.post_id === published.post.id));
    await send(`/api/posts/${published.post.id}/retract`, {});
    const removed = await collect(duplicate.sync_cursor);
    assert(removed.changes.some(change => change.resource === 'story' && change.identity.post_id === published.post.id && change.operation === 'remove'));
  } finally { if (published?.post) await send(`/api/posts/${published.post.id}/retract`, {}); }
}
