// eslint-disable-next-line no-restricted-globals
const {fetch} = global || window || self;

const headers = {
  common: {
    Accept: 'application/json, text/plain, */*'
  }
};

['delete', 'get', 'head'].forEach(function forEachMethodNoData(method) {
  headers[method] = {};
});

['post', 'put', 'patch'].forEach(function forEachMethodWithData(method) {
  headers[method] = {
    'Content-Type': 'application/x-www-form-urlencoded'
  };
});

const defaults = {
  fetch,
  headers,

  xsrfCookieName: 'XSRF-TOKEN',
  xsrfHeaderName: 'X-XSRF-TOKEN'
};

export default defaults;
