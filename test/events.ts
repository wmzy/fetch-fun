/**
 * Tests for the `events` SSE reader (`src/events.ts`).
 *
 * Origin: split out of the config/data-reader test surface (test/config.ts)
 * by the events-reader task so parallel work on config tests stays
 * conflict-free. Merge suggestion: these blocks are self-contained and only
 * use the public `@/index` API plus `readSSE` from `@/events`; if the repo
 * later prefers co-locating reader tests, fold the `readSSE` describe blocks
 * into test/config.ts next to the other reader middleware tests.
 */
import { describe, it, expect, expectTypeOf, vi } from 'vitest';
import {
  create,
  url,
  accept,
  events,
  fetchData,
  type SSEEvent,
} from '@/index';
import { readSSE } from '@/events';
import { readDataSymbol } from '@/constants';

const encoder = new TextEncoder();

/**
 * Builds a `Response` whose body streams the given chunks (strings are
 * encoded; pass `Uint8Array`s to split at exact byte offsets, e.g. inside a
 * multibyte character).
 */
function sseResponse(...chunks: (string | Uint8Array)[]): Response {
  const parts = chunks.map((c) => (typeof c === 'string' ? encoder.encode(c) : c));
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });
  return new Response(stream);
}

describe('readSSE framing', () => {
  it('parses a single frame', async () => {
    const res = sseResponse('event: add\ndata: 1\n\n');
    await expect(readSSE(res)).resolves.toEqual([
      { event: 'add', data: '1' },
    ]);
  });

  it('parses multiple frames in order', async () => {
    const res = sseResponse(
      'event: a\ndata: first\n\n',
      'event: b\ndata: second\n\n',
    );
    await expect(readSSE(res)).resolves.toEqual([
      { event: 'a', data: 'first' },
      { event: 'b', data: 'second' },
    ]);
  });

  it('reassembles a frame split across two reads mid-line', async () => {
    const res = sseResponse('event: stre', 'am\ndata: chunked\n\n');
    await expect(readSSE(res)).resolves.toEqual([
      { event: 'stream', data: 'chunked' },
    ]);
  });

  it('reassembles a frame split across a CRLF boundary', async () => {
    // The CRLF pair is split across reads: '\r' arrives alone at the end of
    // chunk 1 (it may be half of '\r\n'), '\n' completes it in chunk 2.
    const res = sseResponse('data: crlf\r', '\n\n');
    await expect(readSSE(res)).resolves.toEqual([
      { event: 'message', data: 'crlf' },
    ]);
  });

  it('parses lone CR separators and blank lines from raw text', async () => {
    // The text() fallback bypasses TextDecoder newline normalization, so
    // this exercises the parser's own \r / \r\n / \r\r handling directly.
    const fake = {
      ok: true,
      body: {},
      text: async () => 'event: cr\rdata: body\r\rdata: tail\r',
    } as unknown as Response;
    await expect(readSSE(fake)).resolves.toEqual([
      { event: 'cr', data: 'body' },
      // trailing '\r' terminates the line and, at stream end, dispatches
      { event: 'message', data: 'tail' },
    ]);
  });

  it('accepts CR-only line endings', async () => {
    const res = sseResponse('event: cr\rdata: body\r\r');
    await expect(readSSE(res)).resolves.toEqual([
      { event: 'cr', data: 'body' },
    ]);
  });

  it('joins multi-line data with \\n', async () => {
    const res = sseResponse('data: l1\ndata: l2\ndata: l3\n\n');
    await expect(readSSE(res)).resolves.toEqual([
      { event: 'message', data: 'l1\nl2\nl3' },
    ]);
  });

  it('strips exactly one space after the field colon', async () => {
    const res = sseResponse('data:   padded\ndata:tight\n\n');
    await expect(readSSE(res)).resolves.toEqual([
      { event: 'message', data: '  padded\ntight' },
    ]);
  });

  it('ignores comment lines, even between fields of a frame', async () => {
    const res = sseResponse(': keep-alive\n: another\ndata: x\n: mid\n\n\n');
    await expect(readSSE(res)).resolves.toEqual([
      { event: 'message', data: 'x' },
    ]);
  });

  it('skips blank lines whose frame accumulated no fields', async () => {
    const res = sseResponse('\n\n\n: comment only\n\n');
    await expect(readSSE(res)).resolves.toEqual([]);
  });

  it('parses id and retry fields; retry becomes a number', async () => {
    const res = sseResponse(
      'id: 42\nevent: tick\nretry: 3000\ndata: d\n\n',
      'id: 43\nretry: not-a-number\ndata: e\n\n',
    );
    await expect(readSSE(res)).resolves.toEqual([
      { event: 'tick', data: 'd', id: '42', retry: 3000 },
      { event: 'message', data: 'e', id: '43' }, // NaN retry dropped
    ]);
  });

  it('defaults event to message; empty event resets to message', async () => {
    const res = sseResponse('data: plain\n\nevent:\ndata: reset\n\n');
    await expect(readSSE(res)).resolves.toEqual([
      { event: 'message', data: 'plain' },
      { event: 'message', data: 'reset' },
    ]);
  });

  it('strips a leading BOM so the first field still parses', async () => {
    const res = sseResponse('\uFEFFdata: bom-safe\n\n');
    await expect(readSSE(res)).resolves.toEqual([
      { event: 'message', data: 'bom-safe' },
    ]);
  });

  it('keeps a BOM that appears mid-stream as data content', async () => {
    const res = sseResponse('data: a\n\ndata: \uFEFFb\n\n');
    await expect(readSSE(res)).resolves.toEqual([
      { event: 'message', data: 'a' },
      { event: 'message', data: '\uFEFFb' },
    ]);
  });

  it('decodes multibyte characters split across reads', async () => {
    const bytes = encoder.encode('data: héllo\n\n');
    // Byte 7 is the first half of the two-byte 'é': split inside it.
    const res = sseResponse(bytes.subarray(0, 8), bytes.subarray(8));
    await expect(readSSE(res)).resolves.toEqual([
      { event: 'message', data: 'héllo' },
    ]);
  });

  it('dispatches a final frame missing its closing blank line', async () => {
    const res = sseResponse('event: tail\ndata: unterminated');
    await expect(readSSE(res)).resolves.toEqual([
      { event: 'tail', data: 'unterminated' },
    ]);
  });

  it('resolves to [] when the body is null (e.g. 204)', async () => {
    const res = new Response(null, { status: 204 });
    await expect(readSSE(res)).resolves.toEqual([]);
  });

  it('falls back to res.text() when the body is not a ReadableStream', async () => {
    const fake = {
      ok: true,
      body: 'opaque-buffered-body',
      text: vi.fn().mockResolvedValue('event: fb\ndata: buffered\n\n'),
    } as unknown as Response;
    await expect(readSSE(fake)).resolves.toEqual([
      { event: 'fb', data: 'buffered' },
    ]);
    expect(fake.text).toHaveBeenCalledOnce();
  });
});

