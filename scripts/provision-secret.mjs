import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const environment = process.argv[2];
if (!['preview', 'production'].includes(environment)) {
  console.error('Usage: npm run secret -- preview|production');
  process.exit(1);
}
const file = environment === 'preview' ? '.dev.vars.preview' : '.dev.vars';
const secret = randomBytes(32).toString('hex');
if (existsSync(file)) {
  mkdirSync('.secrets', { recursive: true, mode: 0o700 });
  writeFileSync(`.secrets/${environment}-${Date.now()}.vars`, readFileSync(file), { mode: 0o600 });
}
// Save the credential before upload so it remains recoverable after interruption.
writeFileSync(file, `API_SECRET=${secret}\n`, { mode: 0o600 });
chmodSync(file, 0o600);
const args = ['wrangler', 'secret', 'put', 'API_SECRET', '--env', environment === 'preview' ? 'preview' : ''];
const result = spawnSync('npx', args, { input: secret, stdio: ['pipe', 'inherit', 'inherit'] });
if (result.error) throw result.error;
if (result.status !== 0) {
  console.error(`Upload failed. The generated credential is saved in ${file}; retry wrangler secret put with this same value.`);
  process.exit(result.status ?? 1);
}
console.log(`Stored ${environment} secret. Local credential: ${file} (ignored by Git).`);
