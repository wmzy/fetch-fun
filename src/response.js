import {curry} from './util';

export const text = curry((cb, res) => res.text().then(cb));

export const json = curry((cb, res) => res.json().then(cb));

export const blob = curry((cb, res) => res.blob().then(cb));

export const error = curry((status, cb, err) => {
  if (err && err.response && err.response.status === status) return cb(err);

  throw err;
});

export const badRequest = error(400);

export const unauthorized = error(401);

export const forbidden = error(403);

export const notFound = error(404);

export const timeout = error(408);

export const internalError = error(500);
