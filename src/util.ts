import { dataSymbol } from './constants';

export function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function getData<T = unknown>(res: Response): T {
  return (res as any)[dataSymbol] as T;
}
