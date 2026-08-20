import { afterEach, beforeEach, describe, it, vi, expect } from 'vitest';
import {
  create,
  url,
  fetch,
  fetchJSON,
  json,
  timeout,
  retry,
  withAuth,
  withRetry,
  use,
  method,
  jsonBody,
} from '@/index';
import type { MiddlewareFn } from '../../src/types';
import { getData } from '@/util';

describe('Adapters Integration Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('default fetch (globalThis.fetch)', () => {
    it('should use globalThis.fetch when no adapter provided', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
      vi.stubGlobal('fetch', mockFetch);

      const client = create({
        url: 'https://example.com/test',
      });

      await client.pipe(fetch);

      expect(mockFetch).toHaveBeenCalledWith('https://example.com/test', {});
    });

    it('should work with HTTP request using injected fetch', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));

      const client = create({
        fetch: mockFetch,
        baseUrl: 'https://example.com',
      });

      const response = await client
        .pipe(url, '/get')
        .pipe(fetch);

      expect(response.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith('https://example.com/get', {});
    });
  });

  describe('Node adapter (when implemented)', () => {
    it('should work with Node.js fetch-like API', async () => {
      const mockNodeFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ success: true }),
        text: async () => 'ok',
      });

      const client = create({
        fetch: mockNodeFetch as any,
        url: 'https://example.com/api',
      });

      const response = await client.pipe(fetch);

      expect(mockNodeFetch).toHaveBeenCalled();
    });

    it('should handle Node.js error responses', async () => {
      const mockNodeFetch = vi.fn().mockRejectedValue(
        new Error('ECONNREFUSED')
      );

      const client = create({
        fetch: mockNodeFetch as any,
        url: 'https://example.com/api',
      })
        .pipe(retry, 2);

      await expect(
        client.pipe(fetch)
      ).rejects.toThrow('ECONNREFUSED');
    });

    it('should complete request with timeout using Node-style fetch', async () => {
      const mockNodeFetch = vi.fn().mockResolvedValue(new Response('ok'));

      const client = create({
        fetch: mockNodeFetch as any,
        baseUrl: 'https://example.com',
      })
        .pipe(timeout, 10000);

      const response = await client
        .pipe(url, '/get')
        .pipe(fetch);

      expect(response.ok).toBe(true);
      expect(mockNodeFetch).toHaveBeenCalledTimes(1);
      expect(mockNodeFetch.mock.calls[0]?.[0]).toBe('https://example.com/get');
    });
  });

  describe('Bun adapter (when implemented)', () => {
    it('should work with Bun.fetch API', async () => {
      const mockBunFetch = vi.fn().mockResolvedValue(new Response('ok'));

      const client = create({
        fetch: mockBunFetch as any,
        url: 'https://example.com/api',
      });

      await client.pipe(fetch);

      expect(mockBunFetch).toHaveBeenCalled();
    });

    it('should handle Bun.Response with streaming', async () => {
      const mockBunFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ adapter: 'bun' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const client = create({
        fetch: mockBunFetch as any,
        url: 'https://example.com/api',
      }).pipe(json);

      const result = await client.pipe(fetch);
      const data = getData(result);

      expect(data).toEqual({ adapter: 'bun' });
    });
  });

  describe('Workers adapter (when implemented)', () => {
    it('should work with Cloudflare Workers fetch API', async () => {
      let capturedInit: RequestInit | undefined;
      const mockWorkersFetch = vi.fn().mockImplementation((url, init) => {
        capturedInit = init;
        const authHeader = new Headers(init?.headers).get('Authorization');
        if (!authHeader) {
          return Promise.reject(new Error('Missing Authorization'));
        }
        return Promise.resolve(new Response(JSON.stringify({ worker: true }), {
          headers: { 'Content-Type': 'application/json' },
        }));
      });

      const client = create({
        fetch: mockWorkersFetch as any,
        url: 'https://example.com/worker-endpoint',
      })
        .pipe(use, withAuth('worker-token'))
        .pipe(json);

      const result = await client.pipe(fetch);
      const data = getData(result);

      expect(data).toEqual({ worker: true });
      expect(mockWorkersFetch).toHaveBeenCalledWith(
        'https://example.com/worker-endpoint',
        capturedInit
      );
      expect(
        new Headers(capturedInit?.headers).get('Authorization')
      ).toBe('Bearer worker-token');
    });

    it('should handle Workers-specific errors', async () => {
      const mockWorkersFetch = vi.fn().mockRejectedValue(
        new Error('Workers Fetch Error: Request failed')
      );

      const client = create({
        fetch: mockWorkersFetch as any,
        url: 'https://example.com/failed',
      })
        .pipe(retry, 1);

      await expect(
        client.pipe(fetch)
      ).rejects.toThrow('Workers Fetch Error');
    });
  });

  describe('adapter compatibility with middlewares', () => {
    it('should work with retry middleware across all adapters', async () => {
      const mockFetch = vi.fn()
        .mockRejectedValueOnce(new Error('Temporary failure'))
        .mockResolvedValueOnce(new Response('success'));

      const client = create({
        fetch: mockFetch,
        url: 'https://example.com/retry',
      })
        .pipe(retry, 3)
        .pipe(timeout, 5000);

      const response = await client.pipe(fetch);

      expect(response).toBeInstanceOf(Response);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should work with auth middleware across all adapters', async () => {
      let capturedHeaders = new Headers();
      const mockFetch = vi.fn().mockImplementation((_, init) => {
        capturedHeaders = new Headers(init?.headers);
        return Promise.resolve(new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        }));
      });

      const client = create({
        fetch: mockFetch,
        url: 'https://example.com/auth',
      })
        .pipe(use, withAuth('test-token-123'))
        .pipe(json);

      await client.pipe(fetch);

      expect(capturedHeaders.get('Authorization')).toBe('Bearer test-token-123');
    });

    it('should reject fetch when middlewares form a dependency cycle', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
      const passthrough: MiddlewareFn = (f) => f;

      const client = create({
        fetch: mockFetch,
        url: 'https://example.com/cycle',
      })
        .pipe(use, { name: 'a', outer: 'b', middleware: passthrough })
        .pipe(use, { name: 'b', outer: 'a', middleware: passthrough });

      await expect(async () => client.pipe(fetch)).rejects.toThrow(/cycle/i);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should reject fetch when duplicate middleware names are registered', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));

      const client = create({
        fetch: mockFetch,
        url: 'https://example.com/duplicate',
      })
        .pipe(use, withRetry(3))
        .pipe(use, withRetry(3));

      await expect(async () => client.pipe(fetch)).rejects.toThrow(
        /Duplicate middleware name "builtin:retry"/
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should handle adapter that returns non-Response object', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        data: { custom: 'format' },
      });

      const client = create({
        fetch: mockFetch as any,
        url: 'https://example.com/custom',
      });

      const response = await client.pipe(fetch);

      expect(response).toHaveProperty('ok', true);
      expect(response).toHaveProperty('data', { custom: 'format' });
    });
  });

  describe('adapter request tests (mocked fetch)', () => {
    it('should make GET request', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, { status: 200, statusText: 'OK' })
      );

      const client = create({
        fetch: mockFetch,
        baseUrl: 'https://example.com',
      })
        .pipe(timeout, 10000);

      const response = await client
        .pipe(url, '/get')
        .pipe(fetch);

      expect(response.ok).toBe(true);
      expect(response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0]?.[0]).toBe('https://example.com/get');
    });

    it('should make POST request', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, { status: 200, statusText: 'OK' })
      );

      const client = create({
        fetch: mockFetch,
        baseUrl: 'https://example.com',
      })
        .pipe(timeout, 10000);

      const response = await client
        .pipe(url, '/post')
        .pipe(method, 'POST')
        .pipe(fetch);

      expect(response.ok).toBe(true);
      expect(response.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/post',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('should send headers correctly', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, { status: 200, statusText: 'OK' })
      );

      const client = create({
        fetch: mockFetch,
        baseUrl: 'https://example.com',
        headers: { Authorization: 'Bearer abc123', 'X-Custom': 'yes' },
      })
        .pipe(timeout, 10000);

      const response = await client
        .pipe(url, '/headers')
        .pipe(fetch);

      expect(response.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/headers',
        expect.objectContaining({
          headers: { Authorization: 'Bearer abc123', 'X-Custom': 'yes' },
        })
      );
    });

    it('should handle JSON response', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ hello: 'world' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const result = await create({
        fetch: mockFetch,
        baseUrl: 'https://example.com',
      })
        .pipe(timeout, 10000)
        .pipe(url, '/get')
        .pipe(fetchJSON);

      expect(result).toEqual({ hello: 'world' });
    });

    it('should ignore baseUrl when url is absolute', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));

      await create({
        fetch: mockFetch,
        baseUrl: 'https://example.com/v1/',
      })
        .pipe(timeout, 10000)
        .pipe(url, 'https://other.example.com/api/data')
        .pipe(fetch);

      expect(mockFetch.mock.calls[0]?.[0]).toBe('https://other.example.com/api/data');
    });

    it('should normalize duplicate slashes between baseUrl and url', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));

      await create({
        fetch: mockFetch,
        baseUrl: 'https://example.com/v1/',
      })
        .pipe(timeout, 10000)
        .pipe(url, '/users')
        .pipe(fetch);

      expect(mockFetch.mock.calls[0]?.[0]).toBe('https://example.com/v1/users');
    });

    it('json() should not send a Content-Type request header', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ hello: 'world' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const result = await create({
        fetch: mockFetch,
        baseUrl: 'https://example.com',
      })
        .pipe(timeout, 10000)
        .pipe(url, '/get')
        .pipe(json)
        .pipe(fetchJSON);

      expect(result).toEqual({ hello: 'world' });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0]?.[1]?.headers).toBeUndefined();
    });

    it('jsonBody() should set Content-Type and JSON body', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));

      await create({
        fetch: mockFetch,
        baseUrl: 'https://example.com',
      })
        .pipe(timeout, 10000)
        .pipe(url, '/post')
        .pipe(method, 'POST')
        .pipe(jsonBody, { name: 'John' })
        .pipe(fetch);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/post',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{"name":"John"}',
        })
      );
    });
  });
});
