import { json } from './config';
import type { Instance } from './types';
import { getData } from './util';

export function toFetchPrams(o: Instance): [string, RequestInit] {
  const { baseUrl, url, fetch, middlewares, pipe, add, with: w, ...rest } = o;
  return [baseUrl ? `${baseUrl}${url}` : url, rest];
}

export function fetch(o: Instance) {
  const f = o.fetch || globalThis.fetch;
  const middlewares = o.middlewares || [];
  return middlewares.reduce((f, mw) => mw(f, o), f)(...toFetchPrams(o));
}

export function fetchData<T = unknown>(o: Instance): Promise<T> {
  return fetch(o).then(getData<T>);
}

export function fetchJSON<T = unknown>(o: Instance): Promise<T> {
  return fetchData<T>(json(o));
}
