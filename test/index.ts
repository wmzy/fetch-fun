import { describe, it, beforeEach, afterEach, vi } from 'vitest';
import * as ff from '@/index';

const example = 'https://example.com';

describe('fetch-fun', () => {
  beforeEach(() => {
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should get an url ok', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    const config = ff.create({ fetch: fetchMock, url: example });
    const res = await ff.fetch(config);
    res.ok.should.be.true;
    fetchMock.mock.lastCall![0].should.be.equal(example);
  });
});
