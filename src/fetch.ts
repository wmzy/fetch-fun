import { json } from './config';
import type { Instance } from './types';
import { getData } from './util';

export function toFetchPrams(o: Instance): [string, RequestInit] {
  const { baseUrl, url, fetch, middlewares, pipe, ...rest } = o;
  return [baseUrl ? `${baseUrl}${url}` : url, rest];
}

export function fetch(o: Instance) {
  const f = o.fetch || globalThis.fetch;
  const middlewares = o.middlewares || [];
  return middlewares.reduce((f, mw) => mw(f, o), f)(...toFetchPrams(o));
}

export function fetchJSON<T = unknown>(o: Instance): Promise<T> {
  return fetch(json(o)).then(getData<T>);
}
