import { describe, it, vi, afterEach } from 'vitest';
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
});
