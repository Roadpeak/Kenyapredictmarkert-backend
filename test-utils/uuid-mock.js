// CJS shim for uuid@14 (pure ESM) — used by jest.unit.config.js moduleNameMapper
let counter = 0;
function v4() {
  return `test-uuid-${String(++counter).padStart(4, '0')}-0000-0000-0000-000000000000`;
}
module.exports = { v4 };
module.exports.v4 = v4;
