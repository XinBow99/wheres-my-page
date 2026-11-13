/**
 * @fileoverview Fixed extension identity for the unpacked dist/ build.
 *
 * An unpacked extension's ID normally comes from its folder path, so loading
 * dist/ from another checkout or machine would get a new ID and lose access to
 * its IndexedDB index. Pinning the manifest `key` keeps the ID stable.
 *
 * This is only the RSA public key (SPKI DER, base64); the private key was never
 * kept, and none is needed to load an unpacked extension. A Chrome Web Store
 * release would replace this with the store item's public key.
 */

import {createHash} from 'node:crypto';

/** Value written to `key` in dist/manifest.json. */
export const EXTENSION_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1WQUstLddKR4/PwKVKN61cpyjby6ijw1z2jVmg2tXMiYFBGBLoE/VvjOpJsNMDM7R2qq9WEUgUv1tChwVtmx1W4bQInoywVUaXdqSE8Ttm6p2bmRnMTnwv1Jczadg9MbAV+nJxf2eejEmIKDrNl7m+Ds52J7tshIcwzkl6CUHWQgQYhtL5Ax28/cO1kr2WPcFvctXLbERbw0EVfh6aVC3nI828xgCk7vTQYFxTo0eEea5bov3QzRNjembmMqQ/S6SrFm/FVdFT2iHv4riewvywJAhCo/U1x1rexkFUgeV9ztkSAdJ2ZwWlLHXOMVzn/X+uFHmkkOMMLzRA8DZsouTQIDAQAB';

/** The ID Chrome derives from EXTENSION_KEY. */
export const EXTENSION_ID = 'iogmdngpbdmhfphilnennjocdhclneok';

/**
 * Derives an extension ID the way Chrome does: the first 128 bits of the
 * SHA-256 of the public key, each hex digit mapped 0-f to a-p.
 * @param {string} key Base64 SPKI DER public key, as in manifest `key`.
 * @return {string} The 32-letter extension ID.
 */
export function extensionIdFromKey(key) {
  const hex = createHash('sha256')
    .update(Buffer.from(key, 'base64'))
    .digest('hex')
    .slice(0, 32);
  return [...hex]
    .map(digit => String.fromCharCode(97 + parseInt(digit, 16)))
    .join('');
}
