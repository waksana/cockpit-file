import assert from 'node:assert/strict';
import test from 'node:test';
import { protectUnpersistedFiles, type UnloadTarget } from './unload.ts';

test('native leave confirmation only reads work and its activation listener is removable', () => {
  const listeners = new Set<(event: BeforeUnloadEvent) => void>();
  const target: UnloadTarget = {
    addEventListener: (_type, listener) => { listeners.add(listener); },
    removeEventListener: (_type, listener) => { listeners.delete(listener); },
  };
  let unfinished = false;
  const dispose = protectUnpersistedFiles(target, { hasUnpersistedWork: () => unfinished });
  const fire = () => {
    const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    Object.defineProperty(event, 'returnValue', { value: 'unchanged', writable: true });
    for (const listener of listeners) listener(event);
    return event;
  };
  assert.equal(listeners.size, 1);
  assert.equal(fire().defaultPrevented, false);
  unfinished = true;
  const event = fire();
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.returnValue, '');
  assert.equal(unfinished, true, 'cancelling navigation does not cancel or discard work');
  assert.equal(fire().defaultPrevented, true);
  unfinished = false;
  assert.equal(fire().defaultPrevented, false);
  dispose();
  dispose();
  assert.equal(listeners.size, 0);
  unfinished = true;
  assert.equal(fire().defaultPrevented, false);
});

test('non-browser activation does not require an unload target', () => {
  protectUnpersistedFiles(undefined, { hasUnpersistedWork: () => false })();
});
