import { createRetry } from './middleware';
import type { Method, Middleware, Options } from './types';
import { dataSymbol } from './constants';

export function method<T extends Options, M extends Method>(
  o: T,
  method: M
): T & { method: M } {
  return {
    ...o,
    method,
  };
}

export function url<T extends Options, U extends string>(
  o: T,
  url: U
): T & { url: U } {
  return {
    ...o,
    url,
  };
}

export function appendUrl<
  const T extends Options & { url: string },
  U extends string,
>(o: T, to: U): Omit<T, 'url'> & { url: `${T['url']}${U}` } {
  return url(o, `${o.url}${to}`);
}

export function baseUrl<T extends Options, U extends string>(
  o: T,
  baseUrl: U
): T & { baseUrl: U } {
  return {
    ...o,
    baseUrl,
  };
}

export function headers<T extends Options, H extends Record<string, string>>(
  o: T,
  headers: H
): Omit<T, 'headers'> & {
  headers: H;
} {
  return {
    ...o,
    headers,
  };
}

export function header<T extends Options, K extends string, V extends string>(
  o: T,
  k: K,
  v: V
): Omit<T, 'headers'> & {
  headers: Record<K, V>;
};
export function header<
  H extends Record<string, string>,
  T extends Options & { headers: H },
  K extends string,
  V extends string,
>(
  o: T,
  k: K,
  v: V
): Omit<T, 'headers'> & {
  headers: H & Record<K, V>;
} {
  return {
    ...o,
    headers: {
      ...o.headers,
      [k]: v,
    },
  };
}

export function accept<T extends Options>(o: T, mime: string) {
  return header(o, 'Accept', mime);
}

export function auth<T extends Options>(
  o: T,
  type: 'Basic' | 'Bearer' | 'Digest' | string,
  credentials: string
) {
  return header(o, 'Authorization', `${type} ${credentials}`);
}

export function contentType<T extends Options>(o: T, type: string) {
  return header(o, 'Content-Type', type);
}

export function middlewares<T extends Options>(
  o: T,
  newMiddlewares: Middleware[]
): T & {
  middlewares: Middleware[];
} {
  return {
    ...o,
    middlewares: newMiddlewares,
  };
}

export function use<T extends Options>(
  o: T,
  middleware: Middleware
): T & {
  middlewares: Middleware[];
} {
  return {
    ...o,
    middlewares: [...(o.middlewares || []), middleware],
  };
}

export function retry<T extends Options>(o: T, maxRetries: number) {
  return use(o, createRetry(maxRetries));
}

export function mapResponse<T extends Options>(
  o: T,
  mapper: (res: Response) => Response | Promise<Response>
) {
  return use(o, (f) => (params) => f(params).then(mapper));
}

export function error<T extends Options>(
  o: T,
  checkError: (res: Response) => void | Promise<void>
) {
  return mapResponse(o, async (res) => {
    await checkError(res);
    return res;
  });
}

export function data<T extends Options>(
  o: T,
  getter: (res: Response) => unknown
) {
  return mapResponse(o, async (res) => {
    const data = await getter(res);
    return { ...res, [dataSymbol]: data };
  });
}

export function json<T extends Options>(o: T) {
  return data(o, (res) => res.json());
}

export function text<T extends Options>(o: T) {
  return data(o, (res) => res.text());
}

export function blob<T extends Options>(o: T) {
  return data(o, (res) => res.blob());
}
