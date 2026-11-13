import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  FAKE_EXTENSION_ID,
  FAKE_ORIGIN,
  installFakeChrome,
} from '../../../test/fakes/chrome_runtime';
import {AppError, type Result} from '../errors';
import {MESSAGE_SPECS, PRIVILEGED_MESSAGES, type Target} from './contract';
import {
  type Handlers,
  type MessageListener,
  type SenderIdentity,
  classifySender,
  createRouter,
  currentIdentity,
} from './router';

const IDENTITY: SenderIdentity = {
  extensionId: FAKE_EXTENSION_ID,
  origin: FAKE_ORIGIN,
  backgroundUrl: `${FAKE_ORIGIN}background.js`,
};

const TAB = {id: 7, windowId: 1, incognito: false} as chrome.tabs.Tab;

/** Senders by kind, as Chrome reports them. */
const SENDERS = {
  content: {id: FAKE_EXTENSION_ID, url: 'https://example.com/a', tab: TAB},
  page: {id: FAKE_EXTENSION_ID, url: `${FAKE_ORIGIN}search.html`},
  pageInTab: {
    id: FAKE_EXTENSION_ID,
    url: `${FAKE_ORIGIN}search.html`,
    tab: TAB,
  },
  background: {id: FAKE_EXTENSION_ID, url: `${FAKE_ORIGIN}background.js`},
  otherExtension: {
    id: 'abcdefghijklmnopabcdefghijklmnop',
    url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/x.html',
  },
  noUrl: {id: FAKE_EXTENSION_ID},
  webWithoutTab: {id: FAKE_EXTENSION_ID, url: 'https://example.com/'},
} satisfies Record<string, chrome.runtime.MessageSender>;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('classifySender', () => {
  it.each([
    ['a content script', SENDERS.content, 'content-script'],
    ['an extension page', SENDERS.page, 'extension-page'],
    ['an extension page in a tab', SENDERS.pageInTab, 'extension-page'],
    ['the service worker', SENDERS.background, 'background'],
    ['another extension', SENDERS.otherExtension, null],
    ['a sender without URL', SENDERS.noUrl, null],
    ['a web URL without a tab', SENDERS.webWithoutTab, null],
  ])('classifies %s', (_, sender, kind) => {
    expect(classifySender(sender, IDENTITY)).toBe(kind);
  });

  it('does not take a look-alike origin for the extension', () => {
    const sender = {
      id: FAKE_EXTENSION_ID,
      url: `chrome-extension://${FAKE_EXTENSION_ID}x/search.html`,
      tab: TAB,
    };
    expect(classifySender(sender, IDENTITY)).toBe('content-script');
  });
});

describe('currentIdentity', () => {
  it('reads chrome.runtime', () => {
    installFakeChrome();
    expect(currentIdentity()).toEqual(IDENTITY);
  });
});

/**
 * Handlers for every message of a context, each a mock returning null.
 *
 * @param target Context.
 * @return Handlers, plus the same mocks by type.
 */
function mockHandlers<T extends Target>(target: T) {
  const mocks = Object.fromEntries(
    Object.keys(MESSAGE_SPECS[target]).map(type => [type, vi.fn(() => null)]),
  ) as Record<string, ReturnType<typeof vi.fn>>;
  return {handlers: mocks as unknown as Handlers<T>, mocks};
}

/**
 * Feeds one message to a listener.
 *
 * @param listener Router.
 * @param message Message.
 * @param sender Sender.
 * @return What the listener returned, and the reply if it sends one.
 */
function dispatch(
  listener: MessageListener,
  message: unknown,
  sender: chrome.runtime.MessageSender,
) {
  let returned = false;
  const sendResponse = vi.fn<(r: Result<unknown>) => void>();
  const reply = new Promise<Result<unknown>>(resolve => {
    sendResponse.mockImplementation(resolve);
    returned = listener(message, sender, sendResponse);
  });
  return {returned, reply, sendResponse};
}

const envelope = (target: Target, type: string, payload: unknown = {}) => ({
  v: 1,
  target,
  type,
  payload,
});

