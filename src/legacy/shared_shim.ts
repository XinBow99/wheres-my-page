/**
 * @fileoverview Builds dist/shared.js with the export names of the v0.5.0 PoC
 * shared.js, so the PoC service worker, offscreen document and pages run on
 * src/shared unchanged. getSettings now validates stored values
 * (parseSettings) instead of spreading them over the defaults.
 * Deleted in T26 together with the rest of src/legacy.
 */

export {
  DEFAULT_DENYLIST,
  DIM,
  MODELS,
  PRESET_CATEGORIES,
  PROMPT,
  VISION_MODEL,
} from '../shared/constants';
export {getSettings} from '../shared/platform/settings_store';
export {DEFAULTS} from '../shared/settings';
