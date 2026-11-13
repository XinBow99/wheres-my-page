/**
 * @fileoverview Builds dist/chunk.js with the export names of the v0.5.0 PoC
 * chunk.js, so the PoC offscreen document runs on src/core/text unchanged.
 * Deleted in T26 together with the rest of src/legacy.
 */

export {TOKEN_BUDGET, chunkText} from '../core/text/chunk';
export {estimateTokens, truncateToTokens} from '../core/text/tokens';
export {hashText} from '../shared/hash';
