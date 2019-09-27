import {curry, isAbsoluteUrl} from './util';

const set = curry((key, value, config) => ({...config, [key]: value}));

export const baseUrl = set('baseUrl');

export const setUrl = set('url');

export const url = curry((to, config) =>
  setUrl(
    isAbsoluteUrl(to) || to.startsWith('/') ? to : (config.url || '') + to,
    config
  )
);

export const setQuery = set('query');

export const query = curry((queryObject, config) => {
  const q = config.query || {};
  return setQuery({...q, queryObject}, config);
});

export const method = set('method');

// header helpers

export const setHeaders = set('headers');

export const headers = curry((headersObject, config) => {
  const h = config.headers || {};
  return setQuery({...h, headersObject}, config);
});

export const header = curry((name, value, config) => {
  const h = config.headers || {};
  return setQuery({...h, [name]: value}, config);
});

export const accept = header('Accept');
export const auth = header('Authorization');

export const contentType = header('Content-Type');

// body helpers

export const body = set('body');

export const jsonBody = curry((obj, config) =>
  contentType(
    'application/json;charset=utf-8',
    body(JSON.stringify(obj), config)
  )
);
