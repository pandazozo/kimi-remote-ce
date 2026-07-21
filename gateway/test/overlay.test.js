// overlay 单元测试:补丁层存储规则 + D-17 对齐字段(base_title/at)
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.OVERLAY_FILE = path.join(mkdtempSync(path.join(tmpdir(), 'overlay-test-')), 'overlay.json');

let overlay;
before(async () => {
  overlay = await import('../src/overlay.js');
});

test('写 title 记 base_title 与 at', () => {
  const e = overlay.patchSession('s1', { title: '新名字', base_title: '旧名字', at: '2026-07-20T01:00:00Z' });
  assert.equal(e.title, '新名字');
  assert.equal(e.base_title, '旧名字');
  assert.equal(e.at, '2026-07-20T01:00:00Z');
  const stored = overlay.getOverlay().sessions.s1;
  assert.equal(stored.base_title, '旧名字');
});

test('base_title/at 缺省时不受影响(向后兼容)', () => {
  const e = overlay.patchSession('s2', { title: '只有标题' });
  assert.equal(e.title, '只有标题');
  assert.equal(e.base_title, undefined);
  assert.equal(e.at, undefined);
});

test('title 置 null 清除时连同 base_title/at 一起清', () => {
  overlay.patchSession('s3', { title: 'X', base_title: 'Y', at: 't' });
  const e = overlay.patchSession('s3', { title: null });
  assert.equal(e.title, undefined);
  assert.equal(e.base_title, undefined);
  assert.equal(e.at, undefined);
  // 全空条目应从 store 移除
  assert.equal(overlay.getOverlay().sessions.s3, undefined);
});

test('undefined 键视为未提供(不覆盖既有值)', () => {
  overlay.patchSession('s4', { title: '保留我', base_title: 'B', at: 't' });
  const e = overlay.patchSession('s4', { pinned: true });
  assert.equal(e.title, '保留我');
  assert.equal(e.base_title, 'B');
  assert.equal(e.pinned, true);
});

test('pinned 置 false 删除 pinned', () => {
  overlay.patchSession('s5', { pinned: true });
  const e = overlay.patchSession('s5', { pinned: false });
  assert.equal(e.pinned, undefined);
  assert.equal(overlay.getOverlay().sessions.s5, undefined);
});

test('title 超长截断到 200', () => {
  const e = overlay.patchSession('s6', { title: 'x'.repeat(300) });
  assert.equal(e.title.length, 200);
});
