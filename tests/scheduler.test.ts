import { afterEach, expect, it, vi } from 'vitest';
import { SerialQueue, WorkerPump } from '../src/background/scheduler';

afterEach(() => vi.useRealTimers());
it('serializes mutations, isolates errors and does not pass previous results to work', async () => {
  const queue = new SerialQueue(), order: string[] = [];
  const first = queue.run(async () => { order.push('first'); return 42; });
  const failed = queue.run(async () => { order.push('failed'); throw new Error('Expected'); });
  const work = vi.fn(async () => { order.push('last'); return 7; });
  const last = queue.run(work);
  await expect(first).resolves.toBe(42); await expect(failed).rejects.toThrow('Expected'); await expect(last).resolves.toBe(7);
  expect(order).toEqual(['first', 'failed', 'last']); expect(work).toHaveBeenCalledWith();
});
it('stops rapid polling when idle and wakes again for new work', async () => {
  vi.useFakeTimers(); const tick = vi.fn<() => Promise<number | undefined>>().mockResolvedValue(undefined);
  const pump = new WorkerPump(tick); pump.wake(); await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(60_000); expect(tick).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  tick.mockResolvedValueOnce(750); pump.wake(); await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(750); expect(tick).toHaveBeenCalledTimes(3); expect(vi.getTimerCount()).toBe(0);
});
it('coalesces wakeups, interrupts a long delay and never runs overlapping ticks', async () => {
  vi.useFakeTimers(); let complete!: (delay: number | undefined) => void;
  const tick = vi.fn<() => Promise<number | undefined>>().mockImplementationOnce(() => new Promise(resolve => { complete = resolve; })).mockResolvedValue(undefined);
  const pump = new WorkerPump(tick); pump.wake(10_000); pump.wake(100); pump.wake(200);
  await vi.advanceTimersByTimeAsync(100); expect(tick).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 10; i++) pump.wake();
  await vi.advanceTimersByTimeAsync(1000); expect(tick).toHaveBeenCalledTimes(1);
  complete(undefined); await vi.advanceTimersByTimeAsync(0);
  expect(tick).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
});
it('retries a worker error without a tight failure loop', async () => {
  vi.useFakeTimers(); const tick = vi.fn<() => Promise<number | undefined>>().mockRejectedValueOnce(new Error('Failure')).mockResolvedValue(undefined);
  const pump = new WorkerPump(tick); pump.wake(); await vi.advanceTimersByTimeAsync(4999);
  expect(tick).toHaveBeenCalledTimes(1); await vi.advanceTimersByTimeAsync(1); expect(tick).toHaveBeenCalledTimes(2);
});
