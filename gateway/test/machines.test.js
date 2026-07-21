// machines 单元测试:机器注册表(MACHINES_JSON 多机 / 单机回退)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let machines;
async function freshImport() {
  return import('../src/machines.js?x=' + Math.random());
}

beforeEach(() => {
  delete process.env.MACHINES_JSON;
  process.env.KIMI_UPSTREAM = 'http://127.0.0.1:58627';
  process.env.KIMI_TOKEN = 'tok-legacy';
  process.env.MACHINES_FILE = `/tmp/machines-test-${Math.random().toString(36).slice(2)}.json`;
});

test('回退单机:m5 用 KIMI_UPSTREAM/KIMI_TOKEN', async () => {
  machines = await freshImport();
  const m = machines.getMachine('m5');
  assert.equal(m.upstream, 'http://127.0.0.1:58627');
  assert.equal(m.token, 'tok-legacy');
  assert.deepEqual(machines.listMachineIds(), ['m5']);
  assert.equal(machines.defaultMachineId(), 'm5');
});

test('多机配置:MACHINES_JSON 生效', async () => {
  process.env.MACHINES_JSON = JSON.stringify({
    m5: { upstream: 'http://127.0.0.1:58627', token: 'tok5' },
    m1: { upstream: 'http://127.0.0.1:58628', token: 'tok1' },
  });
  machines = await freshImport();
  assert.equal(machines.getMachine('m1').token, 'tok1');
  assert.equal(machines.getMachine('m1').upstream, 'http://127.0.0.1:58628');
  assert.deepEqual(machines.listMachineIds().sort(), ['m1', 'm5']);
});

test('未知机器返回 null', async () => {
  machines = await freshImport();
  assert.equal(machines.getMachine('ghost'), null);
});

test('缺 token/upstream 的条目被丢弃;全丢则回退单机', async () => {
  process.env.MACHINES_JSON = JSON.stringify({
    bad1: { upstream: 'http://x' },
    bad2: { token: 't' },
  });
  machines = await freshImport();
  assert.equal(machines.getMachine('bad1'), null);
  assert.equal(machines.getMachine('m5').token, 'tok-legacy');
});

test('MACHINES_JSON 畸形 JSON → 回退单机不崩', async () => {
  process.env.MACHINES_JSON = '{oops';
  machines = await freshImport();
  assert.equal(machines.getMachine('m5').token, 'tok-legacy');
});

test('registerMachine:分配端口/token,幂等,占用与冲突', async () => {
  machines = await freshImport();
  const r1 = machines.registerMachine('mac-a', 'alice');
  assert.ok(r1.machine.remote_port >= 58700);
  assert.ok(r1.machine.token.length > 20);
  assert.equal(r1.machine.owner_user, 'alice');
  // 同人同 id → 幂等复用
  const r2 = machines.registerMachine('mac-a', 'alice');
  assert.equal(r2.reused, true);
  assert.equal(r2.machine.remote_port, r1.machine.remote_port);
  // 别人抢注 → 拒绝
  const r3 = machines.registerMachine('mac-a', 'bob');
  assert.ok(r3.error);
  // 与系统机冲突 → 拒绝
  const r4 = machines.registerMachine('m5', 'alice');
  assert.ok(r4.error);
  // 非法 id → 拒绝
  assert.ok(machines.registerMachine('BAD ID!', 'alice').error);
  // 端口递增不复用
  const r5 = machines.registerMachine('mac-b', 'bob');
  assert.notEqual(r5.machine.remote_port, r1.machine.remote_port);
  // 注册后 getMachine 可见
  assert.equal(machines.getMachine('mac-b').owner_user, 'bob');
});
