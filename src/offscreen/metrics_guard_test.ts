import {describe, expect, it, vi} from 'vitest';

import {
  BLOCKED_MESSAGE,
  guardFetch,
  installMetricsGuard,
} from './metrics_guard';

const BASE =
  'chrome-extension://iogmdngpbdmhfphilnennjocdhclneok/offscreen.html';
const LOG_URL = 'https://odml.pa.googleapis.com/v1/log';

function fakeFetch() {
  return vi.fn<typeof fetch>(async () => new Response('ok'));
}

describe('guardFetch', () => {
  it.each([
    ['a string', LOG_URL],
    ['a URL', new URL(LOG_URL)],
    ['a Request', new Request(LOG_URL, {method: 'POST'})],
    ['an upper-case host', 'https://ODML.PA.GOOGLEAPIS.COM/v1/log'],
    ['another path', 'https://odml.pa.googleapis.com/anything?x=1'],
    ['plain http', 'http://odml.pa.googleapis.com/v1/log'],
  ])(
    'rejects the metrics endpoint given as %s without sending',
    async (_, input) => {
      const real = fakeFetch();
      const guarded = guardFetch(real, BASE);
      await expect(guarded(input, {method: 'POST'})).rejects.toThrow(
        new TypeError(BLOCKED_MESSAGE),
      );
      expect(real).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'the model download',
      'https://huggingface.co/litert-community/x.litertlm',
    ],
    ['an indexed image', 'https://example.com/a.png'],
    ['a look-alike host', 'https://odml.pa.googleapis.com.example.com/v1/log'],
    ['another Google host', 'https://pa.googleapis.com/v1/log'],
    ['a data URL', 'data:image/png;base64,AAAA'],
    ['an extension file', 'wasm/retrieval_wasm_internal.wasm'],
  ])('passes %s through unchanged', async (_, input) => {
    const real = fakeFetch();
    const init = {credentials: 'include'} as const;
    const res = await guardFetch(real, BASE)(input, init);
    expect(await res.text()).toBe('ok');
    expect(real).toHaveBeenCalledWith(input, init);
  });

  it('leaves unparseable input to the real fetch', async () => {
    const real = vi.fn<typeof fetch>(async () => {
      throw new TypeError('Failed to parse URL');
    });
    await expect(guardFetch(real, 'not a base')('::')).rejects.toThrow(
      'Failed to parse URL',
    );
    expect(real).toHaveBeenCalledOnce();
  });
});

describe('installMetricsGuard', () => {
  it('replaces fetch on the scope and keeps it bound', async () => {
    const real = vi.fn(async function (this: unknown) {
      return new Response(this === scope ? 'bound' : 'unbound');
    });
    const scope = {fetch: real as unknown as typeof fetch};
    installMetricsGuard(scope, BASE);
    expect(scope.fetch).not.toBe(real);
    await expect(scope.fetch(LOG_URL)).rejects.toThrow(BLOCKED_MESSAGE);
    expect(await (await scope.fetch('https://example.com/')).text()).toBe(
      'bound',
    );
  });
});
