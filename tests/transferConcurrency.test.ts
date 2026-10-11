import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { transferCeiling, transferFailed, transferLimit, transferSucceeded, type DeviceHints, type TransferPolicy } from '../src/core/transferConcurrency';

const capable = { hardwareConcurrency: 16, deviceMemory: 8 };
beforeEach(() => { vi.stubGlobal('navigator', capable); vi.spyOn(Date, 'now').mockReturnValue(100_000); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('device limits', () => {
  it.each<[DeviceHints, number]>([
    [{}, 2],
    [{ hardwareConcurrency: 64 }, 2],
    [{ deviceMemory: 8 }, 2],
    [{ hardwareConcurrency: NaN, deviceMemory: Infinity }, 2],
    [{ hardwareConcurrency: 2, deviceMemory: 8 }, 1],
    [{ hardwareConcurrency: 8, deviceMemory: 2 }, 2],
    [{ hardwareConcurrency: 8, deviceMemory: 4 }, 4],
    [{ ...capable, deviceMemory: 0.5 }, 1],
    [{ ...capable, connection: { saveData: true } }, 1],
    [{ ...capable, connection: { effectiveType: '2g' } }, 1],
    [{ ...capable, connection: { effectiveType: '3g' } }, 2],
    [capable, 8],
  ])('bounds post concurrency for %j at %i', (hints, expected) => {
    expect(transferCeiling('posts', hints)).toBe(expected);
  });
  it('uses a lower ceiling for buffered Discord images', () => {
    expect(transferCeiling('discord', capable)).toBe(4);
  });
  it('works without navigator', () => {
    vi.stubGlobal('navigator', undefined);
    expect(transferCeiling('posts')).toBe(2);
  });
});

it('starts cautiously and grows only after successful network transfers, up to the ceiling', () => {
  const owner: { transferPolicy?: TransferPolicy } = {};
  expect(transferLimit(owner, 'posts')).toBe(2);
  for (let i = 0; i < 3; i++) transferSucceeded(owner, 'posts');
  expect(transferLimit(owner, 'posts')).toBe(2);
  transferSucceeded(owner, 'posts');
  expect(transferLimit(owner, 'posts')).toBe(3);
  for (let i = 0; i < 200; i++) transferSucceeded(owner, 'posts');
  expect(transferLimit(owner, 'posts')).toBe(8);
});

it('halves the limit on 429 and retains the cooldown across serialization and in-flight successes', () => {
  let owner = { transferPolicy: { limit: 8, successes: 15, failures: 0, increaseAfter: 0 } };
  transferFailed(owner, 'posts', 429, 120_000);
  owner = structuredClone(owner);
  for (let i = 0; i < 20; i++) transferSucceeded(owner, 'posts');
  expect(owner.transferPolicy).toMatchObject({ limit: 4, successes: 0, increaseAfter: 220_000 });
  vi.mocked(Date.now).mockReturnValue(220_000);
  for (let i = 0; i < 8; i++) transferSucceeded(owner, 'posts');
  expect(transferLimit(owner, 'posts')).toBe(5);
});

it('reduces after repeated transient failures, excludes missing files, and never drops below one', () => {
  const owner = { transferPolicy: { limit: 6, successes: 0, failures: 0, increaseAfter: 0 } };
  transferFailed(owner, 'posts', 404); transferFailed(owner, 'posts', 410); transferFailed(owner, 'posts', 403);
  expect(owner.transferPolicy.failures).toBe(0);
  transferFailed(owner, 'posts', 500);
  expect(owner.transferPolicy.limit).toBe(6);
  transferFailed(owner, 'posts', 0);
  expect(owner.transferPolicy).toMatchObject({ limit: 3, increaseAfter: 130_000 });
  for (let i = 0; i < 5; i++) transferFailed(owner, 'posts', 429);
  expect(owner.transferPolicy.limit).toBe(1);
});

it('clamps a restored policy when device or connection capacity drops and ramps back gradually', () => {
  const owner = { transferPolicy: { limit: 8, successes: 10, failures: 0, increaseAfter: 0 } };
  vi.stubGlobal('navigator', { ...capable, connection: { saveData: true } });
  expect(transferLimit(owner, 'posts')).toBe(1);
  expect(owner.transferPolicy.successes).toBe(0);
  vi.stubGlobal('navigator', capable);
  expect(transferLimit(owner, 'posts')).toBe(1);
  transferSucceeded(owner, 'posts'); transferSucceeded(owner, 'posts');
  expect(transferLimit(owner, 'posts')).toBe(2);
});
