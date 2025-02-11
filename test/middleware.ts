import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import { retry, create, url, fetch } from '@/index';
import { Middleware } from '../src/types';

describe('Middleware Tests', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should retry the specified number of times', async () => {
    // vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1 });
    const mockFetch = vi.fn().mockRejectedValue(new Error('Test Error'));
    const client = create({ fetch: mockFetch }).pipe(retry, 3);

    vi.runAllTimersAsync();

    await client
      .pipe(url, 'https://example.com')
      .pipe(fetch)
      .should.rejects.to.throw('Test Error' as any);

    mockFetch.mock.calls.length.should.be.equal(4);
  });

  it('should not retry if the function succeeds', async () => {
    const mockFetch = vi.fn().mockResolvedValue('Success');
    const client = create({ fetch: mockFetch }).pipe(retry, 3);
    await client.pipe(url, 'https://example.com').pipe(fetch);

    mockFetch.mock.calls.length.should.be.equal(1);
  });
});
