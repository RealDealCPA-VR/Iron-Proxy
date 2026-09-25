import { describe, expect, it } from 'vitest';
import { AdapterRegistry, type Lane } from '../src/adapters/types.js';
import { createIronProxy } from '../src/manager.js';
import { MemoryProfileStore } from '../src/store/profile-store.js';
import { MemoryStateStore } from '../src/store/state-store.js';
import { MemoryVault } from '../src/vault/vault.js';

/** A lane whose status check blocks until the test releases it. */
function gatedLane(): { lane: Lane; release: () => void; started: Promise<void> } {
  let release!: () => void;
  let markStarted!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const started = new Promise<void>((r) => (markStarted = r));
  const lane: Lane = {
    kind: 'api-key',
    complete: async () => {
      throw new Error('unused');
    },
    // eslint-disable-next-line require-yield
    stream: async function* () {
      throw new Error('unused');
    },
    checkAuth: async () => {
      markStarted();
      await gate;
      return 'ok';
    },
  };
  return { lane, release, started };
}

describe('refreshStatus vs a concurrent park', () => {
  it('does not undo a park that lands while the status check is running', async () => {
    const { lane, release, started } = gatedLane();
    const registry = new AdapterRegistry().register({
      id: 'anthropic',
      displayName: 'Anthropic',
      defaultModel: 'm',
      lanes: { 'api-key': lane },
    });
    const iron = createIronProxy({
      profiles: new MemoryProfileStore(),
      states: new MemoryStateStore(),
      vault: new MemoryVault(),
      registry,
    });
    const p = await iron.createProfile({
      title: 'A',
      provider: 'anthropic',
      lane: 'api-key',
      apiKeySecret: 'k',
    });
    const refresh = iron.refreshStatus(p.id);
    await started;
    const until = new Date(Date.now() + 3_600_000).toISOString();
    await iron.router.park(p, { kind: 'quota-exhausted', source: 'status', resetAt: until });
    release();
    await refresh;
    // createProfile also started a background check on the same gate; let it settle.
    await new Promise((r) => setTimeout(r, 20));
    const st = (await iron.allStates())[p.id];
    expect(st?.status).toBe('parked');
    expect(st?.parkedUntil).toBe(until);
    await iron.close();
  });
});

describe('close() and background status checks', () => {
  it('waits for a status check started by createProfile, so nothing is written after close', async () => {
    const { lane, release, started } = gatedLane();
    const registry = new AdapterRegistry().register({
      id: 'anthropic',
      displayName: 'Anthropic',
      defaultModel: 'm',
      lanes: { 'api-key': lane },
    });
    const states = new MemoryStateStore();
    let putsAfterClose = 0;
    let closed = false;
    const origPut = states.put.bind(states);
    states.put = async (st) => {
      if (closed) putsAfterClose++;
      return origPut(st);
    };
    const iron = createIronProxy({
      profiles: new MemoryProfileStore(),
      states,
      vault: new MemoryVault(),
      registry,
    });
    await iron.createProfile({
      title: 'A',
      provider: 'anthropic',
      lane: 'api-key',
      apiKeySecret: 'k',
    });
    await started;
    const closing = iron.close().then(() => (closed = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(false); // still waiting for the check
    release();
    await closing;
    await new Promise((r) => setTimeout(r, 20));
    expect(putsAfterClose).toBe(0);
  });
});
