/* eslint-disable */
// E2E tests run against an already-running gateway (pnpm dev).
// We do NOT kill the port — the dev server lifecycle is managed externally.
module.exports = async function () {
  console.log(globalThis.__TEARDOWN_MESSAGE__);
};