describe('readSSE streaming callback', () => {
  it('calls onEvent per frame, in arrival order, before resolving', async () => {
    const res = sseResponse('data: 1\n\n', ': tick\n', 'data: 2\n\n');
    const seen: SSEEvent[] = [];
    const frames = await readSSE(res, (e) => seen.push(e));
    expect(seen).toEqual([
      { event: 'message', data: '1' },
      { event: 'message', data: '2' },
    ]);
    // The callback saw exactly what the resolved array contains.
    expect(seen).toEqual(frames);
  });

  it('invokes onEvent as frames arrive, before the body completes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const stream = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(encoder.encode('data: early\n\n'));
        await gate; // body stays open: the promise must not resolve yet
        c.enqueue(encoder.encode('data: late\n\n'));
        c.close();
      },
    });
    const seen: SSEEvent[] = [];
    const promise = readSSE(new Response(stream), (e) => seen.push(e));
    // Frame 1 is dispatched while frame 2 is still undelivered.
    await vi.waitFor(() =>
      expect(seen).toEqual([{ event: 'message', data: 'early' }]),
    );
    release();
    await expect(promise).resolves.toHaveLength(2);
    expect(seen[1]).toEqual({ event: 'message', data: 'late' });
  });
});

describe('events config function', () => {
  it('end-to-end: fetchData resolves the SSEEvent[] from a stream response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse('id: 1\nevent: greet\ndata: {"hi":true}\n\n', 'data: bye\n\n'),
    );
    const client = create({ fetch: fetchMock })
      .pipe(url, 'https://api.example.com/stream')
      .pipe(accept, 'text/event-stream')
      .pipe(events)
      .pipe(fetchData);

    await expect(client).resolves.toEqual([
      { event: 'greet', data: '{"hi":true}', id: '1' },
      { event: 'message', data: 'bye' },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get('accept')).toBe('text/event-stream');
  });

  it('streams frames through the onEvent callback', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse('event: a\ndata: 1\n\n', 'event: b\ndata: 2\n\n'),
    );
    const seen: SSEEvent[] = [];
    const frames = await create({ fetch: fetchMock })
      .pipe(url, 'https://api.example.com/stream')
      .pipe(events, (e: SSEEvent) => seen.push(e))
      .pipe(fetchData);

    expect(seen.map((e) => e.event)).toEqual(['a', 'b']);
    expect(frames).toEqual(seen);
  });

  it('type flow: fetchData infers Promise<SSEEvent[]>', () => {
    const viaEvents = () =>
      create()
        .pipe(url, '/u')
        .pipe(events)
        .pipe(fetchData);
    expectTypeOf(viaEvents).returns.resolves.toEqualTypeOf<SSEEvent[]>();
    const withCallback = () =>
      create()
        .pipe(url, '/u')
        .pipe(events, (e: SSEEvent) => void e.data)
        .pipe(fetchData);
    expectTypeOf(withCallback).returns.resolves.toEqualTypeOf<SSEEvent[]>();
  });

  it('is a thin wrapper over data: reader stored under readDataSymbol', async () => {
    const o = events({}, undefined);
    expect(typeof (o as any)[readDataSymbol]).toBe('function');
    const frames = await (o as any)[readDataSymbol](
      sseResponse('data: via-symbol\n\n'),
    );
    expect(frames).toEqual([{ event: 'message', data: 'via-symbol' }]);
  });
});
