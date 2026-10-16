import { migrateProductionCredential } from './credentials.mjs';
console.log(`Moved existing credential to ${migrateProductionCredential()}; no remote secret was changed.`);
