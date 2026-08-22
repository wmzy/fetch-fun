import { describe, it, afterEach, vi, expect } from 'vitest';

import * as ff from '@/index';

const example = 'https://example.com';

describe('fetch-fun', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should get an url ok', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    const config = ff.create({ fetch: fetchMock, url: example });
    const res = await ff.fetch(config);
    expect(res.ok).toBe(true);
    expect(fetchMock.mock.lastCall![0]).toBe(example);
  });
});
