import { json } from './config';
import type { Fetchable, Pipe } from './types';
import { getData } from './util';

export function toFetchPrams(o: Fetchable): [string, RequestInit] {
  const {
    baseUrl,
    url,
    fetch,
    middlewares,
    pipe,
    add,
    with: w,
    ...rest
  } = o as Fetchable & Pipe;
  return [baseUrl ? `${baseUrl}${url}` : url, rest];
}

export function applyMiddlewares(f: typeof globalThis.fetch, o: Fetchable) {
  const middlewares = o.middlewares || [];
  return middlewares.reduce((f, mw) => mw(f, o), f);
}

export function fetch(o: Fetchable) {
  const f = o.fetch || globalThis.fetch;
  return applyMiddlewares(f, o)(...toFetchPrams(o));
}

export function fetchData<T = unknown>(o: Fetchable): Promise<T> {
  return fetch(o).then(getData<T>);
}

export function fetchJSON<T = unknown>(o: Fetchable): Promise<T> {
  return fetchData<T>(json(o));
}
