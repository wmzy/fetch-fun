import defaultTo from './default-config';
import {url, jsonBody} from './config-build';
import {toFetchParams, pipe} from './util';

export default function create(defaultConfig) {
  function request(...configs) {
    const config = defaultTo(pipe(...configs), defaultConfig);
    const fetch = config.middleware
      ? config.middleware(config.fetch)
      : config.fetch;
    return fetch(...toFetchParams(config)).then(res => {
      if (res.ok) return res;
      const error = new Error('error status');
      error.response = res;
      throw error;
    });
  }

  ['get', 'head', 'delete', 'options'].forEach(method => {
    request[method] = (u, ...config) => request(...config, url(u), {method});
  });

  ['post', 'put', 'patch'].forEach(method => {
    request[method] = (u, data, ...config) => {
      return request(
        ...config,
        url(u),
        typeof data === 'function' ? data : jsonBody(data),
        {method}
      );
    };
  });

  return request;
}
