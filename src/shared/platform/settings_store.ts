/**
 * @fileoverview Settings in chrome.storage.local, always read through
 * parseSettings so callers never see missing or invalid values.
 *
 * Available in the service worker, extension pages and content scripts; not
 * in the offscreen document, which receives settings by message.
 */

import {type Settings, parseSettings} from '../settings';

/** chrome.storage.local key holding the settings object (v0.5.0 layout). */
export const SETTINGS_KEY = 'settings';

/** Called with the new and previous settings after any change. */
export type SettingsListener = (next: Settings, prev: Settings) => void;

/**
 * Reads the current settings.
 *
 * @return Valid settings; defaults for anything missing or invalid.
 */
export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return parseSettings(stored[SETTINGS_KEY]);
}

/** Tail of this context's update chain, so updates never interleave. */
let pending: Promise<unknown> = Promise.resolve();

/**
 * Changes some settings and keeps the rest.
 *
 * Updates from one context run one after another, each reading the value the
 * previous one wrote, so two quick changes (e.g. two popup toggles) cannot
 * overwrite each other. The patch is validated together with the stored
 * settings, so an invalid value falls back like any stored value would.
 *
 * @param patch Fields to change.
 * @return Settings as stored after the update.
 */
export function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const run = pending.then(async () => {
    const next = parseSettings({...(await getSettings()), ...patch});
    await chrome.storage.local.set({[SETTINGS_KEY]: next});
    return next;
  });
  // The next update waits for this one to settle either way; a failure is
  // reported to this update's caller through `run`.
  pending = Promise.allSettled([run]);
  return run;
}

/**
 * Subscribes to settings changes made by any context.
 *
 * @param listener Called after each change with the new and old settings.
 * @return Function that unsubscribes.
 */
export function onSettingsChange(listener: SettingsListener): () => void {
  const handle = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    const change = changes[SETTINGS_KEY];
    if (area !== 'local' || !change) return;
    listener(parseSettings(change.newValue), parseSettings(change.oldValue));
  };
  chrome.storage.onChanged.addListener(handle);
  return () => chrome.storage.onChanged.removeListener(handle);
}
