// CJS shim for nanoid@5 (pure ESM) — used by jest.unit.config.js moduleNameMapper
let counter = 0;
function nanoid(size) {
  return `nanoid-${String(++counter).padStart(6, '0')}`;
}
module.exports = { nanoid };
module.exports.nanoid = nanoid;
