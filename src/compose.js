export default function compose(middleware) {
  return function composed(context) {
    const stack = [];
    return middleware
      .reduce((p, f) => p.then((r) => {
        if (typeof r === 'function') stack.unshift(r);
        else if (r) return true;

        return f(context);
      }), Promise.resolve())
      // eslint-disable-next-line consistent-return
      .then(() => {
        if (stack.length) {
          return res => stack
            .reduce((p, f) => p.then(f), Promise.resolve(res));
        }
      });
  };
}
