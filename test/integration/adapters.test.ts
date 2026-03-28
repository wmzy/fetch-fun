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
  use,
  method,
} from '@/index';
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

    it('should work with real HTTP request to httpbin.org', async () => {
      const client = create({
        baseUrl: 'https://httpbin.org',
      });

      const response = await client
        .pipe(url, '/get')
        .pipe(fetch);

      expect(response.ok).toBe(true);
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

    it('should make real HTTP request using Node adapter', { timeout: 15000 }, async () => {
      const client = create({
        baseUrl: 'https://httpbin.org',
      })
        .pipe(timeout, 10000);

      const response = await client
        .pipe(url, '/get')
        .pipe(fetch);

      expect(response.ok).toBe(true);
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
      const mockWorkersFetch = vi.fn().mockImplementation((url, init) => {
        const authHeader = (init?.headers as Record<string, string>)?.Authorization;
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
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer worker-token',
          }),
        })
      );
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
      let capturedHeaders: Record<string, string> = {};
      const mockFetch = vi.fn().mockImplementation((_, init) => {
        capturedHeaders = (init?.headers as Record<string, string>) || {};
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

      expect(capturedHeaders.Authorization).toBe('Bearer test-token-123');
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

  describe('real adapter tests', () => {
    it('should make real GET request', { timeout: 15000 }, async () => {
      const client = create({
        baseUrl: 'https://httpbin.org',
      })
        .pipe(timeout, 10000);

      const response = await client
        .pipe(url, '/get')
        .pipe(fetch);

      expect(response.ok).toBe(true);
      expect(response.status).toBe(200);
    });

    it('should make real POST request', { timeout: 15000 }, async () => {
      const client = create({
        baseUrl: 'https://httpbin.org',
      })
        .pipe(timeout, 10000);

      const response = await client
        .pipe(url, '/post')
        .pipe(method, 'POST')
        .pipe(fetch);

      expect(response.ok).toBe(true);
      expect(response.status).toBe(200);
    });

    it('should send headers correctly', { timeout: 15000 }, async () => {
      const client = create({
        baseUrl: 'https://httpbin.org',
      })
        .pipe(timeout, 10000);

      const response = await client
        .pipe(url, '/headers')
        .pipe(fetch);

      expect(response.ok).toBe(true);
    });

    it('should handle JSON response', { timeout: 15000 }, async () => {
      const result = await create({
        baseUrl: 'https://httpbin.org',
      })
        .pipe(timeout, 10000)
        .pipe(url, '/get')
        .pipe(fetchJSON);

      expect(result).toBeDefined();
    });
  });
});
