(function (root, factory) {
  const policy = factory();
  if (typeof module === 'object' && module.exports) module.exports = policy;
  else root.ConnectionPolicy = policy;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  function retryDelay(attempt, random = Math.random) {
    const base = Math.min(30000, 1500 * 2 ** Math.min(5, Math.max(0, attempt)));
    return Math.round(Math.min(30000, base * (0.75 + random() * 0.5)));
  }

  function shouldRetry(error) {
    const status = Number(error?.status || 0);
    return !status || status === 408 || status === 425 || status === 429 || status >= 500;
  }

  return { retryDelay, shouldRetry };
});
