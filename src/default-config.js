/**
 * merge default config
 *
 * @param {Object} config
 * @param {Object} defaultConfig
 * @returns {Object} New config object
 */
export default function defaultTo(config, defaultConfig) {
  config = Object.assign({}, defaultConfig, config);
  if (!defaultConfig) return config;

  const defaultHeaders = defaultConfig.headers || {};
  config.headers = Object.assign(
    {},
    defaultHeaders.common,
    defaultHeaders[config.method],
    config.headers
  );

  return config;
}
