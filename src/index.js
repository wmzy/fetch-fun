import curry from 'lodash/curry';
import compose from './compose';

// eslint-disable-next-line no-restricted-globals
const g = global || window || self;

function toFetchParams(ctx) {
  const { url, ...init } = ctx;
  return [url, { ...init }];
}

export function fetch(context) {
  if (typeof context === 'string') return g.fetch(context);
  const { polyfill, middleware, ...ctx } = context;
  const fetchIt = polyfill || g.fetch;
  if (middleware) {
    return compose(middleware)(ctx)
      .then((fn) => {
        const res = fetchIt(...toFetchParams(ctx));
        if (fn) return fn(res);
        return res;
      });
  }

  return fetchIt(...toFetchParams(ctx));
}

export const use = curry((cb, context) => {
  const middleware = context.middleware || [];
  return { ...context, middleware: [...middleware, cb] };
});
