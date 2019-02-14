import curry from 'lodash/curry';

export const response = curry((cb, responsePromise) => responsePromise.then((res) => {
  cb(res);
  return res;
}));

export const json = curry((cb, responsePromise) => responsePromise
  .then(res => res.json())
  .then(cb));
