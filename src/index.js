import create from './create';
import defaults from './defaults';
import use from './middleware';

const fetchFun = create(defaults);

export * from './config-build';

export * from './response';

const {get, delete: del, options, post, put, patch, head} = fetchFun;
export {
  create,
  defaults,
  use,
  fetchFun,
  get,
  del as delete,
  options,
  post,
  put,
  patch,
  head
};

export default fetchFun;
