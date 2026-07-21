// Overlay:网关侧会话元数据补丁层(上游 kimi API 无 PATCH/置顶能力,实测 404)
// 存 renames + pins,JSON 文件原子写。容器内 /data/overlay.json(named volume),开发用 gateway/overlay.json(gitignore)
import fs from 'node:fs';
import path from 'node:path';

const FILE = process.env.OVERLAY_FILE || path.join(process.cwd(), 'overlay.json');

let store = { sessions: {} };
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.sessions) store = parsed;
  } catch {
    // 不存在或损坏:从空 store 起步(损坏时不覆盖原文件,下次写会重建)
  }
}

function save() {
  const tmp = FILE + '.tmp';
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

export function getOverlay() {
  load();
  return store;
}

// patch: { title?: string|null, pinned?: boolean, base_title?: string, at?: string } → 返回该会话的合并条目
// 防御:undefined 的键视为未提供(2026-07-20 生产 bug:String(undefined) 落库)
// 对齐(D-17):写 title 时记 base_title(落笔瞬间的上游 title)+ at;H5 合并时若上游 title 已变,视为上游最新,overlay 过期
export function patchSession(id, patch) {
  load();
  const cur = store.sessions[id] || {};
  if (Object.prototype.hasOwnProperty.call(patch, 'title') && patch.title !== undefined) {
    if (patch.title === null || patch.title === '') {
      delete cur.title;
      delete cur.base_title;
      delete cur.at;
    } else {
      cur.title = String(patch.title).slice(0, 200);
      if (typeof patch.base_title === 'string') cur.base_title = patch.base_title.slice(0, 200);
      if (typeof patch.at === 'string') cur.at = patch.at;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'pinned') && patch.pinned !== undefined) {
    if (patch.pinned) cur.pinned = true;
    else delete cur.pinned;
  }
  if (!Object.keys(cur).length) delete store.sessions[id];
  else store.sessions[id] = cur;
  save();
  return cur;
}
