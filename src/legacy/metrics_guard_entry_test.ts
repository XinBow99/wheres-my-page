import {afterEach, expect, it, vi} from 'vitest';

import {BLOCKED_MESSAGE} from '../offscreen/metrics_guard';

afterEach(() => {
  vi.unstubAllGlobals();
});

it('guards the global fetch when loaded', async () => {
  const real = vi.fn<typeof fetch>(async () => new Response('ok'));
  vi.stubGlobal('fetch', real);
  vi.stubGlobal('location', {
    href: 'chrome-extension://iogmdngpbdmhfphilnennjocdhclneok/offscreen.html',
  });
  await import('./metrics_guard_entry');
  await expect(fetch('https://odml.pa.googleapis.com/v1/log')).rejects.toThrow(
    BLOCKED_MESSAGE,
  );
  expect(await (await fetch('wasm/x.wasm')).text()).toBe('ok');
  expect(real).toHaveBeenCalledOnce();
});
