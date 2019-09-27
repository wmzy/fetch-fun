import {curry} from './util';

export default curry(function use(middleware, config) {
  if (!config) return {middleware};

  const m = config.middleware;
  return {
    ...config,
    middleware: m ? next => m(middleware(next)) : middleware
  };
});
