export type Method = 'POST' | 'GET' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD';

export type Middleware = (f: typeof fetch, instance: Instance) => typeof fetch;

export type Options = Omit<RequestInit, 'headers'> & {
  headers?: Record<string, string>;
  url?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  middlewares?: Middleware[];
};

export type Pipe = {
  pipe: <T extends Pipe, const P extends any[], R>(
    this: T,
    action: (o: T, ...p: P) => R,
    ...params: P
  ) => R;
};

export type Instance = { url: string } & Options & Pipe;
