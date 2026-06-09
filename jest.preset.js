const { workspaceRoot } = require('@nx/devkit');
const path = require('path');

module.exports = {
  testEnvironment: 'node',
  transform: {},
  resolver: '@nx/jest/plugins/resolver',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
  coverageReporters: ['html'],
  passWithNoTests: true,
};