describe('createRouter', () => {
  it('ignores messages for other contexts without replying', () => {
    const {handlers} = mockHandlers('offscreen');
    const router = createRouter('offscreen', handlers, IDENTITY);
    for (const message of [
      envelope('background', 'status.get'),
      {type: 'SEARCH', target: 'offscreen-legacy'},
      null,
      'status.get',
    ]) {
      const {returned, sendResponse} = dispatch(
        router,
        message,
        SENDERS.background,
      );
      expect(returned).toBe(false);
      expect(sendResponse).not.toHaveBeenCalled();
    }
  });

  it('runs the handler with the payload and the sender kind', async () => {
    const {handlers, mocks} = mockHandlers('background');
    mocks['policy.isDenied']!.mockReturnValue({denied: true});
    const router = createRouter('background', handlers, IDENTITY);
    const payload = {url: 'https://example.com/'};
    const {returned, reply} = dispatch(
      router,
      envelope('background', 'policy.isDenied', payload),
      SENDERS.page,
    );
    expect(returned).toBe(true);
    expect(await reply).toEqual({ok: true, data: {denied: true}});
    expect(mocks['policy.isDenied']).toHaveBeenCalledExactlyOnceWith(payload, {
      sender: SENDERS.page,
      from: 'extension-page',
    });
  });

  it('awaits async handlers', async () => {
    const {handlers, mocks} = mockHandlers('content');
    mocks['index.now']!.mockResolvedValue({
      kind: 'skipped',
      reason: 'denylist',
    });
    const router = createRouter('content', handlers, IDENTITY);
    const {reply} = dispatch(
      router,
      envelope('content', 'index.now'),
      SENDERS.background,
    );
    expect(await reply).toEqual({
      ok: true,
      data: {kind: 'skipped', reason: 'denylist'},
    });
  });

  it.each(PRIVILEGED_MESSAGES)(
    'denies %s from a content script without running it',
    async type => {
      const {handlers, mocks} = mockHandlers('background');
      const router = createRouter('background', handlers, IDENTITY);
      const payload = {
        'index.clear': {},
        'index.deleteDomain': {domain: 'example.com'},
        'history.import': {days: 30},
        'category.put': {cat: {name: 'x', description: '', color: '#000'}},
        'category.delete': {id: 'ai'},
      }[type as string];
      const message = envelope('background', type, payload);
      const {returned, reply} = dispatch(router, message, SENDERS.content);
      expect(returned).toBe(true);
      expect(await reply).toEqual({
        ok: false,
        error: {
          code: 'DENIED',
          message: `${type} is not accepted from content-script`,
          retryable: false,
        },
      });
      expect(mocks[type]).not.toHaveBeenCalled();

      // The same message from an extension page goes through.
      expect(await dispatch(router, message, SENDERS.page).reply).toEqual({
        ok: true,
        data: null,
      });
    },
  );

  it('denies offscreen messages from anything but the service worker', async () => {
    const {handlers, mocks} = mockHandlers('offscreen');
    const router = createRouter('offscreen', handlers, IDENTITY);
    const message = envelope('offscreen', 'index.clear');
    for (const sender of [SENDERS.page, SENDERS.content]) {
      const r = await dispatch(router, message, sender).reply;
      expect(r.ok || r.error.code).toBe('DENIED');
    }
    expect(mocks['index.clear']).not.toHaveBeenCalled();
    const r = await dispatch(router, message, SENDERS.background).reply;
    expect(r.ok).toBe(true);
  });

  it.each([
    ['another extension', SENDERS.otherExtension],
    ['an unknown origin', SENDERS.webWithoutTab],
  ])('refuses %s before looking at the message', async (_, sender) => {
    const {handlers, mocks} = mockHandlers('background');
    const router = createRouter('background', handlers, IDENTITY);
    const {returned, reply} = dispatch(
      router,
      envelope('background', 'status.get'),
      sender,
    );
    expect(returned).toBe(true);
    const r = await reply;
    expect(r.ok || r.error.code).toBe('DENIED');
    expect(mocks['status.get']).not.toHaveBeenCalled();
  });

  it('replies INVALID_MESSAGE to a bad envelope or payload', async () => {
    const {handlers, mocks} = mockHandlers('background');
    const router = createRouter('background', handlers, IDENTITY);
    for (const message of [
      {...envelope('background', 'status.get'), v: 2},
      envelope('background', 'SEARCH'),
      envelope('background', 'index.deleteDomain', {domain: 42}),
    ]) {
      const r = await dispatch(router, message, SENDERS.page).reply;
      expect(r.ok || r.error.code).toBe('INVALID_MESSAGE');
    }
    expect(Object.values(mocks).some(m => m.mock.calls.length)).toBe(false);
  });

  it('reports a thrown Error as INTERNAL and keeps its message', async () => {
    const {handlers, mocks} = mockHandlers('content');
    mocks['picker.start']!.mockImplementation(() => {
      throw new TypeError('cannot read properties of null');
    });
    const router = createRouter('content', handlers, IDENTITY);
    const r = await dispatch(
      router,
      envelope('content', 'picker.start'),
      SENDERS.page,
    ).reply;
    expect(r).toEqual({
      ok: false,
      error: {
        code: 'INTERNAL',
        message: 'cannot read properties of null',
        retryable: false,
      },
    });
  });

  it('keeps the code of a rejected AppError', async () => {
    const {handlers, mocks} = mockHandlers('background');
    mocks['category.scorePage']!.mockRejectedValue(
      new AppError('NOT_FOUND', 'no page https://example.com/'),
    );
    const router = createRouter('background', handlers, IDENTITY);
    const message = envelope('background', 'category.scorePage', {
      url: 'https://example.com/',
    });
    const r = await dispatch(router, message, SENDERS.page).reply;
    expect(r).toEqual({
      ok: false,
      error: {
        code: 'NOT_FOUND',
        message: 'no page https://example.com/',
        retryable: false,
      },
    });
  });

  it('uses chrome.runtime for the identity by default', async () => {
    installFakeChrome();
    const {handlers} = mockHandlers('content');
    const router = createRouter('content', handlers);
    const r = await dispatch(
      router,
      envelope('content', 'clip.context'),
      SENDERS.background,
    ).reply;
    expect(r).toEqual({ok: true, data: null});
  });
});
