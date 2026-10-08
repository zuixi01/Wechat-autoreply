/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder CommonJS hook entry. */
module.exports = (context) => require('./native-pack-check.cjs')(context, false)
