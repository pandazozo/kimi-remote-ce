#!/usr/bin/env node
// R002-overlay-undefined-immune
// 现象: 置顶后标题变 "undefined"
// 根因: undefined 键被 String() 物化落库(hasOwnProperty 为真 ≠ 有值)
// 出处: 2026-07-20 v0.4.3(此处为纯逻辑复核;同断言也在 gateway/test/overlay.test.js)
'use strict';
const assert = require('node:assert/strict');
process.env.OVERLAY_FILE = `/tmp/r002-${Date.now()}.json`;

(async () => {
  const o = await import('../../gateway/src/overlay.js?x=' + Date.now());
  o.patchSession('s1', { title: '好标题' });
  o.patchSession('s1', { title: undefined, pinned: true });
  assert.equal(o.getOverlay().sessions.s1.title, '好标题');
  assert.equal(o.getOverlay().sessions.s1.pinned, true);
  o.patchSession('s2', { title: undefined, pinned: true });
  assert.equal(o.getOverlay().sessions.s2.title, undefined);
  console.log('R002 OK');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
