export type Method = 'POST' | 'GET' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD';

export type Middleware = (f: typeof fetch, instance: Fetchable) => typeof fetch;

export type Options = Omit<RequestInit, 'headers'> & {
  headers?: Record<string, string>;
  url?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  middlewares?: Middleware[];
};

export type PipeFn = <T extends Pipe, const P extends any[], R>(
  this: T,
  action: (o: T, ...p: P) => R,
  ...params: P
) => R;

export type Pipe = {
  pipe: PipeFn;
  /**
   * @alias pipe
   */
  add: PipeFn;
  /**
   * @alias pipe
   */
  with: PipeFn;
};

export type Client = Options & Pipe;
export type Fetchable = { url: string } & Options;
