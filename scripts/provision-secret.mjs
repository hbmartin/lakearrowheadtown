import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { checkEnvironment, saveCredential } from './credentials.mjs';

const environment = checkEnvironment(process.argv[2]);
const secret = randomBytes(32).toString('hex');
// Save before upload; backups preserve the previous credential if upload fails.
const file = saveCredential(environment, secret);
const result = spawnSync('npx', ['wrangler', 'secret', 'put', 'API_SECRET', '--env', environment === 'preview' ? 'preview' : ''], { input: secret, stdio: ['pipe', 'inherit', 'inherit'] });
if (result.error) throw result.error;
if (result.status !== 0) {
  console.error(`Upload failed. The generated credential is saved in ${file}; retry with this value instead of rotating again.`);
  process.exit(result.status ?? 1);
}
console.log(`Stored ${environment} credential in ${file} (ignored by Git).`);
