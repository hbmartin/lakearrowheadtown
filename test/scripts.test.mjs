import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { migrateProductionCredential, readCredential, saveCredential, updateSecret } from '../scripts/credentials.mjs';
import { deploy } from '../scripts/deploy.mjs';
import { maintenance, maintenanceTarget } from '../scripts/maintenance.mjs';

const secret = 'a'.repeat(64);
const id = '00000000-0000-0000-0000-000000000001';
function directory(t) { const root = mkdtempSync(join(tmpdir(), 'lakearrowhead-test-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }

test('rotation preserves unrelated dotenv fields and backs up the complete original', t => {
  const root = directory(t);
  const original = '# Settings\nOTHER="a value"\nAPI_SECRET=old-secret\nMULTILINE="first\nsecond"\n';
  writeFileSync(join(root, '.dev.vars.preview'), original);
  const file = saveCredential('preview', secret, root);
  assert.equal(readCredential('preview', root), secret);
  assert.match(readFileSync(file, 'utf8'), /OTHER="a value"/);
  assert.match(readFileSync(file, 'utf8'), /MULTILINE="first\nsecond"/);
  assert.equal(readFileSync(join(root, '.secrets', readdirSync(join(root, '.secrets'))[0]), 'utf8'), original);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, '.secrets')).mode & 0o777, 0o700);
});
test('production credentials live outside Wrangler automatic local files', t => {
  const root = directory(t);
  const file = saveCredential('production', secret, root);
  assert.equal(file, join(root, '.secrets/production.vars'));
  assert.equal(readCredential('production', root), secret);
  assert.equal(readdirSync(root).includes('.dev.vars'), false);
});
test('explicit migration preserves the token and unrelated variables without any remote call', t => {
  const root = directory(t);
  writeFileSync(join(root, '.dev.vars'), `# Keep\nOTHER=local\nAPI_SECRET=${secret}\n`);
  const target = migrateProductionCredential(root);
  assert.equal(readCredential('production', root), secret);
  assert.equal(readFileSync(join(root, '.dev.vars'), 'utf8'), '# Keep\nOTHER=local\n');
  assert.equal(statSync(target).mode & 0o777, 0o600);
});
test('migration refuses conflicting credentials without altering either file', t => {
  const root = directory(t);
  writeFileSync(join(root, '.dev.vars'), `API_SECRET=${secret}\n`);
  mkdirSync(join(root, '.secrets')); writeFileSync(join(root, '.secrets/production.vars'), `API_SECRET=${'b'.repeat(64)}\n`);
  assert.throws(() => migrateProductionCredential(root), /different value/);
  assert.equal(readFileSync(join(root, '.dev.vars'), 'utf8'), `API_SECRET=${secret}\n`);
  assert.equal(readCredential('production', root), 'b'.repeat(64));
});
test('dotenv updates handle exports and duplicates and refuse destructive multiline changes', () => {
  assert.equal(updateSecret('OTHER=yes\nexport API_SECRET=old\nAPI_SECRET=duplicate\n', secret), `OTHER=yes\nAPI_SECRET=${secret}\n`);
  assert.throws(() => updateSecret('OTHER="one\nAPI_SECRET=embedded\nlast"\nAPI_SECRET=old\n', secret), /unrelated values/);
});
test('maintenance targets reject credential leaks and allow preview localhost only', () => {
  assert.equal(maintenanceTarget('preview', 'http://localhost:8787'), 'http://localhost:8787');
  for (const target of ['https://evil.example', 'https://lakearrowhead.town/path', 'http://lakearrowhead.town', 'https://lakearrowhead.town:444', 'http://localhost:8787']) assert.throws(() => maintenanceTarget('production', target));
});
test('deployment queues one rebuild only after Wrangler succeeds and does not poll', async () => {
  const calls = [];
  const job = await deploy('preview', { secret, origin: 'https://lakearrowheadtown-preview.harold-martin.workers.dev', run: (...args) => { calls.push(['deploy', args[1]]); return { status: 0 }; }, request: async (url, options) => {
    calls.push(['queue', url]); assert.equal(options.method, 'POST'); assert.equal(options.headers.Authorization, `Bearer ${secret}`);
    return Response.json({ ok: true, job: { id, status: 'queued' } }, { status: 202 });
  } });
  assert.equal(job.id, id); assert.deepEqual(calls.map(call => call[0]), ['deploy', 'queue']);
  assert.deepEqual(calls[0][1], ['wrangler', 'deploy', '--env', 'preview']);
});
test('production deploy explicitly selects the top-level environment', async () => {
  await deploy('production', { secret, origin: 'https://lakearrowhead.town', run: (_command, args) => { assert.deepEqual(args, ['wrangler', 'deploy', '--env', '']); return { status: 0 }; }, request: async () => Response.json({ job: { id, status: 'queued' } }, { status: 202 }) });
});
test('failed deployments never enqueue a rebuild', async () => {
  let requested = false;
  await assert.rejects(deploy('preview', { secret, origin: 'https://lakearrowheadtown-preview.harold-martin.workers.dev', run: () => ({ status: 1 }), request: async () => { requested = true; } }), /deployment failed/);
  assert.equal(requested, false);
});
test('deploy refuses leftover localhost targets before invoking Wrangler', async () => {
  let ran = false;
  await assert.rejects(deploy('preview', { secret, origin: 'http://localhost:8787', run: () => { ran = true; return { status: 0 }; } }), /not localhost/);
  assert.equal(ran, false);
});
test('maintenance status and resume use the proper method and route without retrying failures', async () => {
  for (const operation of ['status', 'resume']) await maintenance(operation, 'preview', id, { secret, origin: 'http://localhost:8787', request: async (url, options) => {
    assert.equal(options.method, operation === 'status' ? 'GET' : 'POST');
    assert.equal(url, `http://localhost:8787/api/rebuild/${id}${operation === 'resume' ? '/resume' : ''}`);
    return Response.json({ job: { id, status: operation === 'status' ? 'failed' : 'queued' } }, { status: operation === 'status' ? 200 : 202 });
  } });
  let calls = 0;
  await assert.rejects(maintenance('start', 'preview', undefined, { secret, origin: 'http://localhost:8787', request: async () => { calls++; return Response.json({ error: 'Unavailable' }, { status: 503 }); } }), /503/);
  assert.equal(calls, 1);
});
