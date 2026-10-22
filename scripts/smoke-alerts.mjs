import assert from 'node:assert/strict';

// The caller validates the preview/local origin and loads its credential.
export async function smokeAlerts(origin, request, headers) {
  const send = async (path, input) => {
    const response = await request(origin + path, { headers: { ...headers, 'Content-Type': 'application/json' },
      ...(input ? { method: 'POST', body: JSON.stringify(input) } : {}) });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('X-API-Version'), '3');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.request_id, response.headers.get('X-Request-ID'));
    return result;
  };
  const capability = await send('/api/alerts?days=30');
  assert(Array.isArray(capability.alerts));
  const run = `Alert smoke ${crypto.randomUUID()}`;
  const observed_at = new Date().toISOString();
  const traffic = { client_ref: `${run}:traffic`, phase: 'open', category: 'traffic', kind: 'construction', routes: ['SR-18', 'SR-189'],
    headline: `${run} traffic`, detail: 'Preview-only construction fixture.', source: 'caltrans', source_url: 'https://roads.dot.ca.gov/?roadnumber=18', observed_at };
  const power = { client_ref: `${run}:power`, phase: 'open', category: 'power', kind: 'psps', area: 'Preview verification area',
    headline: `${run} power`, power: { stage: 'watch', customer_count: 123 }, source_event_id: run,
    source: 'sce', source_url: 'https://www.sce.com/outages-safety/outage-center/check-outage-status', observed_at };
  const openings = [];
  try {
    const before = await request(origin, { method: 'HEAD' });
    const preview = await send('/api/alerts?dry_run=true', traffic);
    assert.equal(preview.dry_run, true); assert.equal(preview.committed, false);
    assert.equal(preview.expires_at, new Date(Date.parse(observed_at) + 86400000).toISOString());
    const absent = await request(`${origin}/api/alerts?client_ref=${encodeURIComponent(traffic.client_ref)}`, { headers });
    assert.equal(absent.status, 404);
    openings.push(traffic.client_ref);
    const published = await send('/api/alerts', traffic);
    const duplicate = await send('/api/alerts', traffic);
    assert.equal(duplicate.status, 'duplicate'); assert.equal(duplicate.entry_id, published.entry_id);
    const conflict = await request(origin + '/api/alerts', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...traffic, headline: 'Changed reference payload' }) });
    assert.equal(conflict.status, 409); assert.equal((await conflict.json()).code, 'client_ref_conflict');
    const lookup = await send(`/api/alerts?client_ref=${encodeURIComponent(traffic.client_ref)}`);
    assert.equal(lookup.entry_id, published.entry_id); assert.equal(lookup.expires_at, published.expires_at);
    const compact = await send(`/api/alerts/${published.alert_id}?fields=index`);
    assert.equal(compact.fields, 'index'); assert.equal(compact.alert.alert_id, published.alert_id);
    assert(!('history' in compact.alert)); assert(!('detail' in compact.alert));
    assert.equal((await send('/api/alerts?fields=index')).fields, 'index');
    openings.push(power.client_ref);
    const outage = await send('/api/alerts', power);
    const checks = { confirmations: [{ client_ref: `${run}:batch-confirm`, alert_id: outage.alert_id, source: power.source, source_url: power.source_url, observed_at: new Date().toISOString() }] };
    const checkPreview = await send('/api/alerts/confirmations?dry_run=true', checks);
    assert.equal(checkPreview.counts.confirmed, 1); assert.equal(checkPreview.committed, false);
    const checkResponse = await request(origin + '/api/alerts/confirmations', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(checks) });
    const checked = await checkResponse.json();
    if (checkResponse.status === 503) assert.equal(checked.code, 'confirmations_not_enabled');
    else {
      assert.equal(checkResponse.status, 200); assert.equal(checked.counts.confirmed, 1);
      assert.equal((await send('/api/alerts/confirmations', checks)).counts.duplicates, 1);
      const coalesced = await send(`/api/alerts/${outage.alert_id}?history=coalesced`);
      assert.equal(coalesced.history, 'coalesced'); assert.equal(coalesced.alert.history[1].confirmation_run.count, 1);
    }

    const page = await request(origin, { headers: { 'If-None-Match': before.headers.get('etag') } });
    assert.equal(page.status, 200);
    const tag = page.headers.get('etag'); const html = await page.text();
    assert(html.includes(traffic.headline)); assert(html.includes(power.headline));
    assert(html.includes('id="traffic-alerts">Traffic')); assert(html.includes('id="power-alerts">Power'));
    assert(!html.includes('class="resource-nav"')); assert(!html.includes('class="alert-status"'));
    assert(html.includes('Customers potentially affected'));
    assert.equal((await request(origin, { method: 'HEAD' })).status, 200);
    assert([200, 304].includes((await request(origin, { headers: { 'If-None-Match': tag } })).status));
    const confirmation = await send('/api/alerts', { client_ref: `${run}:confirm`, phase: 'update', alert_id: published.alert_id,
      source: traffic.source, source_url: traffic.source_url, observed_at: new Date().toISOString() });
    assert.equal(confirmation.alert_id, published.alert_id); assert(confirmation.expires_at);
    assert.equal(confirmation.alert.history.length, 2);
    const common = { alert_id: outage.alert_id, source: power.source, source_url: power.source_url };
    const active = await send('/api/alerts', { ...common, client_ref: `${run}:power-off`, phase: 'update', observed_at: new Date().toISOString(), power: { stage: 'in-effect' } });
    assert.equal(active.alert.power.stage, 'in-effect'); assert.equal(active.alert.power.customer_count, 123);
    const resolving = { ...common, client_ref: `${run}:restored`, phase: 'resolved', observed_at: new Date().toISOString(), detail: 'Preview restoration confirmed.' };
    const dryResolution = await send('/api/alerts?dry_run=true', resolving);
    assert.equal(dryResolution.expires_at, null); assert.equal(dryResolution.committed, false);
    const resolved = await send('/api/alerts', resolving); assert.equal(resolved.expires_at, null);
    assert(!(await (await request(origin)).text()).includes(power.headline));
    const retractPath = `/api/alerts/${resolved.alert_id}/entries/${resolved.entry_id}/retract`;
    const retractPreview = await send(retractPath + '?dry_run=true', {});
    assert.equal(retractPreview.state, 'open'); assert.equal(retractPreview.committed, false);
    const undone = await send(retractPath, {});
    assert.equal(undone.state, 'open'); assert(undone.expires_at);
    let cursor;
    let found = false;
    do {
      const result = await send(cursor ? `/api/alerts?cursor=${encodeURIComponent(cursor)}` : '/api/alerts?days=30');
      found ||= result.alerts.some(alert => alert.alert_id === published.alert_id && alert.history.length === 2 && alert.expires_at);
      cursor = result.next_cursor;
    } while (cursor);
    assert(found, 'Paginated history must include the published alert and its confirmation.');
  } finally {
    // Remove the labeled public fixtures even if a later smoke assertion fails.
    const results = await Promise.allSettled(openings.map(async reference => {
      const response = await request(`${origin}/api/alerts?client_ref=${encodeURIComponent(reference)}`, { headers });
      if (response.status === 404) return;
      assert.equal(response.status, 200); const opened = await response.json();
      assert.equal(opened.ok, true); assert(opened.alert_id && opened.entry_id);
      const path = `/api/alerts/${opened.alert_id}/entries/${opened.entry_id}/retract`;
      assert.equal((await send(path, {})).status, 'retracted');
      const again = await send(path, {}); assert.equal(again.status, 'already_retracted'); assert.equal(again.expires_at, null);
      const lookup = await send(`/api/alerts?client_ref=${encodeURIComponent(opened.client_ref)}`);
      assert.equal(lookup.state, 'retracted');
    }));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
}
