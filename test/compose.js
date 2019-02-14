import compose from '../src/compose';

describe('compose', () => {
  it('should handle empty array success', async () => {
    const ctx = {};
    await compose([])(ctx).should.be.Promise();
    ctx.should.be.eql({});
  });

  it('should compose middleware without back function success', async () => {
    const ctx = {};
    await compose([
      (c) => { c.foo = 1; c.bar = 1; },
      (c) => { c.foo = 2; },
    ])(ctx).should.be.fulfilledWith(undefined);
    ctx.should.be.eql({ foo: 2, bar: 1 });
  });

  it('should compose middleware with back function success', async () => {
    const ctx = {};
    const backFn = await compose([
      (c) => { c.foo = 1; c.bar = 1; return r => `${r}c`; },
      (c) => { c.foo = 3; },
      () => r => `${r}b`,
      (c) => { c.foo = 2; },
    ])(ctx);
    ctx.should.be.eql({ foo: 2, bar: 1 });
    await backFn('a').should.be.fulfilledWith('abc');
  });

  it('could be stop in middleware', async () => {
    const ctx = {};
    const backFn = await compose([
      (c) => { c.foo = 1; c.bar = 1; return r => `${r}c`; },
      (c) => { c.foo = 3; return true; },
      () => r => `${r}b`,
      (c) => { c.foo = 2; },
    ])(ctx);
    ctx.should.be.eql({ foo: 3, bar: 1 });
    await backFn('a').should.be.fulfilledWith('ac');
  });
});
