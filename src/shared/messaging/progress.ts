/**
 * @fileoverview Progress of long jobs over Ports (model download, history
 * import, image indexing), replacing v0.5.0's blank "搜尋中…" wait and the
 * content script's 200 ms polling.
 *
 * An extension page subscribes to a channel; the background holds a
 * ProgressHub and publishes to every subscriber of that channel. Both ends
 * tolerate the other end going away at any time: unsubscribing and
 * disconnect handling are idempotent, and publishing to a closed port drops
 * that port.
 */

/** Kinds of long job. */
export type ProgressChannel = 'model' | 'import' | 'images';

/** Every channel. */
export const PROGRESS_CHANNELS: readonly ProgressChannel[] = Object.freeze([
  'model',
  'import',
  'images',
]);

/** Port names are this prefix plus the channel. */
export const PROGRESS_PORT_PREFIX = 'progress:';

/** One progress update. */
export interface Progress {
  /** Units done (bytes, history entries, images). */
  readonly done: number;
  /** Units in all; null when unknown (e.g. no Content-Length). */
  readonly total: number | null;
  /** Short English label for logs; UI text comes from the channel. */
  readonly label: string;
}

/** The parts of chrome.runtime.Port used here. */
export interface ProgressPort {
  /** Port name. */
  readonly name: string;
  /** Sender of the other end (set on the receiving side). */
  readonly sender?: chrome.runtime.MessageSender;
  /** Incoming messages. */
  readonly onMessage: {
    addListener(listener: (message: unknown) => void): void;
  };
  /** Fired when the other end disconnects. */
  readonly onDisconnect: {addListener(listener: () => void): void};
  /** Sends a message; throws once disconnected. */
  postMessage(message: unknown): void;
  /** Closes the port. */
  disconnect(): void;
}

/**
 * Whether `x` is a valid Progress.
 *
 * @param x Received value.
 * @return True for finite non-negative counts and a string label.
 */
export function isProgress(x: unknown): x is Progress {
  if (typeof x !== 'object' || x === null) return false;
  const p = x as Record<string, unknown>;
  const count = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0;
  return (
    count(p['done']) &&
    (p['total'] === null || count(p['total'])) &&
    typeof p['label'] === 'string'
  );
}

/**
 * Channel a port name refers to.
 *
 * @param name Port name.
 * @return The channel, or null for ports that are not progress ports.
 */
export function channelOf(name: string): ProgressChannel | null {
  if (!name.startsWith(PROGRESS_PORT_PREFIX)) return null;
  const channel = name.slice(PROGRESS_PORT_PREFIX.length);
  return PROGRESS_CHANNELS.find(c => c === channel) ?? null;
}

/**
 * Subscribes to a channel from an extension page.
 *
 * @param channel Channel.
 * @param onProgress Called for each valid update; invalid ones are logged
 *     and dropped.
 * @param onEnd Called once when the subscription ends, from either side.
 * @param connect Opens the port; defaults to chrome.runtime.connect.
 * @return Unsubscribe; safe to call more than once.
 */
export function subscribeProgress(
  channel: ProgressChannel,
  onProgress: (progress: Progress) => void,
  onEnd: () => void = () => {},
  connect: (name: string) => ProgressPort = name =>
    chrome.runtime.connect({name}),
): () => void {
  const port = connect(PROGRESS_PORT_PREFIX + channel);
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    onEnd();
  };
  port.onMessage.addListener(message => {
    if (ended) return;
    if (isProgress(message)) onProgress(message);
    else console.warn(`progress:${channel}: dropped invalid update`, message);
  });
  port.onDisconnect.addListener(end);
  return () => {
    if (ended) return;
    port.disconnect();
    end();
  };
}

/** Background side: tracks subscribers and fans out updates. */
export class ProgressHub {
  private readonly ports = new Map<ProgressChannel, Set<ProgressPort>>(
    PROGRESS_CHANNELS.map(c => [c, new Set()]),
  );

  /**
   * @param extensionId Only ports opened by this extension are accepted.
   */
  constructor(private readonly extensionId: string) {}

  /**
   * Takes a port from chrome.runtime.onConnect.
   *
   * @param port New port.
   * @return False when it is not a progress port (leave it to others).
   */
  accept(port: ProgressPort): boolean {
    const channel = channelOf(port.name);
    if (channel === null) return false;
    if (port.sender?.id !== this.extensionId) {
      port.disconnect();
      return true;
    }
    const set = this.subscribers(channel);
    set.add(port);
    port.onDisconnect.addListener(() => set.delete(port));
    return true;
  }

  /**
   * Sends an update to every subscriber of a channel.
   *
   * @param channel Channel.
   * @param progress Update.
   * @return Number of subscribers reached.
   */
  publish(channel: ProgressChannel, progress: Progress): number {
    const set = this.subscribers(channel);
    let reached = 0;
    for (const port of [...set]) {
      try {
        port.postMessage(progress);
        reached++;
      } catch {
        // The page closed before onDisconnect ran: stop sending to it.
        set.delete(port);
      }
    }
    return reached;
  }

  /**
   * Ends a channel's job: disconnects and forgets all its subscribers.
   *
   * @param channel Channel.
   */
  end(channel: ProgressChannel): void {
    const set = this.subscribers(channel);
    for (const port of set) port.disconnect();
    set.clear();
  }

  /**
   * @param channel Channel.
   * @return Current subscriber count.
   */
  size(channel: ProgressChannel): number {
    return this.subscribers(channel).size;
  }

  /**
   * @param channel Channel.
   * @return Live subscriber set of the channel.
   */
  private subscribers(channel: ProgressChannel): Set<ProgressPort> {
    return this.ports.get(channel)!;
  }
}
