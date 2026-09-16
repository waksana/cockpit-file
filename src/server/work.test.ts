import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorkLimit } from './work.ts';

test('file work is bounded and cancellation does not run a queued operation', async () => {
  const scope = new AbortController();
  const request = new AbortController();
  const work = createWorkLimit(1, 1, scope.signal);
  let release: () => void = () => {};
  const first = work.run(() => new Promise<void>(resolve => { release = resolve; }));
  await Promise.resolve();
  const second = work.run(async () => { assert.fail('Cancelled work must not run'); }, request.signal);
  await assert.rejects(work.run(async () => undefined), /queue is full/);
  request.abort();
  await assert.rejects(second, /cancelled/);
  release();
  await first;
  work.dispose();
  await assert.rejects(work.run(async () => undefined), /closing/);
});
