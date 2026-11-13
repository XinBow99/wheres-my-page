/**
 * @fileoverview Receiving side of the messaging contract: a
 * chrome.runtime.onMessage listener that validates, checks who sent the
 * message, runs the handler and always replies with a Result.
 *
 * Order: not addressed to this context → ignored (another context's router
 * answers); wrong extension id → DENIED; invalid envelope →
 * INVALID_MESSAGE; sender kind not in the message's allowedFrom → DENIED;
 * handler throws → its error (AppError code, or INTERNAL with the message).
 */

import {AppError, type Result, toWireError} from '../errors';
import {
  MESSAGE_SPECS,
  type MessageType,
  type RequestOf,
  type ResponseOf,
  type Sender,
  type Target,
} from './contract';
import {validateEnvelope} from './validate';

/** What a handler knows about the request beyond its payload. */
export interface HandlerContext {
  /** Raw sender from Chrome (tab, frame, URL). */
  readonly sender: chrome.runtime.MessageSender;
  /** Sender kind, already checked against allowedFrom. */
  readonly from: Sender;
}

/**
 * Handles one message type.
 *
 * @template T Receiving context.
 * @template K Message type.
 */
export type Handler<T extends Target, K extends MessageType<T>> = (
  payload: RequestOf<T, K>,
  context: HandlerContext,
) => ResponseOf<T, K> | Promise<ResponseOf<T, K>>;

/**
 * A handler for every message of a context; missing one fails to compile.
 *
 * @template T Receiving context.
 */
export type Handlers<T extends Target> = {
  readonly [K in MessageType<T>]: Handler<T, K>;
};

/** A chrome.runtime.onMessage listener. */
export type MessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: Result<unknown>) => void,
) => boolean;

/** How to recognize this extension's own contexts. */
export interface SenderIdentity {
  /** chrome.runtime.id. */
  readonly extensionId: string;
  /** Origin of extension pages, with the trailing slash. */
  readonly origin: string;
  /** URL of the service worker script. */
  readonly backgroundUrl: string;
}

/**
 * Identity of the running extension.
 *
 * @return Values read from chrome.runtime.
 */
export function currentIdentity(): SenderIdentity {
  const background = chrome.runtime.getManifest().background;
  const worker =
    background && 'service_worker' in background
      ? background.service_worker
      : 'background.js';
  return {
    extensionId: chrome.runtime.id,
    origin: chrome.runtime.getURL(''),
    backgroundUrl: chrome.runtime.getURL(worker),
  };
}

/**
 * Classifies a sender (Chrome: messages from content scripts may be forged by
 * a compromised renderer, so their kind decides what they may ask for).
 *
 * @param sender Chrome's sender.
 * @param identity This extension.
 * @return Sender kind, or null for another extension or an unknown origin.
 */
export function classifySender(
  sender: chrome.runtime.MessageSender,
  identity: SenderIdentity,
): Sender | null {
  if (sender.id !== identity.extensionId) return null;
  const url = sender.url ?? '';
  if (!url.startsWith(identity.origin)) {
    return sender.tab ? 'content-script' : null;
  }
  return url === identity.backgroundUrl ? 'background' : 'extension-page';
}

/**
 * Whether a message is addressed to `target` (cheap pre-check, before
 * validation, so other contexts' messages are left to their own router).
 *
 * @param message Received value.
 * @param target This context.
 * @return True when `message.target === target`.
 */
function addressedTo(message: unknown, target: Target): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as Record<string, unknown>)['target'] === target
  );
}

/**
 * Builds the onMessage listener of a context.
 *
 * @param target This context.
 * @param handlers One handler per message type of the context.
 * @param identity This extension; defaults to chrome.runtime.
 * @return Listener for chrome.runtime.onMessage.addListener.
 */
export function createRouter<T extends Target>(
  target: T,
  handlers: Handlers<T>,
  identity: SenderIdentity = currentIdentity(),
): MessageListener {
  const specs = MESSAGE_SPECS[target] as Readonly<
    Record<string, {readonly allowedFrom: readonly Sender[]}>
  >;
  const table = handlers as unknown as Readonly<
    Record<string, (payload: unknown, context: HandlerContext) => unknown>
  >;

  return (message, sender, sendResponse) => {
    if (!addressedTo(message, target)) return false;
    const reply = (r: Result<unknown>) => {
      sendResponse(r);
      return true;
    };
    const deny = (why: string) =>
      reply({ok: false, error: toWireError(new AppError('DENIED', why))});

    const from = classifySender(sender, identity);
    if (from === null) {
      return deny(`sender ${sender.id ?? '?'} ${sender.url ?? ''} refused`);
    }
    const checked = validateEnvelope(message, target);
    if (!checked.ok) return reply(checked);
    const {type, payload} = checked.data;
    if (!specs[type]!.allowedFrom.includes(from)) {
      return deny(`${type} is not accepted from ${from}`);
    }

    const context: HandlerContext = {sender, from};
    Promise.resolve()
      .then(() => table[type]!(payload, context))
      .then(
        data => sendResponse({ok: true, data}),
        (e: unknown) => sendResponse({ok: false, error: toWireError(e)}),
      );
    return true;
  };
}
