import fc from 'fast-check';
const extended = process.env.TEST_EXTENDED === '1';
const seed = Number(process.env.TEST_SEED ?? 20261024);
if (!Number.isInteger(seed)) throw new Error('TEST_SEED must be an integer');
console.info(JSON.stringify({ property_seed: seed, extended, replay_path: process.env.TEST_REPLAY_PATH ?? null }));
export function propertyOptions(stateful = false) {
  const path = process.env.TEST_REPLAY_PATH;
  return { seed, numRuns: stateful ? (extended ? 200 : 20) : (extended ? 1000 : 100), verbose: true as const, ...(path ? { path } : {}) };
}
export { fc };
