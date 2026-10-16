import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { checkEnvironment, saveCredential } from './credentials.mjs';

export function provisionSecret(environment, options = {}) {
  checkEnvironment(environment);
  const root = options.root ?? process.cwd();
  const legacy = join(root, '.dev.vars');
  if (environment === 'production' && existsSync(legacy) && Object.hasOwn(parseEnv(readFileSync(legacy, 'utf8')), 'API_SECRET')) {
    (options.warn ?? console.warn)('Warning: API_SECRET remains in .dev.vars, which Wrangler can load locally. Provisioning continues without changing that file. After a successful rotation, back it up and remove only the obsolete API_SECRET assignment. If upload fails, the old token may still be live. Use secret:migrate-production before rotation to move a matching credential without rotating it.');
  }
  const secret = (options.randomBytes ?? randomBytes)(32).toString('hex');
  // Save before upload; backups preserve the previous credential if upload fails.
  const file = saveCredential(environment, secret, root);
  const result = (options.run ?? spawnSync)('npx', ['wrangler', 'secret', 'put', 'API_SECRET', '--env', environment === 'preview' ? 'preview' : ''], { cwd: root, input: secret, stdio: ['pipe', 'inherit', 'inherit'] });
  if (result.error || result.status !== 0) {
    const error = new Error(`Upload failed. The generated credential is saved in ${file}; retry with this value instead of rotating again.`);
    error.exitCode = result.status || 1;
    throw error;
  }
  return file;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const environment = process.argv[2];
    const file = provisionSecret(environment);
    console.log(`Stored ${environment} credential in ${file} (ignored by Git).`);
  } catch (error) { console.error(error.message); process.exitCode = error.exitCode ?? 1; }
}
