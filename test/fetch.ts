import { describe, it, vi, afterEach, expect } from 'vitest';
import * as ff from '@/index';

describe('Fetch Tests', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should call fetch with correct parameters', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('Success'));
    const instance = ff.create({
      baseUrl: 'https://example.com', 
      url: '/test',
      fetch: mockFetch,
    });

    await ff.fetch(instance);

    mockFetch.should.toHaveBeenCalledWith('https://example.com/test', {});
  });

  it('should use globalThis.fetch when no fetch provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('Success'));
    vi.stubGlobal('fetch', mockFetch);

    const instance = ff.create({
      url: '/test',
    });

    await ff.fetch(instance);

    mockFetch.should.toHaveBeenCalledWith('/test', {});
  });

  it('should call fetchJSON and return parsed JSON', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: 'test' })));
    const instance = ff.create({
      url: '/test',
      fetch: mockFetch,
    });

    const result = await ff.fetchJSON(instance);

    result!.should.be.eql({ data: 'test' });
  });

  it('should apply middlewares correctly', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('Success'));
    const mockMiddleware = vi.fn((next) => (url: string, init: RequestInit) => next(url, init));
    const instance = ff.create({
      url: '/test',
      fetch: mockFetch,
    }).pipe(ff.use, mockMiddleware as any);

    await ff.fetch(instance);

    mockFetch.should.toHaveBeenCalledWith('/test', {});
  });

  it('should append searchParams to URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('Success'));
    const instance = ff.create({
      url: '/test',
      fetch: mockFetch,
    }).pipe(ff.query, 'page=1&limit=10');

    await ff.fetch(instance);

    mockFetch.should.toHaveBeenCalledWith('/test?page=1&limit=10', {});
  });

  it('should append searchParams to URL with existing query string', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('Success'));
    const instance = ff.create({
      url: '/test?existing=value',
      fetch: mockFetch,
    }).pipe(ff.query, 'page=1');

    await ff.fetch(instance);

    mockFetch.should.toHaveBeenCalledWith('/test?existing=value&page=1', {});
  });

  it('should combine baseUrl, url, and searchParams', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('Success'));
    const instance = ff.create({
      baseUrl: 'https://api.example.com',
      url: '/users',
      fetch: mockFetch,
    }).pipe(ff.query, 'page=1');

    await ff.fetch(instance);

    mockFetch.should.toHaveBeenCalledWith('https://api.example.com/users?page=1', {});
  });

  it('should not append empty searchParams', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('Success'));
    const instance = ff.create({
      url: '/test',
      fetch: mockFetch,
      searchParams: new URLSearchParams(),
    });

    await ff.fetch(instance);

    mockFetch.should.toHaveBeenCalledWith('/test', {});
  });

  it('should map HTTPError through mapError before throwing', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response('Not Found', { status: 404 }));
    class ApiError extends Error {
      constructor(
        public status: number,
        public original: unknown
      ) {
        super(`api error ${status}`);
      }
    }
    const instance = ff
      .create({ url: '/test', fetch: mockFetch })
      .pipe(ff.json)
      .pipe(
        ff.mapError,
        (e: unknown, ctx: ff.MapErrorContext) =>
          new ApiError(ctx.response?.status ?? 0, e)
      );

    let caught: unknown;
    try {
      await ff.fetchData(instance);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).not.toBeInstanceOf(ff.HTTPError);
    expect((caught as ApiError).status).toBe(404);
    expect((caught as ApiError).original).toBeInstanceOf(ff.HTTPError);
  });

  it('should map NetworkError through mapError too', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const instance = ff
      .create({ url: '/test', fetch: mockFetch })
      .pipe(
        ff.mapError,
        (e: unknown, ctx: ff.MapErrorContext) => {
          expect(e).toBeInstanceOf(ff.NetworkError);
          expect(ctx.response).toBeUndefined();
          return new Error('mapped network failure');
        }
      );

    await expect(ff.fetchData(instance)).rejects.toThrow(
      'mapped network failure'
    );
  });

  it('should throw HTTPError unchanged when no mapError is configured', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response('Not Found', { status: 404 }));
    const instance = ff
      .create({ url: '/test', fetch: mockFetch })
      .pipe(ff.json);

    await expect(ff.fetchData(instance)).rejects.toBeInstanceOf(ff.HTTPError);
  });

  it('should await an async mapError mapper', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response('Server Error', { status: 500 }));
    const instance = ff
      .create({ url: '/test', fetch: mockFetch })
      .pipe(
        ff.mapError,
        async (e: unknown) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return new Error('mapped after a tick', { cause: e });
        }
      );

    await expect(ff.fetchData(instance)).rejects.toThrow(
      'mapped after a tick'
    );
  });

  it('should keep retry decisions on the original error when mapError is piped', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 })
      );
    const seen: { attempt: number; error?: unknown }[] = [];
    const instance = ff
      .create({ url: '/test', fetch: mockFetch })
      .pipe(ff.retry, 2, {
        delay: { initial: 1 },
        shouldRetry: (attempt, result) => {
          seen.push({ attempt, error: result.error });
          return true;
        },
      })
      .pipe(ff.checkError, (res) => {
        if (!res.ok) throw new ff.HTTPError(res);
      })
      .pipe(
        ff.mapError,
        () => new Error('never reached: the request eventually succeeded')
      );

    const result = await ff.fetchJSON(instance);
    expect(result).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    // The predicate consulted the ORIGINAL HTTPError instances (503) —
    // mapped values never leak into retry decisions.
    expect(seen.map((s) => s.attempt)).toEqual([0, 1]);
    for (const { error } of seen) {
      expect(error).toBeInstanceOf(ff.HTTPError);
      expect((error as ff.HTTPError).response.status).toBe(503);
    }
  });

  it('should pass protocol-relative URLs through untouched with baseUrl', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('Success'));
    const instance = ff.create({
      baseUrl: 'https://api.example.com/v1',
      url: '//cdn.example.com/x',
      fetch: mockFetch,
    });

    await ff.fetch(instance);

    expect(mockFetch).toHaveBeenCalledWith('//cdn.example.com/x', {});
  });

  it('should pass protocol-relative URLs through untouched without baseUrl', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('Success'));
    const instance = ff.create({
      url: '//cdn.example.com/x',
      fetch: mockFetch,
    });

    await ff.fetch(instance);

    expect(mockFetch).toHaveBeenCalledWith('//cdn.example.com/x', {});
  });

  it('should not throw HTTPError for opaque responses', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 0, type: 'opaque' } as Response);
    const instance = ff.create({
      url: 'https://example.com/no-cors',
      fetch: mockFetch,
    });

    // status 0 / ok:false but not an error — aligns with ky 2.0 semantics.
    await expect(ff.fetchData(instance)).resolves.toBeUndefined();
  });

  it('should resolve undefined for opaque responses with a json reader', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 0, type: 'opaque' } as Response);
    const instance = ff
      .create({ url: 'https://example.com/no-cors', fetch: mockFetch })
      .pipe(ff.json);

    // The unreadable opaque body degrades to undefined in the reader's
    // non-2xx try/catch — no HTTPError, no reader error.
    await expect(ff.fetchData(instance)).resolves.toBeUndefined();
  });

  it('should preserve ../ segments as literal path parts when joining', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('Success'));
    const instance = ff.create({
      baseUrl: 'https://api.example.com/base/',
      url: '../x',
      fetch: mockFetch,
    });

    await ff.fetch(instance);

    // joinUrl is slash normalization, not URL resolution: `../` is kept
    // verbatim for the server to interpret.
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/base/../x',
      {}
    );
  });

  it('should still join plain relative paths and bypass baseUrl for absolute URLs', async () => {
    const relative = vi.fn().mockResolvedValue(new Response('Success'));
    await ff.fetch(
      ff.create({
        baseUrl: 'https://api.example.com/v1',
        url: '/users',
        fetch: relative,
      })
    );
    expect(relative).toHaveBeenCalledWith('https://api.example.com/v1/users', {});

    const absolute = vi.fn().mockResolvedValue(new Response('Success'));
    await ff.fetch(
      ff.create({
        baseUrl: 'https://api.example.com/v1',
        url: 'https://other.example.com/y',
        fetch: absolute,
      })
    );
    expect(absolute).toHaveBeenCalledWith('https://other.example.com/y', {});
  });
});
