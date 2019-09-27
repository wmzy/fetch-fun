export function curry(fn) {
  return (...params) =>
    params.length >= fn.length
      ? fn(...params)
      : curry(fn.bind(null, params[0], ...params.slice(1)));
}

export function toFetchParams({url, baseUrl, query, fetch, ...init}) {
  if (!isAbsoluteUrl(url) && baseUrl) url = baseUrl + url;
  return [url, init];
}

export function pipe(...builders) {
  return builders.reduce(
    (config, builder) =>
      typeof builder === 'function'
        ? builder(config)
        : Object.assign(config, builder),
    {}
  );
}

export function isAbsoluteUrl(url) {
  return /^([a-z][-+.\w]*:)?\/\//i.test(url);
}
