import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';

export function checkEnvironment(environment) {
  if (!['preview', 'production'].includes(environment)) throw new Error('Choose preview or production explicitly');
  return environment;
}
export function credentialFile(environment, root = process.cwd()) {
  checkEnvironment(environment);
  return join(root, environment === 'preview' ? '.dev.vars.preview' : '.secrets/production.vars');
}
export function readCredential(environment, root = process.cwd()) {
  const file = credentialFile(environment, root);
  if (!existsSync(file)) throw new Error(`Missing ${file}; provision credentials first (or migrate the existing production credential)`);
  const value = parseEnv(readFileSync(file, 'utf8')).API_SECRET;
  if (!value || value.length < 32) throw new Error(`API_SECRET is missing or too short in ${file}`);
  return value;
}
export function updateSecret(text, secret) {
  const before = parseEnv(text);
  const result = text.replace(/^[ \t]*(?:export[ \t]+)?API_SECRET[ \t]*=.*(?:\r?\n|$)/gm, '');
  const updated = secret === null ? result : `${result}${result && !result.endsWith('\n') ? '\n' : ''}API_SECRET=${secret}\n`;
  const after = parseEnv(updated);
  // Refuse unusual multiline secret syntax rather than silently alter other values.
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key !== 'API_SECRET' && before[key] !== after[key]) throw new Error('Cannot safely update this dotenv file; unrelated values would change');
  }
  if ((secret === null && 'API_SECRET' in after) || (secret !== null && after.API_SECRET !== secret)) throw new Error('Cannot safely update this dotenv secret assignment');
  return updated;
}
export function atomicPrivateWrite(file, text) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, file);
  chmodSync(file, 0o600);
}
export function backup(file, environment, root = process.cwd()) {
  if (!existsSync(file)) return;
  const directory = join(root, '.secrets');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  atomicPrivateWrite(join(directory, `${environment}-${randomUUID()}.vars`), readFileSync(file, 'utf8'));
}
export function saveCredential(environment, secret, root = process.cwd()) {
  const file = credentialFile(environment, root);
  if (environment === 'production') {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    chmodSync(dirname(file), 0o700);
  }
  backup(file, environment, root);
  atomicPrivateWrite(file, updateSecret(existsSync(file) ? readFileSync(file, 'utf8') : '', secret));
  return file;
}
export function migrateProductionCredential(root = process.cwd()) {
  const source = join(root, '.dev.vars');
  if (!existsSync(source)) throw new Error('No .dev.vars file to migrate');
  const text = readFileSync(source, 'utf8');
  const secret = parseEnv(text).API_SECRET;
  if (!secret || secret.length < 32) throw new Error('No valid API_SECRET in .dev.vars');
  const target = credentialFile('production', root);
  if (existsSync(target) && readCredential('production', root) !== secret) throw new Error('Production credential file already contains a different value; nothing changed');
  const remainder = updateSecret(text, null);
  backup(source, 'production-before-migration', root);
  saveCredential('production', secret, root);
  atomicPrivateWrite(source, remainder);
  return target;
}
