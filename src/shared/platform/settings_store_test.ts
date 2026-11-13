import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {DEFAULTS} from '../settings';
import {
  SETTINGS_KEY,
  getSettings,
  onSettingsChange,
  updateSettings,
} from './settings_store';

type ChangeListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  area: string,
) => void;

/** In-memory chrome.storage.local with onChanged, enough for the store. */
function fakeStorage() {
  const data: Record<string, unknown> = {};
  const listeners = new Set<ChangeListener>();
  const fire = (changes: Record<string, chrome.storage.StorageChange>) => {
    for (const l of listeners) l(changes, 'local');
  };
  return {
    data,
    listeners,
    fire,
    chrome: {
      storage: {
        local: {
          get: vi.fn(async (key: string) =>
            key in data ? {[key]: structuredClone(data[key])} : {},
          ),
          set: vi.fn(async (items: Record<string, unknown>) => {
            const changes: Record<string, chrome.storage.StorageChange> = {};
            for (const [k, v] of Object.entries(items)) {
              changes[k] = {oldValue: data[k], newValue: v};
              data[k] = structuredClone(v);
            }
            fire(changes);
          }),
        },
        onChanged: {
          addListener: (l: ChangeListener) => listeners.add(l),
          removeListener: (l: ChangeListener) => listeners.delete(l),
        },
      },
    },
  };
}

let fake: ReturnType<typeof fakeStorage>;

beforeEach(() => {
  fake = fakeStorage();
  vi.stubGlobal('chrome', fake.chrome);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getSettings', () => {
  it('returns the defaults when nothing is stored', async () => {
    expect(await getSettings()).toEqual(DEFAULTS);
  });

  it('validates what is stored', async () => {
    fake.data[SETTINGS_KEY] = {enabled: false, minDwellSec: 1, junk: true};
    expect(await getSettings()).toEqual({
      ...DEFAULTS,
      enabled: false,
      minDwellSec: 3,
    });
  });
});

describe('updateSettings', () => {
  it('changes only the patched fields and stores complete settings', async () => {
    fake.data[SETTINGS_KEY] = {showBadge: false};
    const next = await updateSettings({autoImages: true});
    expect(next).toEqual({...DEFAULTS, showBadge: false, autoImages: true});
    expect(fake.data[SETTINGS_KEY]).toEqual(next);
  });

  it('validates the patch', async () => {
    const next = await updateSettings({minDwellSec: -5});
    expect(next.minDwellSec).toBe(3);
  });

  it('does not lose either of two concurrent updates', async () => {
    await Promise.all([
      updateSettings({enabled: false}),
      updateSettings({autoImages: true}),
    ]);
    expect(await getSettings()).toMatchObject({
      enabled: false,
      autoImages: true,
    });
  });

  it('reports a failed write and keeps running later updates', async () => {
    fake.chrome.storage.local.set.mockRejectedValueOnce(new Error('quota'));
    await expect(updateSettings({enabled: false})).rejects.toThrow('quota');
    await updateSettings({autoImages: true});
    expect(await getSettings()).toMatchObject({
      enabled: true,
      autoImages: true,
    });
  });
});

describe('onSettingsChange', () => {
  it('reports validated new and previous settings', async () => {
    const seen: unknown[] = [];
    onSettingsChange((next, prev) => seen.push([next.enabled, prev.enabled]));
    await updateSettings({enabled: false});
    expect(seen).toEqual([[false, true]]);
  });

  it('ignores other keys and other storage areas', () => {
    const listener = vi.fn();
    onSettingsChange(listener);
    fake.fire({other: {newValue: 1}});
    for (const l of fake.listeners) {
      l({[SETTINGS_KEY]: {newValue: {}}}, 'sync');
    }
    expect(listener).not.toHaveBeenCalled();
  });

  it('stops after unsubscribing', async () => {
    const listener = vi.fn();
    const off = onSettingsChange(listener);
    off();
    await updateSettings({enabled: false});
    expect(listener).not.toHaveBeenCalled();
    expect(fake.listeners.size).toBe(0);
  });
});
