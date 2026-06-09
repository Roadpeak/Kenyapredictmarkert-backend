import { waitForPortOpen } from '@nx/node/utils';

/* eslint-disable */
var __TEARDOWN_MESSAGE__: string;

module.exports = async function () {
  const host = process.env.HOST ?? 'localhost';
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;

  console.log(`\n[e2e] Waiting for gateway on ${host}:${port}...`);
  await waitForPortOpen(port, { host, retries: 60, retryDelay: 2000 });
  console.log(`[e2e] Gateway is ready.\n`);

  globalThis.__TEARDOWN_MESSAGE__ = '\n[e2e] Test run complete.\n';
};
