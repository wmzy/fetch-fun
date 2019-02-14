import curry from 'lodash/curry';

export const setUrl = curry((url, context) => ({ ...context, url }));

export const url = curry((to, context) => {
  if (/(https?:)?\/\//.test(to)) return setUrl(to, context);
  return setUrl((context.url || '') + to, context);
});

export const setQuery = curry((queryObject, context) => ({ ...context, query: queryObject }));

export const query = curry((queryObject, context) => {
  const q = context.query || {};
  return setQuery({ ...q, queryObject }, context);
});

export const setHeaders = curry((headers, context) => ({ ...context, headers }));

export const headers = curry((headersObject, context) => {
  const h = context.headers || {};
  return setQuery({ ...h, headersObject }, context);
});

export const header = curry((name, value, context) => {
  const h = context.headers || {};
  return setQuery({ ...h, [name]: value }, context);
});

export const accept = header('Accept');
export const auth = header('Authorization');

export const body = curry((bodyValue, context) => ({ ...context, body: bodyValue }));

export const method = curry((httpMethod, context) => ({ ...context, method: httpMethod }));
