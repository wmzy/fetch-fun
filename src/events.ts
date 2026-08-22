import type { MiddlewareEntry, Options } from './types';

import { readDataSymbol } from './constants';
import { data } from './config';

/**
 * A single parsed Server-Sent Events frame.
 */
export type SSEEvent = {
  /** Event type; `'message'` when the frame carries no `event:` field. */
  event: string;
  /** Frame payload; multiple `data:` lines are joined with `\n`. */
  data: string;
  /** `id:` field value, when the frame carried one. */
  id?: string;
  /** `retry:` field converted to a number, when present and numeric. */
  retry?: number;
};

/**
 * Incremental Server-Sent Events framing parser: decoded chunk text in,
 * complete frames out.
 *
 * Kept as a standalone factory so the wire format can be tested without a
 * `Response`: `push()` accepts chunk text at any split point (mid-line,
 * mid-`\r\n`, even mid-multibyte once decoded), and `end()` closes the
 * stream, processing the trailing line and dispatching any final frame that
 * never received its closing blank line — no bytes are silently dropped.
 */
function createSSEParser(onEvent: (e: SSEEvent) => void) {
  let event = 'message';
  let dataLines: string[] = [];
  let id: string | undefined;
  let retry: number | undefined;
  let hasField = false;
  let pending = ''; // partial line carried across chunks
  let atStart = true; // a single leading BOM is stripped at stream start

  /** Dispatch the accumulated frame and reset for the next one. */
  const dispatch = () => {
    const frame: SSEEvent = { event, data: dataLines.join('\n') };
    if (id !== undefined) frame.id = id;
    if (retry !== undefined) frame.retry = retry;
    onEvent(frame);
    event = 'message';
    dataLines = [];
    id = undefined;
    retry = undefined;
    hasField = false;
  };

  /** Apply one line (terminators already stripped) to the frame state. */
  const consumeLine = (raw: string) => {
    if (raw === '') {
      // Blank line: dispatch the accumulated frame, unless it never
      // received any recognized field (bare comment lines, stray blanks).
      if (hasField) dispatch();
      return;
    }
    if (raw.charCodeAt(0) === 0x3a /* ':' */) return; // comment / keep-alive
    const colon = raw.indexOf(':');
    const field = colon === -1 ? raw : raw.slice(0, colon);
    const value = colon === -1 ? '' : raw.slice(colon + 1);
    // Strip a single leading space after the colon (`data: x` vs `data:x`).
    const trimmed =
      value.charCodeAt(0) === 0x20 ? value.slice(1) : value;
    switch (field) {
      case 'data':
        dataLines.push(trimmed);
        hasField = true;
        break;
      case 'event':
        // An empty value resets to the default type.
        event = trimmed || 'message';
        hasField = true;
        break;
      case 'id':
        id = trimmed;
        hasField = true;
        break;
      case 'retry': {
        const n = Number(trimmed);
        if (!Number.isNaN(n)) {
          retry = n;
          hasField = true;
        } // non-numeric retry: field dropped
        break;
      }
    }
  };

  return {
    /** Feed decoded chunk text; line breaks may arrive split across calls. */
    push(chunk: string): void {
      if (atStart) {
        if (chunk === '') return;
        atStart = false;
        if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
      }
      const buf = pending + chunk;
      pending = '';
      let lineStart = 0;
      for (let i = 0; i < buf.length; i++) {
        const c = buf.charCodeAt(i);
        if (c === 0x0a /* '\n' */) {
          consumeLine(buf.slice(lineStart, i));
          lineStart = i + 1;
        } else if (c === 0x0d /* '\r' */) {
          if (i === buf.length - 1) break; // may be half of a pending '\r\n'
          consumeLine(buf.slice(lineStart, i));
          if (buf.charCodeAt(i + 1) === 0x0a) i++; // swallow '\n' of '\r\n'
          lineStart = i + 1;
        }
      }
      pending = buf.slice(lineStart);
    },

    /** Close the stream: flush the trailing line and any pending frame. */
    end(): void {
      if (pending !== '') {
        // A held-back trailing '\r' was a complete terminator (its line was
        // already consumed, so this is a blank line); any other remainder is
        // a final line the server never terminated.
        consumeLine(pending.endsWith('\r') ? pending.slice(0, -1) : pending);
        pending = '';
      }
      if (hasField) dispatch();
    },
  };
}

/**
 * Reads a `Response` body as a Server-Sent Events stream.
 *
 * Each frame is passed to `onEvent` the moment its terminating blank line
 * arrives (streaming), and the returned promise resolves to every frame once
 * the body is fully consumed — preserving fetchData's buffer-then-resolve
 * contract while exposing stream liveness through the callback.
 *
 * Wire format handled:
 * - a single leading UTF-8 BOM is stripped; `\r\n`, `\n` and `\r` end lines;
 * - `:`-prefixed comment/keep-alive lines are ignored;
 * - multiple `data:` lines join with `\n`; `event:` defaults to `'message'`;
 * - `id:` is kept as a string, `retry:` converted to a number and dropped
 *   when non-numeric; blank lines dispatch frames that had at least one
 *   recognized field;
 * - a final frame missing its closing blank line is dispatched at stream end.
 *
 * A `null` body (e.g. 204) resolves to `[]`; a body without `getReader`
 * (environments that pre-buffer the body) falls back to parsing the buffered
 * `res.text()` with the same parser.
 */
export async function readSSE(
  res: Response,
  onEvent?: (e: SSEEvent) => void,
): Promise<SSEEvent[]> {
  const frames: SSEEvent[] = [];
  const parser = createSSEParser((frame) => {
    frames.push(frame);
    onEvent?.(frame);
  });

  const body = res.body;
  if (body == null) {
    // No body to frame (e.g. 204): nothing to parse, nothing to dispatch.
  } else if (
    typeof (body as ReadableStream<Uint8Array>).getReader !== 'function'
  ) {
    parser.push(await res.text());
  } else {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode()); // flush any partial multibyte sequence
  }
  parser.end();
  return frames;
}

/**
 * Adds a Server-Sent Events reader for `text/event-stream` responses:
 * `fetchData` resolves to the parsed `SSEEvent[]` once the stream ends,
 * while `onEvent` receives each frame the moment it arrives on the wire.
 *
 * Structurally a thin wrapper over {@link data} — the same reader middleware
 * semantics apply (non-2xx responses still throw `HTTPError` with the framed
 * body attached as `HTTPError.data`). Reconnection policy stays with the
 * caller: see docs/recipes.md for the Last-Event-ID reconnect loop that
 * pairs with this reader.
 *
 * @example
 * ```ts
 * client
 *   .pipe(accept, 'text/event-stream')
 *   .pipe(events, (e: SSEEvent) => console.log(e.event, e.data))
 *   .pipe(fetchData); // Promise<SSEEvent[]> — every frame, once complete
 * ```
 *
 * @param o - The options object to modify
 * @param onEvent - Optional streaming callback invoked per dispatched frame;
 *   when passed through `pipe`, annotate its parameter (`(e: SSEEvent) => …`),
 *   as with `json`'s parser argument, so the generic pipe overload applies.
 * @returns A new options object whose reader resolves to `SSEEvent[]`
 */
export function events<T extends Options>(
  o: T,
  onEvent?: (e: SSEEvent) => void,
): T & {
  middlewares: [MiddlewareEntry, ...MiddlewareEntry[]];
  [readDataSymbol]: (res: Response) => Promise<SSEEvent[]>;
} {
  return data(o, (res: Response) => readSSE(res, onEvent));
}
