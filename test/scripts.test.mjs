import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { unstable_getVarsForDev } from 'wrangler';
import { migrateProductionCredential, readCredential, readPublishingCredential, saveCredential, updateSecret, validateCredential } from '../scripts/credentials.mjs';
import { deploy } from '../scripts/deploy.mjs';
import { maintenance, maintenanceTarget } from '../scripts/maintenance.mjs';
import { provisionSecret } from '../scripts/provision-secret.mjs';
import { parseSmokeArgs, smoke } from '../scripts/smoke-preview.mjs';

const secret = 'a'.repeat(64);
const id = '00000000-0000-0000-0000-000000000001';
const credentialError = 'Publishing credential must contain at least 32 printable ASCII characters without spaces or control characters';
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
test('build credentials select only the requested environment without local secret files', t => {
  const root = directory(t);
  const preview = 'b'.repeat(64);
  const variables = { PRODUCTION_API_SECRET: secret, PREVIEW_API_SECRET: preview };
  assert.equal(readPublishingCredential('production', variables, root), secret);
  assert.equal(readPublishingCredential('preview', variables, root), preview);
  assert.deepEqual(readdirSync(root), []);
  assert.throws(() => readPublishingCredential('preview', { PRODUCTION_API_SECRET: secret, API_SECRET: secret }, root), /Missing/);
  assert.throws(() => readPublishingCredential('production', { PREVIEW_API_SECRET: preview, API_SECRET: preview }, root), /Missing/);
});
test('publishing credentials prefer build secrets and otherwise use the environment file', t => {
  const root = directory(t);
  const local = 'b'.repeat(64);
  for (const environment of ['production', 'preview']) {
    saveCredential(environment, local, root);
    const name = `${environment.toUpperCase()}_API_SECRET`;
    assert.equal(readPublishingCredential(environment, {}, root), local);
    assert.equal(readPublishingCredential(environment, { [name]: secret }, root), secret);
    for (const value of ['', 'too-short']) {
      assert.throws(() => readPublishingCredential(environment, { [name]: value }, root), { message: credentialError });
    }
  }
  assert.throws(() => readPublishingCredential('invalid', { INVALID_API_SECRET: secret }, root), /Choose preview or production/);
});
test('credential validation preserves supported nonhex tokens and rejects unsafe header values without echoing them', t => {
  const root = directory(t);
  for (const value of [secret, 'valid-punctuation_+./=~!'.repeat(2), '!~'.repeat(16), Array.from({ length: 94 }, (_, i) => String.fromCharCode(i + 33)).join('')]) {
    assert.equal(validateCredential(value), value);
  }
  for (const value of [undefined, '', 'short', 'é'.repeat(32), ...[' ', '\t', '\n', '\r', '\r\n', '\0', '\x01', '\x7f', '\x85', 'é', '\u0100', '漢', '😀'].flatMap(char => [`${secret}${char}suffix`, `${secret}${char}`])]) {
    assert.throws(() => validateCredential(value), { message: credentialError });
    for (const environment of ['preview', 'production']) {
      const name = `${environment.toUpperCase()}_API_SECRET`;
      assert.throws(() => readPublishingCredential(environment, { [name]: value }, root), { message: credentialError });
    }
  }
  // Quoting keeps whitespace intact through dotenv parsing, including newlines.
  for (const value of [`${secret}\nextra`, `${secret}\n`, `${secret} extra`, `${secret}\x7f`, `${secret}\u0100`, 'é'.repeat(32), `${secret}漢`, `${secret}😀`]) {
    writeFileSync(join(root, '.dev.vars.preview'), `API_SECRET="${value}"\n`);
    assert.throws(() => readCredential('preview', root), { message: credentialError });
    const legacy = `API_SECRET="${value}"\nOTHER=keep\n`;
    writeFileSync(join(root, '.dev.vars'), legacy);
    assert.throws(() => migrateProductionCredential(root), { message: credentialError });
    assert.equal(readFileSync(join(root, '.dev.vars'), 'utf8'), legacy);
    assert.equal(readdirSync(root).includes('.secrets'), false);
  }
});
test('unsafe explicit credentials fail before deployment, maintenance, or smoke requests', async () => {
  for (const value of [`${secret}\nextra`, `${secret}\n`, `${secret}\0extra`, `${secret} extra`, `${secret}\u0100`, 'é'.repeat(32), `${secret}漢`, `${secret}😀`]) {
    const calls = [];
    const options = { secret: value, origin: 'https://lakearrowheadtown-preview.harold-martin.workers.dev', run: () => { calls.push('deploy'); return { status: 0 }; }, request: () => { calls.push('request'); } };
    await assert.rejects(deploy('preview', options), { message: credentialError });
    await assert.rejects(maintenance('start', 'preview', undefined, options), { message: credentialError });
    await assert.rejects(smoke([], { credential: () => value, request: options.request }), { message: credentialError });
    assert.deepEqual(calls, []);
  }
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
  assert.equal(updateSecret('OTHER=yes\nexport API_SECRET=old\nAPI_SECRET=duplicate\n', secret), `OTHER=yes\nAPI_SECRET='${secret}'\n`);
  assert.throws(() => updateSecret('OTHER="one\nAPI_SECRET=embedded\nlast"\nAPI_SECRET=old\n', secret), /unrelated values/);
});
test('credential files and migration round-trip literal punctuation without changing values', t => {
  const cases = [
    `${secret}#suffix`, `"${secret}"`, `"${secret}#tail`, '`' + secret + '#tail',
    secret + '#\\n\\r\\path\\', secret + ';:>INJECTED', secret + '$(touch${IFS}INJECTED)',
    secret + '`touch${IFS}INJECTED`', '~+/' + secret,
  ];
  for (const value of cases) {
    const root = directory(t);
    for (const environment of ['preview', 'production']) {
      const file = saveCredential(environment, value, root);
      assert.equal(readCredential(environment, root), value);
      assert.equal(readFileSync(file, 'utf8'), `API_SECRET='${value}'\n`);
      assert.equal(statSync(file).mode & 0o777, 0o600);
    }
    const legacy = `OTHER=keep\nAPI_SECRET='${value}'\n`;
    writeFileSync(join(root, '.dev.vars'), legacy);
    migrateProductionCredential(root);
    assert.equal(readCredential('production', root), value);
    assert.equal(readFileSync(join(root, '.dev.vars'), 'utf8'), 'OTHER=keep\n');
  }
});
test('apostrophes fail before file writes but remain valid for readers, environment and request overrides', async t => {
  const message = 'Credentials containing apostrophes cannot be saved to dotenv; use an environment variable instead';
  for (const value of ["'" + secret, secret + "'middle", secret + "#'`\\r", secret + "'"]) {
    const root = directory(t);
    for (const environment of ['preview', 'production']) {
      const file = saveCredential(environment, secret, root);
      const original = readFileSync(file, 'utf8');
      const entries = readdirSync(root, { recursive: true });
      assert.throws(() => saveCredential(environment, value, root), { message });
      assert.equal(readFileSync(file, 'utf8'), original);
      assert.deepEqual(readdirSync(root, { recursive: true }), entries);
      assert.equal(readPublishingCredential(environment, { [`${environment.toUpperCase()}_API_SECRET`]: value }, root), value);
      writeFileSync(file, `API_SECRET="${value}"\n`);
      assert.equal(readCredential(environment, root), value);
    }
    const fresh = directory(t);
    assert.throws(() => saveCredential('production', value, fresh), { message });
    assert.deepEqual(readdirSync(fresh), []);
    await maintenance('status', 'preview', id, { secret: value, origin: 'http://localhost:8787', request: async (_url, options) => {
      assert.equal(options.headers.Authorization, `Bearer ${value}`);
      return Response.json({ job: { id, status: 'completed' } });
    } });
  }
});
test('single-quoted assignments agree with Node and Wrangler for every supported ASCII character', t => {
  const root = directory(t);
  const file = join(root, '.dev.vars.preview');
  const values = ['"' + secret + '#tail', '`' + secret + '#tail', secret + '\\r', secret + '\\n', secret + '\\'];
  for (let code = 33; code <= 126; code++) {
    const character = String.fromCharCode(code);
    if (character !== "'") values.push(character + secret, secret + character + secret, secret + character);
  }
  for (const value of values) {
    writeFileSync(file, updateSecret('', value));
    assert.equal(readCredential('preview', root), value);
    const vars = unstable_getVarsForDev(join(root, 'wrangler.jsonc'), undefined, {}, 'preview', true);
    assert.equal(vars.API_SECRET.value, value);
  }
});
test('migration rejection retains its private backup and leaves original files intact', t => {
  const root = directory(t);
  const original = `OTHER=keep\nAPI_SECRET="${secret}'"\n`;
  writeFileSync(join(root, '.dev.vars'), original);
  assert.throws(() => migrateProductionCredential(root), /apostrophes cannot be saved/);
  assert.equal(readFileSync(join(root, '.dev.vars'), 'utf8'), original);
  const backups = readdirSync(join(root, '.secrets'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(root, '.secrets', backups[0]), 'utf8'), original);
  assert.equal(statSync(join(root, '.secrets', backups[0])).mode & 0o777, 0o600);
  assert.equal(existsSync(join(root, '.secrets/production.vars')), false);
});
test('documented shell reads treat files as data and gate curl and upload hooks on read success', t => {
  const root = directory(t);
  symlinkSync(fileURLToPath(new URL('../scripts', import.meta.url)), join(root, 'scripts'), 'dir');
  const blocks = [...readFileSync(new URL('../README.md', import.meta.url), 'utf8').matchAll(/```sh\n([\s\S]*?)```/g)].map(match => match[1]);
  const setup = blocks.find(block => block.startsWith('API_SECRET=') && block.includes('export API_SECRET SITE_URL'));
  const upload = blocks.find(block => block.startsWith('API_SECRET=') && block.includes('wrangler secret put'));
  const requests = blocks.filter(block => block.startsWith('[ -n "${API_SECRET:-}" ] && curl'));
  assert(setup && upload);
  assert.equal(requests.length, 2);
  const hooks = 'curl() { printf REQUEST_HOOK; }\nnpx() { cat >/dev/null; printf UPLOAD_HOOK; }\n';
  const value = secret + '$DUMMY;:>INJECTED#`echo`';
  const file = saveCredential('production', value, root);
  const unrelated = 'OTHER=$(touch${IFS}UNRELATED_EXECUTED)\n';
  const run = script => spawnSync('/bin/sh', ['-c', hooks + script], { cwd: root, encoding: 'utf8', env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, DUMMY: 'CHANGED' } });
  writeFileSync(file, unrelated + readFileSync(file, 'utf8'));
  const loaded = run(setup + '\nprintf "<VALUE>%s</VALUE>" "$API_SECRET"\n' + requests.join('\n') + '\n' + upload);
  assert.equal(loaded.status, 0);
  assert.equal(loaded.stderr, '');
  assert(loaded.stdout.includes(`<VALUE>${value}</VALUE>`));
  assert.equal(loaded.stdout.match(/REQUEST_HOOK/g).length, 2);
  assert.equal(loaded.stdout.match(/UPLOAD_HOOK/g).length, 1);
  assert.equal(existsSync(join(root, 'INJECTED')), false);
  assert.equal(existsSync(join(root, 'UNRELATED_EXECUTED')), false);
  writeFileSync(file, unrelated + 'API_SECRET=short\n');
  const rejected = run(setup + '\n' + requests.join('\n') + '\n' + upload);
  assert.equal(rejected.stdout, '');
  assert(rejected.stderr.includes(credentialError));
  assert.equal(existsSync(join(root, 'UNRELATED_EXECUTED')), false);
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

test('maintenance preserves HTTP status for non-JSON failures without retrying', async () => {
  for (const [status, body] of [[403, '<html>Forbidden</html>'], [524, 'Gateway timeout'], [500, ''], [503, '{broken']]) {
    let calls = 0;
    await assert.rejects(maintenance('start', 'preview', undefined, { secret, origin: 'http://localhost:8787', request: async () => {
      calls++; return new Response(body, { status });
    } }), error => {
      assert.match(error.message, new RegExp(`Maintenance request failed \\(${status}\\): non-JSON response`));
      assert.doesNotMatch(error.message, /Forbidden|Gateway timeout|SyntaxError/);
      return true;
    });
    assert.equal(calls, 1);
  }
  await assert.rejects(maintenance('start', 'preview', undefined, { secret, origin: 'http://localhost:8787', request: async () => Response.json(null, { status: 502 }) }), /failed \(502\): Unknown error/);
});
test('maintenance reports malformed successful responses with their HTTP status', async () => {
  for (const body of ['', 'not JSON', 'null', '{}', JSON.stringify({ job: { id, status: 'unknown' } }), JSON.stringify({ job: { id: 3, status: 'queued' } })]) {
    await assert.rejects(maintenance('start', 'preview', undefined, { secret, origin: 'http://localhost:8787', request: async () => new Response(body, { status: 200 }) }), /Invalid maintenance response \(200\)/);
  }
});
test('smoke arguments support a default URL, flag alone, and either argument order', () => {
  const remote = 'https://lakearrowheadtown-preview.harold-martin.workers.dev';
  assert.deepEqual(parseSmokeArgs([]), { origin: remote, edge: false });
  assert.deepEqual(parseSmokeArgs(['--verify-edge']), { origin: remote, edge: true });
  for (const args of [[remote, '--verify-edge'], ['--verify-edge', remote]]) assert.deepEqual(parseSmokeArgs(args), { origin: remote, edge: true });
  assert.deepEqual(parseSmokeArgs(['http://localhost:8787']), { origin: 'http://localhost:8787', edge: false });
});
test('bad smoke arguments fail before reading credentials or making requests', async () => {
  for (const args of [['--unknown'], ['http://localhost:8787', 'http://localhost:8788'], ['https://evil.example'], ['--verify-edge=false']]) {
    const calls = [];
    await assert.rejects(smoke(args, { credential: () => { calls.push('credential'); return secret; }, request: () => { calls.push('request'); } }));
    assert.deepEqual(calls, []);
  }
});
for (const status of [0, 1]) test(`production provisioning warns and continues with a legacy credential (upload status ${status})`, t => {
  const root = directory(t);
  const original = `# Local settings\nOTHER=keep\nAPI_SECRET=${secret}\n`;
  writeFileSync(join(root, '.dev.vars'), original);
  const file = saveCredential('production', secret, root);
  writeFileSync(file, `PRODUCTION_SETTING=keep\nAPI_SECRET=${secret}\n`);
  const replacement = Buffer.alloc(32, 0xbb);
  const events = [];
  const warnings = [];
  const options = {
    root,
    warn: value => { warnings.push(value); events.push('warning'); },
    randomBytes: size => { assert.equal(size, 32); events.push('generate'); return replacement; },
    run: (command, args, init) => {
      events.push('upload'); assert.equal(command, 'npx');
      assert.deepEqual(args, ['wrangler', 'secret', 'put', 'API_SECRET', '--env', '']);
      assert.equal(init.cwd, root); assert.equal(init.input, replacement.toString('hex'));
      assert.equal(readCredential('production', root), init.input);
      return { status };
    },
  };
  if (status) assert.throws(() => provisionSecret('production', options), error => { assert.equal(error.exitCode, status); assert.match(error.message, /retry with this value/); return true; });
  else assert.equal(provisionSecret('production', options), file);
  assert.deepEqual(events, ['warning', 'generate', 'upload']);
  assert.equal(warnings.length, 1); assert.match(warnings[0], /API_SECRET remains in \.dev\.vars/);
  assert(!warnings[0].includes(secret)); assert(!warnings[0].includes(replacement.toString('hex')));
  assert.equal(readFileSync(join(root, '.dev.vars'), 'utf8'), original);
  assert.match(readFileSync(file, 'utf8'), /PRODUCTION_SETTING=keep/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});
test('provisioning does not warn for preview or unrelated local variables', t => {
  const root = directory(t);
  const warnings = [];
  const options = { root, warn: value => warnings.push(value), randomBytes: () => Buffer.alloc(32), run: () => ({ status: 0 }) };
  writeFileSync(join(root, '.dev.vars'), `API_SECRET=${secret}\n`);
  provisionSecret('preview', options);
  writeFileSync(join(root, '.dev.vars'), 'OTHER=keep\n');
  provisionSecret('production', options);
  assert.deepEqual(warnings, []);
});
