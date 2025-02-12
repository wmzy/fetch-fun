import type { Options, Pipe, PipeFn } from './types';

export function create(): Options & Pipe;
export function create(o: null): Options & Pipe;
export function create<T extends Options>(o: T): T & Pipe;
export function create(o?: any): Options & Pipe {
  const pipe: PipeFn = function pipe(action, ...params) {
    return action(this, ...params);
  };

  return {
    ...o,
    pipe,
    add: pipe,
    with: pipe,
  };
}
