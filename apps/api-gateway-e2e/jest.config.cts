/* eslint-disable */
import { readFileSync } from 'fs';

const swcJestConfig = JSON.parse(
  readFileSync(`${__dirname}/.spec.swcrc`, 'utf-8'),
);
swcJestConfig.swcrc = false;

export default {
  displayName: 'api-gateway-e2e',
  preset: '../../jest.preset.js',
  globalSetup: '<rootDir>/src/support/global-setup.ts',
  globalTeardown: '<rootDir>/src/support/global-teardown.ts',
  setupFiles: ['<rootDir>/src/support/test-setup.ts'],
  testEnvironment: 'node',
  // Run suites sequentially — shared mutable state in state.ts
  runInBand: true,
  // Order by filename so numbered suites run in sequence
  testSequencer: '@jest/test-sequencer',
  transform: {
    '^.+\\.[tj]s$': ['@swc/jest', swcJestConfig],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: 'test-output/jest/coverage',
  // Per-test timeout: 15s (STK push + network round-trips)
  testTimeout: 15000,
  // Verbose output per test
  verbose: true,
};
