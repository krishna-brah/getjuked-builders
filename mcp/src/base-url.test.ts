/**
 * Where juke-mcp may send the key (JUKE_BASE_URL). Run from mcp/: npx tsx src/base-url.test.ts
 */
import assert from 'node:assert/strict';

import { baseUrl, DEFAULT_BASE } from './base-url.js';

assert.equal(baseUrl(undefined), DEFAULT_BASE);
assert.equal(baseUrl('  '), DEFAULT_BASE);
assert.equal(baseUrl('https://www.getjuked.io/api/v3-beta/'), 'https://www.getjuked.io/api/v3-beta');
assert.equal(baseUrl('https://getjuked.io/api/v3-beta'), 'https://getjuked.io/api/v3-beta');
assert.equal(baseUrl('http://localhost:3000/api/v3-beta'), 'http://localhost:3000/api/v3-beta');
assert.equal(baseUrl('http://127.0.0.1:3100/api/v3-beta'), 'http://127.0.0.1:3100/api/v3-beta');
for (const refused of [
  'http://www.getjuked.io/api/v3-beta', // plain http to juke
  'https://evil.example/api/v3-beta', // another host
  'https://getjuked.io.evil.example/api', // juke's name inside another host
  'https://evilgetjuked.io/api', // a look-alike
  'https://user:pass@www.getjuked.io/api/v3-beta', // credentials in the address
  'https://localhost/api', // https localhost is not a local juke dev server here
  'not a url',
]) assert.equal(baseUrl(refused), null, refused);
console.log('juke-mcp base url: all checks passed');
