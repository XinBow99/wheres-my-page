/**
 * @fileoverview Classic script loaded by dist/offscreen.html before the PoC
 * offscreen.js module, so MediaPipe's usage metrics never leave the machine
 * (src/offscreen/metrics_guard.ts).
 */

import {installMetricsGuard} from '../offscreen/metrics_guard';

installMetricsGuard(globalThis, location.href);
