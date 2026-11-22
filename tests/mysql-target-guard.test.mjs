import test from 'node:test';
import assert from 'node:assert/strict';
import {assertOwnedMysqlTarget} from './helpers/mysql-target-guard.mjs';
test('test MySQL admission rejects default ports, sockets and late overwritten configuration', () => {
  const owned = {host:'127.0.0.1',port:49160,database:'activation_populated',user:'root',password:''};
  assert.doesNotThrow(() => assertOwnedMysqlTarget({...owned}, owned));
  assert.doesNotThrow(() => assertOwnedMysqlTarget({...owned,password:undefined}, owned));
  assert.throws(() => assertOwnedMysqlTarget({...owned,password:undefined}, {...owned,password:'synthetic'}));
  for (const change of [{port:3306},{port:4317},{port:49161},{socketPath:'/tmp/mysql.sock'},{socket:'/var/mysql/mysql.sock'},{host:'localhost'},{database:'other'},{user:'other'}])
    assert.throws(() => assertOwnedMysqlTarget({...owned,...change}, owned));
});
