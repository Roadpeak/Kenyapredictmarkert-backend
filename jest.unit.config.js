/**
 * Root Jest config for running ALL unit tests across services.
 * Usage: pnpm test:unit
 */
module.exports = {
  displayName: 'predictmarket-unit',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': [
      '@swc/jest',
      {
        jsc: {
          target: 'es2017',
          parser: { syntax: 'typescript', decorators: true, dynamicImport: true },
          transform: { decoratorMetadata: true, legacyDecorator: true },
          keepClassNames: true,
          externalHelpers: true,
          loose: true,
        },
        module: { type: 'commonjs' },
        sourceMaps: true,
      },
    ],
  },
  moduleFileExtensions: ['ts', 'js'],
  // Only pick up *.spec.ts inside service apps (not *-e2e apps) and libs/
  testMatch: [
    '<rootDir>/apps/*/src/**/*.spec.ts',
    '<rootDir>/libs/**/src/**/*.spec.ts',
  ],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/apps/[^/]+-e2e/',
  ],
  moduleNameMapper: {
    // @org/* package aliases → TypeScript source
    '^@org/types$': '<rootDir>/libs/shared/types/src/index.ts',
    '^@org/utils$': '<rootDir>/libs/shared/utils/src/index.ts',
    '^@org/kafka-client$': '<rootDir>/libs/shared/kafka-client/src/index.ts',
    '^@org/decorators$': '<rootDir>/libs/shared/decorators/src/index.ts',
    '^@org/exceptions$': '<rootDir>/libs/shared/exceptions/src/index.ts',
    // Redirect internal .js barrel exports to .ts sources
    '^(.*)/lib/types\\.js$': '$1/lib/types.ts',
    '^(.*)/lib/utils\\.js$': '$1/lib/utils.ts',
    '^(.*)/lib/kafka-client\\.js$': '$1/lib/kafka-client.ts',
    '^(.*)/lib/decorators\\.js$': '$1/lib/decorators.ts',
    '^(.*)/lib/exceptions\\.js$': '$1/lib/exceptions.ts',
    // uuid@14 and nanoid@5 are pure ESM — redirect to CJS-compatible shims
    '^uuid$': '<rootDir>/test-utils/uuid-mock.js',
    '^nanoid$': '<rootDir>/test-utils/nanoid-mock.js',
  },
  coverageDirectory: '<rootDir>/test-output/coverage',
  collectCoverageFrom: [
    'apps/*/src/**/*.ts',
    'libs/**/src/**/*.ts',
    '!**/*.module.ts',
    '!**/*.dto.ts',
    '!**/main.ts',
    '!**/prisma.service.ts',
    '!**/*.spec.ts',
  ],
  passWithNoTests: true,
  verbose: true,
  testTimeout: 10000,
};
