/**
 * @fileoverview User settings: type, defaults and validation of stored
 * values (pure; storage access lives in platform/settings_store).
 */

import {DEFAULT_DENYLIST, MODELS, type ModelKey} from './constants';

/** How block (region) indexing is offered on pages. */
export type BlockMode = 'off' | 'manual' | 'hints';

/** User settings as stored under `settings` in chrome.storage.local. */
export interface Settings {
  /** Whether pages are indexed automatically. */
  enabled: boolean;
  /** Seconds a page must be visible in total before it is indexed. */
  minDwellSec: number;
  /** Denylist globs, one per line. */
  denylist: string;
  /** Text embedding model. */
  model: ModelKey;
  /** Whether the status badge is shown at the bottom right of pages. */
  showBadge: boolean;
  /** Hostnames where the badge is hidden (pages are still indexed). */
  badgeHiddenDomains: readonly string[];
  /** Lowest similarity for an auto tag; higher is more conservative. */
  tagMinScore: number;
  /** Whether auto-indexing a page also indexes the images in its content. */
  autoImages: boolean;
  /** Search results below this text similarity are hidden (0 shows all). */
  searchMinSim: number;
  /** Image results below this similarity are hidden (0 shows all). */
  imageMinSim: number;
  /** Block indexing: off, on request, or with hints on indexable blocks. */
  blockMode: BlockMode;
}

/** v0.5.0 defaults. */
export const DEFAULTS: Readonly<Settings> = Object.freeze({
  enabled: true,
  minDwellSec: 20,
  denylist: DEFAULT_DENYLIST,
  model: 'eg2_270m',
  showBadge: true,
  badgeHiddenDomains: Object.freeze([]),
  tagMinScore: 0.2,
  autoImages: false,
  searchMinSim: 0,
  imageMinSim: 0,
  blockMode: 'manual',
});

/** Allowed range of minDwellSec, as in the settings form. */
export const DWELL_RANGE = Object.freeze({min: 3, max: 600});

/** Allowed range of tagMinScore, as on the settings slider. */
export const TAG_MIN_SCORE_RANGE = Object.freeze({min: 0.05, max: 0.6});

/** Allowed range of the search similarity thresholds, as on the sliders. */
export const SIM_THRESHOLD_RANGE = Object.freeze({min: 0, max: 0.9});

const BLOCK_MODES: readonly string[] = ['off', 'manual', 'hints'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * A finite number clamped into a range, or the fallback for anything else.
 *
 * @param value Stored value.
 * @param range Inclusive bounds.
 * @param range.min Lower bound.
 * @param range.max Upper bound.
 * @param fallback Value used when `value` is not a finite number.
 */
function clampedOr(
  value: unknown,
  range: {min: number; max: number},
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(range.max, Math.max(range.min, value));
}

function isModelKey(value: unknown): value is ModelKey {
  return typeof value === 'string' && Object.hasOwn(MODELS, value);
}

function isBlockMode(value: unknown): value is BlockMode {
  return typeof value === 'string' && BLOCK_MODES.includes(value);
}

function domainsOr(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value
    .filter((d): d is string => typeof d === 'string')
    .map(d => d.trim())
    .filter(Boolean);
}

/**
 * Reads settings from an untrusted stored value. Every field is validated on
 * its own: a missing or wrongly typed field takes its default, a number out of
 * range is clamped, and unknown fields are dropped. Never throws.
 *
 * @param raw Value stored under `settings`, or anything else.
 * @return Complete, valid settings (a new object).
 */
export function parseSettings(raw: unknown): Settings {
  const s = isRecord(raw) ? raw : {};
  return {
    enabled: booleanOr(s['enabled'], DEFAULTS.enabled),
    minDwellSec: clampedOr(s['minDwellSec'], DWELL_RANGE, DEFAULTS.minDwellSec),
    denylist: stringOr(s['denylist'], DEFAULTS.denylist),
    model: isModelKey(s['model']) ? s['model'] : DEFAULTS.model,
    showBadge: booleanOr(s['showBadge'], DEFAULTS.showBadge),
    badgeHiddenDomains: domainsOr(
      s['badgeHiddenDomains'],
      DEFAULTS.badgeHiddenDomains,
    ),
    tagMinScore: clampedOr(
      s['tagMinScore'],
      TAG_MIN_SCORE_RANGE,
      DEFAULTS.tagMinScore,
    ),
    autoImages: booleanOr(s['autoImages'], DEFAULTS.autoImages),
    searchMinSim: clampedOr(
      s['searchMinSim'],
      SIM_THRESHOLD_RANGE,
      DEFAULTS.searchMinSim,
    ),
    imageMinSim: clampedOr(
      s['imageMinSim'],
      SIM_THRESHOLD_RANGE,
      DEFAULTS.imageMinSim,
    ),
    blockMode: isBlockMode(s['blockMode'])
      ? s['blockMode']
      : DEFAULTS.blockMode,
  };
}
