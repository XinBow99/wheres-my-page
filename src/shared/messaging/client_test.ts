import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  type FakeChrome,
  NO_RECEIVER_MESSAGE,
  installFakeChrome,
} from '../../../test/fakes/chrome_runtime';
import {
  DEFAULT_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  fromTransportError,
  send,
  sendToTab,
} from './client';
import {MESSAGE_SPECS} from './contract';

const STATUS = {
  pages: 1,
  historyTitles: 0,
  clips: 0,
  images: 0,
  chunks: 3,
  mb: 0.1,
  model: 'eg2_270m',
  visionLoaded: false,
  loading: false,
  error: null,
  webgpu: true,
} as const;

let fake: FakeChrome;

beforeEach(() => {
  vi.useFakeTimers();
  fake = installFakeChrome();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * Lets pending timers and promise callbacks run until `p` settles.
 *
 * @param p Promise under test.
 * @return Its value.
 */
async function settle<T>(p: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return p;
}

describe('send', () => {
  it('sends a versioned envelope and returns the reply', async () => {
    fake.runtime.sendMessage.mockResolvedValue({ok: true, data: STATUS});
    const r = await settle(send('background', 'status.get', {}));
    expect(r).toEqual({ok: true, data: STATUS});
    expect(fake.runtime.sendMessage).toHaveBeenCalledExactlyOnceWith({
      v: 1,
      target: 'background',
      type: 'status.get',
      payload: {},
    });
  });

  it('passes a non-retryable error from the receiver through untouched', async () => {
    const error = {code: 'DENIED', message: 'no', retryable: false};
    fake.runtime.sendMessage.mockResolvedValue({ok: false, error});
    const r = await settle(send('background', 'index.clear', {}));
    expect(r).toEqual({ok: false, error});
    expect(fake.runtime.sendMessage).toHaveBeenCalledOnce();
  });

  it('retries "Receiving end does not exist" with exponential backoff', async () => {
    const times: number[] = [];
    fake.runtime.sendMessage.mockImplementation(async () => {
      times.push(Date.now());
      if (times.length < 3) throw new Error(NO_RECEIVER_MESSAGE);
      return {ok: true, data: null};
    });
    const start = Date.now();
    const r = await settle(send('offscreen', 'model.load', {}));
    expect(r).toEqual({ok: true, data: null});
    expect(times.map(t => t - start)).toEqual([
      0,
      DEFAULT_RETRY_DELAY_MS,
      DEFAULT_RETRY_DELAY_MS * 3,
    ]);
  });

  it('gives up after the retries and returns the last error', async () => {
    fake.runtime.sendMessage.mockRejectedValue(new Error(NO_RECEIVER_MESSAGE));
    const r = await settle(send('offscreen', 'status.get', {}, {retries: 2}));
    expect(r).toEqual({
      ok: false,
      error: {
        code: 'NO_RECEIVER',
        message: NO_RECEIVER_MESSAGE,
        retryable: true,
      },
    });
    expect(fake.runtime.sendMessage).toHaveBeenCalledTimes(3);
  });

  it(`retries ${DEFAULT_RETRIES} times by default`, async () => {
    fake.runtime.sendMessage.mockRejectedValue(new Error(NO_RECEIVER_MESSAGE));
    await settle(send('offscreen', 'status.get', {}));
    expect(fake.runtime.sendMessage).toHaveBeenCalledTimes(DEFAULT_RETRIES + 1);
  });

  it('retries a retryable error the receiver reported', async () => {
    const error = {
      code: 'NO_RECEIVER',
      message: 'tab loading',
      retryable: true,
    };
    fake.runtime.sendMessage
      .mockResolvedValueOnce({ok: false, error})
      .mockResolvedValueOnce({ok: true, data: {denied: false}});
    const r = await settle(
      send('background', 'policy.isDenied', {url: 'https://a.com/'}),
    );
    expect(r).toEqual({ok: true, data: {denied: false}});
  });

  it.each([
    [
      'a closed message port',
      'The message port closed before a response was received.',
    ],
    ['an invalidated context', 'Extension context invalidated.'],
  ])('does not retry %s', async (_, message) => {
    fake.runtime.sendMessage.mockRejectedValue(new Error(message));
    const r = await settle(send('background', 'status.get', {}));
    expect(r).toEqual({
      ok: false,
      error: {code: 'NO_RECEIVER', message, retryable: false},
    });
    expect(fake.runtime.sendMessage).toHaveBeenCalledOnce();
  });

  it('reports other transport failures as INTERNAL without retrying', async () => {
    fake.runtime.sendMessage.mockRejectedValue(new TypeError('cyclic object'));
    const r = await settle(send('background', 'status.get', {}));
    expect(r).toEqual({
      ok: false,
      error: {code: 'INTERNAL', message: 'cyclic object', retryable: false},
    });
    expect(fake.runtime.sendMessage).toHaveBeenCalledOnce();
  });

  it('treats a missing reply as NO_RECEIVER and retries it', async () => {
    fake.runtime.sendMessage
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ok: true, data: null});
    const r = await settle(send('background', 'index.clear', {}));
    expect(r).toEqual({ok: true, data: null});
    expect(fake.runtime.sendMessage).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a v0.5.0 reply', {ok: true, chunks: 3}],
    ['a bad error', {ok: false, error: 'boom'}],
    ['a string', 'ok'],
    ['null', null],
  ])('reports %s as a malformed reply', async (_, reply) => {
    fake.runtime.sendMessage.mockResolvedValue(reply);
    const r = await settle(send('background', 'status.get', {}));
    expect(r).toEqual({
      ok: false,
      error: {
        code: 'INTERNAL',
        message: 'malformed reply to status.get',
        retryable: false,
      },
    });
  });

  it('times out after the contract default', async () => {
    fake.runtime.sendMessage.mockReturnValue(new Promise(() => {}));
    const p = send('background', 'status.get', {});
    const timeoutMs = MESSAGE_SPECS.background['status.get'].timeoutMs;
    await vi.advanceTimersByTimeAsync(timeoutMs - 1);
    let done = false;
    void p.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({
      ok: false,
      error: {
        code: 'TIMEOUT',
        message: `no reply to status.get within ${timeoutMs} ms`,
        retryable: false,
      },
    });
  });

  it('stops retrying once the overall timeout has passed', async () => {
    fake.runtime.sendMessage.mockRejectedValue(new Error(NO_RECEIVER_MESSAGE));
    const r = await settle(
      send(
        'offscreen',
        'status.get',
        {},
        {timeoutMs: 1000, retries: 10, retryDelayMs: 400},
      ),
    );
    expect(r.ok || r.error.code).toBe('TIMEOUT');
    // Attempts at 0 and 400 ms; the one due at 1200 ms is never sent.
    expect(fake.runtime.sendMessage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.runtime.sendMessage).toHaveBeenCalledTimes(2);
  });
});

