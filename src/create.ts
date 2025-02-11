import type { Options, Pipe } from './types';

export function create(): Options & Pipe;
export function create(o: null): Options & Pipe;
export function create<T extends Options>(o: T): T & Pipe;
export function create(o?: any): Options & Pipe {
  return {
    ...o,
    pipe(action, ...params) {
      return action(this, ...params);
    },
  };
}
