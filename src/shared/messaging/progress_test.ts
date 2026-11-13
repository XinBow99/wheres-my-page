import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  FAKE_EXTENSION_ID,
  type FakeChrome,
  createPortPair,
  installFakeChrome,
} from '../../../test/fakes/chrome_runtime';
import {
  PROGRESS_PORT_PREFIX,
  type Progress,
  ProgressHub,
  type ProgressPort,
  channelOf,
  isProgress,
  subscribeProgress,
} from './progress';

const STEP: Progress = {done: 10, total: 100, label: 'download'};

/** Lets queued port messages arrive. */
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('isProgress', () => {
  it.each([
    [STEP, true],
    [{done: 0, total: null, label: ''}, true],
    [{done: -1, total: 1, label: ''}, false],
    [{done: NaN, total: 1, label: ''}, false],
    [{done: 1, total: Infinity, label: ''}, false],
    [{done: 1, total: '2', label: ''}, false],
    [{done: 1, total: 2}, false],
    [null, false],
    ['10%', false],
  ])('%j → %s', (x, valid) => {
    expect(isProgress(x)).toBe(valid);
  });
});

describe('channelOf', () => {
  it.each([
    ['progress:model', 'model'],
    ['progress:import', 'import'],
    ['progress:images', 'images'],
    ['progress:other', null],
    ['progress:', null],
    ['model', null],
    ['semhist-port', null],
  ])('%s → %s', (name, channel) => {
    expect(channelOf(name)).toBe(channel);
  });
});

describe('subscribeProgress + ProgressHub', () => {
  let fake: FakeChrome;
  let hub: ProgressHub;

  beforeEach(() => {
    fake = installFakeChrome();
    hub = new ProgressHub(FAKE_EXTENSION_ID);
    fake.runtime.onConnect.addListener(port => hub.accept(port));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('delivers updates to every subscriber of the channel only', async () => {
    const model1 = vi.fn();
    const model2 = vi.fn();
    const imports = vi.fn();
    subscribeProgress('model', model1);
    subscribeProgress('model', model2);
    subscribeProgress('import', imports);
    expect(fake.runtime.connect).toHaveBeenCalledWith({
      name: `${PROGRESS_PORT_PREFIX}model`,
    });
    expect(hub.publish('model', STEP)).toBe(2);
    await flush();
    expect(model1).toHaveBeenCalledExactlyOnceWith(STEP);
    expect(model2).toHaveBeenCalledExactlyOnceWith(STEP);
    expect(imports).not.toHaveBeenCalled();
  });

  it('unsubscribes once however often it is called', async () => {
    const onProgress = vi.fn();
    const onEnd = vi.fn();
    const unsubscribe = subscribeProgress('import', onProgress, onEnd);
    expect(hub.size('import')).toBe(1);
    unsubscribe();
    unsubscribe();
    expect(onEnd).toHaveBeenCalledOnce();
    expect(hub.size('import')).toBe(0);
    expect(hub.publish('import', STEP)).toBe(0);
    await flush();
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('ends subscriptions when the job ends', () => {
    const onEnd = vi.fn();
    const unsubscribe = subscribeProgress('images', vi.fn(), onEnd);
    hub.end('images');
    expect(onEnd).toHaveBeenCalledOnce();
    expect(hub.size('images')).toBe(0);
    unsubscribe();
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it('drops invalid updates with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onProgress = vi.fn();
    let server: ProgressPort | undefined;
    subscribeProgress('model', onProgress, undefined, name => {
      const [opener, receiver] = createPortPair(name);
      server = receiver;
      return opener;
    });
    server!.postMessage({done: 'half'});
    server!.postMessage(STEP);
    await flush();
    expect(onProgress).toHaveBeenCalledExactlyOnceWith(STEP);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('ignores updates that arrive after unsubscribing', async () => {
    const onProgress = vi.fn();
    const port = {
      name: `${PROGRESS_PORT_PREFIX}model`,
      onMessage: {addListener: vi.fn()},
      onDisconnect: {addListener: vi.fn()},
      postMessage: vi.fn(),
      disconnect: vi.fn(),
    };
    const unsubscribe = subscribeProgress(
      'model',
      onProgress,
      undefined,
      () => port,
    );
    unsubscribe();
    const deliver = port.onMessage.addListener.mock.calls[0]![0] as (
      m: unknown,
    ) => void;
    deliver(STEP);
    expect(onProgress).not.toHaveBeenCalled();
    expect(port.disconnect).toHaveBeenCalledOnce();
  });
});

describe('ProgressHub.accept', () => {
  it('leaves ports that are not progress ports alone', () => {
    const hub = new ProgressHub(FAKE_EXTENSION_ID);
    const [, port] = createPortPair('semhist-port', {id: FAKE_EXTENSION_ID});
    expect(hub.accept(port)).toBe(false);
  });

  it('disconnects ports opened by another extension', () => {
    const hub = new ProgressHub(FAKE_EXTENSION_ID);
    const [opener, port] = createPortPair('progress:model', {id: 'other'});
    const closed = vi.fn();
    opener.onDisconnect.addListener(closed);
    expect(hub.accept(port)).toBe(true);
    expect(closed).toHaveBeenCalledOnce();
    expect(hub.size('model')).toBe(0);
  });

  it('forgets a port whose page went away without onDisconnect', () => {
    const hub = new ProgressHub(FAKE_EXTENSION_ID);
    const live = vi.fn();
    const dead: ProgressPort = {
      name: 'progress:import',
      sender: {id: FAKE_EXTENSION_ID},
      onMessage: {addListener: vi.fn()},
      onDisconnect: {addListener: vi.fn()},
      postMessage: () => {
        throw new Error('Attempting to use a disconnected port object');
      },
      disconnect: vi.fn(),
    };
    const ok: ProgressPort = {...dead, postMessage: live};
    hub.accept(dead);
    hub.accept(ok);
    expect(hub.publish('import', STEP)).toBe(1);
    expect(hub.size('import')).toBe(1);
    expect(live).toHaveBeenCalledExactlyOnceWith(STEP);
  });
});
