import { expect, it, vi } from 'vitest';
import { dimensions } from '../src/image-metadata';

const state = vi.hoisted(() => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  return { attempts: 0, gate, release };
});
vi.mock('@resvg/resvg-wasm', async importOriginal => {
  const actual = await importOriginal<typeof import('@resvg/resvg-wasm')>();
  return { ...actual, initWasm: async (wasm: Parameters<typeof actual.initWasm>[0]) => {
    state.attempts++;
    if (state.attempts === 1) throw new Error('Injected initialization failure');
    await state.gate;
    return actual.initWasm(wasm);
  } };
});
import { dailyCard } from '../src/social';

it('retries failed initialization, shares concurrent attempts, and renders XML-hostile Unicode as PNG', async () => {
  await expect(dailyCard('2026-10-20', 'First')).rejects.toThrow('Injected initialization failure');
  const cards = ['Head\u0008line\uFFFE & <quoted> 🌲', 'Another\uFFFF 山', 'Plain headline'].map(headline => dailyCard('2026-10-20', headline));
  expect(state.attempts).toBe(2);
  state.release();
  for (const card of await Promise.all(cards)) expect(dimensions(card)).toMatchObject({ width: 1200, height: 630, type: 'image/png' });
  await dailyCard('2026-10-20', 'Already initialized');
  expect(state.attempts).toBe(2);
});