describe('sendToTab', () => {
  it('sends to the content script of the tab', async () => {
    fake.tabs.sendMessage.mockResolvedValue({
      ok: true,
      data: {kind: 'indexed', chunks: 4, tags: []},
    });
    const r = await settle(sendToTab(7, 'index.now', {}));
    expect(r).toEqual({ok: true, data: {kind: 'indexed', chunks: 4, tags: []}});
    expect(fake.tabs.sendMessage).toHaveBeenCalledExactlyOnceWith(7, {
      v: 1,
      target: 'content',
      type: 'index.now',
      payload: {},
    });
  });

  it('uses the per-message timeout', async () => {
    fake.tabs.sendMessage.mockReturnValue(new Promise(() => {}));
    const p = sendToTab(7, 'picker.start', {}, {timeoutMs: 50});
    await vi.advanceTimersByTimeAsync(50);
    expect((await p).ok).toBe(false);
  });
});

describe('fromTransportError', () => {
  it('accepts non-Error reasons', () => {
    expect(fromTransportError(NO_RECEIVER_MESSAGE)).toEqual({
      code: 'NO_RECEIVER',
      message: NO_RECEIVER_MESSAGE,
      retryable: true,
    });
    expect(fromTransportError(undefined)).toEqual({
      code: 'INTERNAL',
      message: 'undefined',
      retryable: false,
    });
  });
});
