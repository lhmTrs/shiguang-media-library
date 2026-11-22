import assert from 'node:assert/strict';

// Test-only admission: never allow a system port/socket, even on loopback.
export function assertOwnedMysqlTarget(input, owned) {
  for (const value of [input, owned]) {
    assert.ok(value && typeof value === 'object');
    assert.equal(value.host, '127.0.0.1');
    assert.ok(Number.isInteger(Number(value.port)) && Number(value.port) > 1024 && Number(value.port) <= 65535);
    assert.ok(![3306, 4317].includes(Number(value.port)));
    assert.ok(!Object.keys(value).some(key => /socket/i.test(key)));
  }
  for (const key of ['host', 'database', 'user']) assert.equal(input[key], owned[key]);
  assert.equal(input.password ?? '', owned.password ?? '');
  assert.equal(Number(input.port), Number(owned.port));
}
