/**
 * @fileoverview In-memory stand-ins for the parts of chrome.runtime and
 * chrome.tabs that src/shared/messaging uses: message sending (behaviour set
 * per test), long-lived Ports with the disconnect semantics of Chrome, and
 * onConnect.
 */

import {vi} from 'vitest';

/** Fixed extension id of the fake. */
export const FAKE_EXTENSION_ID = 'iogmdngpbdmhfphilnennjocdhclneok';

/** Origin of the fake extension's pages, with the trailing slash. */
export const FAKE_ORIGIN = `chrome-extension://${FAKE_EXTENSION_ID}/`;

/** Chrome's error for a message nobody listens to. */
export const NO_RECEIVER_MESSAGE =
  'Could not establish connection. Receiving end does not exist.';

/**
 * A minimal chrome.events.Event.
 *
 * @template L Listener type.
 */
export class FakeEvent<L extends (...args: never[]) => unknown> {
  /** Registered listeners, in order. */
  readonly listeners: L[] = [];

  /**
   * @param listener Listener to add.
   */
  addListener(listener: L): void {
    this.listeners.push(listener);
  }

  /**
   * @param listener Listener to remove.
   */
  removeListener(listener: L): void {
    const i = this.listeners.indexOf(listener);
    if (i >= 0) this.listeners.splice(i, 1);
  }

  /**
   * @param listener Listener to look for.
   * @return Whether it is registered.
   */
  hasListener(listener: L): boolean {
    return this.listeners.includes(listener);
  }

  /**
   * Calls every listener.
   *
   * @param args Event arguments.
   */
  fire(...args: Parameters<L>): void {
    for (const l of [...this.listeners]) l(...args);
  }
}

/** One end of a fake Port. */
export interface FakePort {
  /** Port name. */
  readonly name: string;
  /** Sender as seen by this end (set on the receiving end). */
  readonly sender?: chrome.runtime.MessageSender;
  /** Messages from the other end. */
  readonly onMessage: FakeEvent<(message: unknown, port: FakePort) => void>;
  /** Fired when the other end disconnects (never for this end's own call). */
  readonly onDisconnect: FakeEvent<(port: FakePort) => void>;
  /** Sends to the other end; throws once disconnected, like Chrome. */
  postMessage(message: unknown): void;
  /** Closes both ends. */
  disconnect(): void;
}

/**
 * Two connected Port ends.
 *
 * @param name Port name.
 * @param sender Sender the receiving end reports.
 * @return `[opener, receiver]`.
 */
export function createPortPair(
  name: string,
  sender?: chrome.runtime.MessageSender,
): [FakePort, FakePort] {
  let open = true;
  const make = (s?: chrome.runtime.MessageSender): FakePort => ({
    name,
    ...(s ? {sender: s} : {}),
    onMessage: new FakeEvent(),
    onDisconnect: new FakeEvent(),
    postMessage(message: unknown) {
      if (!open) {
        throw new Error('Attempting to use a disconnected port object');
      }
      // Ports JSON-serialize, so a structured clone is close enough.
      const copy = structuredClone(message);
      queueMicrotask(() => {
        if (open) other(this).onMessage.fire(copy, other(this));
      });
    },
    disconnect() {
      if (!open) return;
      open = false;
      other(this).onDisconnect.fire(other(this));
    },
  });
  const opener = make();
  const receiver = make(sender);
  const other = (p: FakePort) => (p === opener ? receiver : opener);
  return [opener, receiver];
}

/** The fake chrome object and handles for driving it. */
export interface FakeChrome {
  /** chrome.runtime subset. */
  readonly runtime: {
    readonly id: string;
    getURL(path: string): string;
    getManifest(): {background: {service_worker: string}};
    readonly sendMessage: ReturnType<typeof vi.fn>;
    readonly connect: ReturnType<typeof vi.fn>;
    readonly onConnect: FakeEvent<(port: FakePort) => void>;
  };
  /** chrome.tabs subset. */
  readonly tabs: {readonly sendMessage: ReturnType<typeof vi.fn>};
}

/**
 * Installs a fake `chrome` global (undo with vi.unstubAllGlobals).
 * `runtime.connect` opens a Port pair, hands the receiving end to the
 * onConnect listeners with an extension-page sender, and returns the opener.
 *
 * @return The fake.
 */
export function installFakeChrome(): FakeChrome {
  const onConnect = new FakeEvent<(port: FakePort) => void>();
  const fake: FakeChrome = {
    runtime: {
      id: FAKE_EXTENSION_ID,
      getURL: (path: string) => FAKE_ORIGIN + path.replace(/^\//, ''),
      getManifest: () => ({background: {service_worker: 'background.js'}}),
      sendMessage: vi.fn(),
      connect: vi.fn(({name}: {name: string}) => {
        const [opener, receiver] = createPortPair(name, {
          id: FAKE_EXTENSION_ID,
          url: `${FAKE_ORIGIN}search.html`,
        });
        onConnect.fire(receiver);
        return opener;
      }),
      onConnect,
    },
    tabs: {sendMessage: vi.fn()},
  };
  vi.stubGlobal('chrome', fake);
  return fake;
}
