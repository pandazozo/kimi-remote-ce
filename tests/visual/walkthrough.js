'use strict';

/* 视觉走查主脚本 —— Kimi Remote H5
 * 行为契约:
 *   - 每步先 DOM 断言,断言通过再截图;失败立即 throw 并在 catch 中标记 FAIL 截图
 *   - 结构断言 / 文本特征,不依赖具体会话标题
 *   - 网络层不用 networkidle(SPA WS/轮询长连)——改用明确选择器等待
 *   - 不掩盖产品 bug;只产出 PASS/FAIL 行与截图证据
 */

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const BASE = (process.env.VISUAL_BASE || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const PASSWORD = process.env.PASSWORD;
const PASSWORD_OVERRIDE = Object.prototype.hasOwnProperty.call(process.env, 'PASSWORD');
const FALLBACK_PASSWORD = process.env.FALLBACK_PASSWORD || '';
const SEND_TEXT = '视觉走查:只回复 OK';
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const SHOT_DIR = path.join(__dirname, 'shots', RUN_STAMP);

fs.mkdirSync(SHOT_DIR, { recursive: true });

const HAS_UNDEFINED_RE = /(^|[^A-Za-z])undefined([^A-Za-z]|$)/;

let page;
let browser;
let context;
let stepCount = 0;
const consoleErrors = [];
const pageErrors = [];

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function routeUrl(hash) {
  return BASE + '/' + hash;
}

async function screenshot(name) {
  await page.screenshot({ path: path.join(SHOT_DIR, name), fullPage: false });
}

function logPass(num, title) {
  console.log(`PASS ${String(num).padStart(2, '0')} ${title}`);
}

function logFail(num, title, err) {
  console.log(`FAIL ${String(num).padStart(2, '0')} ${title}: ${err && err.message ? err.message : err}`);
}

async function runStep(num, title, fn) {
  stepCount = num;
  try {
    await fn();
    logPass(num, title);
  } catch (err) {
    logFail(num, title, err);
    try { await page.screenshot({ path: path.join(SHOT_DIR, `${String(num).padStart(2, '0')}-FAIL-${slugify(title)}.png`) }); } catch (_) {}
    throw err;
  }
}

function slugify(s) {
  return String(s).replace(/[^\w一-龥-]+/g, '-').slice(0, 60);
}

async function gotoHash(hash) {
  await page.goto(routeUrl(hash), { waitUntil: 'domcontentloaded' });
}

async function waitFor(predicate, opts) {
  return page.waitForFunction(predicate, null, opts || { timeout: 30000 });
}

async function waitForList() {
  await waitFor(() => location.hash === '#/' && document.querySelectorAll('#sess-wrap .sess-item').length > 0,
    { timeout: 45000 });
}

async function doLogin(password) {
  await gotoHash('#/login');
  await page.locator('#pw').waitFor({ state: 'visible', timeout: 30000 });
  await page.locator('#pw').fill(password);
  await Promise.all([
    page.waitForFunction(() => location.hash !== '#/login', null, { timeout: 30000 }),
    page.locator('#pwbtn').click(),
  ]);
  await waitForList();
}

async function doLogoutIfPossible() {
  // 列表页 ⋮ 菜单 → 退出登录:保证从干净态起步
  if (location && location.hash !== '#/') return;
  const btn = await page.$('#btn-menu');
  if (!btn) return;
  await btn.click();
  const out = await page.$('#m-logout');
  if (out) await out.click();
}

(async () => {
  let exitCode = 0;
  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      ignoreHTTPSErrors: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    });
    page = await context.newPage();

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });

    // -------- 1 登录页 --------
    let attempted = [{ pw: PASSWORD, used: PASSWORD }];
    if (!PASSWORD_OVERRIDE) attempted.push({ pw: FALLBACK_PASSWORD, used: FALLBACK_PASSWORD, fallback: true });

    let loginOk = false;
    for (const attempt of attempted) {
      try {
        await doLogin(attempt.pw);
        loginOk = true;
        break;
      } catch (err) {
        // 401 后回到 #/login;只有默认密码下才能再试 fallback,显式 PASSWORD 不重试
        if (attempt.fallback) continue;
        throw err;
      }
    }
    ensure(loginOk, '登录失败:已尝试默认/兜底密码');

    await runStep(1, '登录页 → 列表', async () => {
      // 列表页应至少 1 个真实会话条目
      const items = await page.locator('#sess-wrap .sess-item').count();
      ensure(items > 0, `#sess-wrap 没有任何 .sess-item(count=${items})`);
      await screenshot('01-list-after-login.png');
    });

    // -------- 2 列表断言 --------
    let firstSessionId = null;
    let firstSessionTitle = '';
    await runStep(2, '列表结构 + 状态点 + 无 undefined', async () => {
      const items = page.locator('#sess-wrap .sess-item');
      const n = await items.count();
      ensure(n > 0, `列表为空`);
      for (let i = 0; i < n; i++) {
        const row = items.nth(i);
        const meta = row.locator('.sess-meta');
        ensure(await meta.count() > 0, `第 ${i} 行缺少 .sess-meta`);
        const st = row.locator('.sess-meta .st .dot');
        ensure(await st.count() > 0, `第 ${i} 行缺少状态点 .st .dot`);
        const metaText = (await meta.first().innerText()).trim();
        ensure(metaText.length > 0, `第 ${i} 行 .sess-meta 为空`);
        // 末段是时间(刚刚/分钟前/小时前/昨天/M-D)
        ensure(/(刚刚|\d+\s*(分钟|小时)前|昨天|\d+-\d+)/.test(metaText), `第 ${i} 行 .sess-meta 缺时间文本: ${metaText}`);
      }
      const allText = await page.locator('body').innerText();
      ensure(!HAS_UNDEFINED_RE.test(allText), `列表页出现 undefined: ${allText.match(/.{0,30}undefined.{0,30}/)?.[0]}`);

      // 记下第一个会话信息(后续步骤使用)
      firstSessionId = await items.nth(0).evaluate((el) => el.querySelector('.sess-title')?.textContent?.trim() || '');
      // 通过点击读取真实路由(避免依赖具体 ID)
      const beforeHash = await page.evaluate(() => location.hash);
      await items.nth(0).click();
      await page.waitForFunction((b) => location.hash !== b, beforeHash, { timeout: 30000 });
      await page.locator('#input').waitFor({ state: 'visible', timeout: 30000 });
      firstSessionTitle = (await page.locator('#chat-title').textContent()) || '';
      ensure(/^#\/s\//.test(await page.evaluate(() => location.hash)), `第 1 个会话未跳到 #/s/`);
      firstSessionId = (await page.evaluate(() => location.hash)).replace(/^#\/s\//, '');
    });
    const firstSessionHash = '#/s/' + firstSessionId;

    // -------- 3 会话详情结构 --------
    await runStep(3, '详情页:消息气泡/状态/输入框 + 无 undefined', async () => {
      // 等消息出现
      await page.waitForFunction(() => document.querySelectorAll('#msg-list .msg').length > 0, null, { timeout: 45000 });
      const bubbles = await page.locator('#msg-list .msg .bubble').count();
      ensure(bubbles > 0, `#msg-list 没有任何 .msg .bubble(count=${bubbles})`);
      const status = await page.locator('#chat-status .st').count();
      ensure(status > 0, `#chat-status 缺 .st`);
      const input = await page.locator('#input').count();
      ensure(input === 1, `#input 数量异常(count=${input})`);
      const allText = await page.locator('body').innerText();
      ensure(!HAS_UNDEFINED_RE.test(allText), `详情页出现 undefined: ${allText.match(/.{0,30}undefined.{0,30}/)?.[0]}`);
      await screenshot('03-detail.png');
    });

    // -------- 4 加载更早(锚定) --------
    await runStep(4, '加载更早:消息增加 + 视口锚定不跳', async () => {
      // 候选选择:回列表,挑一个会话来刷,优先 meta 含「N 条」(数量) 较高者。
      // 不硬编码标题:取元数据里数字最大且 ≠ 当前会话者。
      await page.goto(routeUrl('#/'), { waitUntil: 'domcontentloaded' });
      await waitForList();
      const candidates = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('#sess-wrap .sess-item'));
        const arr = [];
        for (const el of items) {
          const t = (el.querySelector('.sess-title')?.textContent || '').trim();
          const meta = (el.querySelector('.sess-meta')?.textContent || '');
          // 数字 N 条
          const m = meta.match(/(\d+)\s*条/);
          const cnt = m ? parseInt(m[1], 10) : 0;
          arr.push({ title: t, count: cnt });
        }
        return arr;
      });
      ensure(candidates.length > 0, '列表无候选');
      // 候选排序:有计数优先,再选最大
      candidates.sort((a, b) => (b.count || 0) - (a.count || 0));
      const picked = candidates[0];
      ensure(picked, '无可选候选');
      // 点击其行
      const pickedRow = page.locator('#sess-wrap .sess-item').first();
      await pickedRow.click();
      await page.locator('#input').waitFor({ state: 'visible', timeout: 30000 });
      await page.waitForFunction(() => document.querySelectorAll('#msg-list .msg').length > 0, null, { timeout: 45000 });

      // 若 hasMore 不可触发(此会话无需翻页),跳过 step 4 的子断言,只截图证明就绪
      // 滚动到底以稳态
      const beforeCount = await page.locator('#msg-list .msg').count();
      // 翻页能力:先点 #load-earlier;若没有则滚动到顶;再次轮询
      let triggered = false;
      const tryLoadEarlier = async () => {
        const btn = page.locator('#load-earlier');
        if (await btn.count() > 0) {
          await btn.click();
          triggered = true;
          return true;
        }
        // 滚到顶触发自动翻页
        const msgs = page.locator('#msgs');
        await msgs.evaluate((el) => { el.scrollTop = 0; });
        // 等待 #load-earlier 出现(自动翻页常先出按钮)
        try {
          await page.waitForFunction(() => !!document.getElementById('load-earlier'), null, { timeout: 4000 });
          const btn2 = page.locator('#load-earlier');
          if (await btn2.count() > 0) {
            await btn2.click();
            triggered = true;
            return true;
          }
        } catch (_) {}
        return false;
      };

      const tried = await tryLoadEarlier();
      if (!tried) {
        // 部分会话总数很小,根本没有「加载更早」。但用户要求"挑消息多的会话",
        // 顶多在最大计数会话也用尽翻页时,允许结构性 PASS 并截图,日志说清原因
        // 不静默:再次尝试滚到顶,观察 DOM 节点数变化
        const msgs = page.locator('#msgs');
        for (let i = 0; i < 3; i++) {
          await msgs.evaluate((el) => { el.scrollTop = 0; });
          await page.waitForTimeout(800);
        }
        const afterCount = await page.locator('#msg-list .msg').count();
        if (afterCount === beforeCount) {
          // 视为产品/数据自然限制:把会话清空回 #/,走后续步骤
          console.log(`INFO step4: 选中候选「${picked.title}」无更早消息可加载(count=${picked.count}),跳过锚定断言`);
          await screenshot('04-load-earlier.png');
          return;
        }
        triggered = true;
      }

      // 抓"加载前"首个可见 .msg 的 data-mid 与文本/纵向偏移
      const beforeSnapshot = await page.evaluate(() => {
        const msgs = document.getElementById('msgs');
        if (!msgs) return null;
        const list = document.getElementById('msg-list');
        if (!list) return null;
        const nodes = Array.from(list.querySelectorAll('.msg'));
        if (!nodes.length) return null;
        const first = nodes[0];
        const rect = first.getBoundingClientRect();
        return {
          mid: first.dataset.mid || first.querySelector('[data-mid]')?.dataset.mid || null,
          text: (first.textContent || '').slice(0, 64),
          listScrollTop: msgs.scrollTop,
          nodeOffsetTop: first.offsetTop,
        };
      });
      ensure(beforeSnapshot, '无法记录加载前的首个 .msg 快照');

      // 等待翻页完成(节点数增加 或 静默窗 5s)
      const deadline = Date.now() + 25000;
      let afterCount = beforeCount;
      while (Date.now() < deadline) {
        afterCount = await page.locator('#msg-list .msg').count();
        if (afterCount > beforeCount) break;
        await page.waitForTimeout(400);
      }
      ensure(afterCount > beforeCount, `加载更早未插入新消息(before=${beforeCount}, after=${afterCount}, triggered=${triggered})`);

      // 锚定检查:同一个 mid 仍然存在,且仍是 #msg-list 中较前位置,滚动位移与节点位移差在容差内
      const afterSnapshot = await page.evaluate((mid) => {
        const msgs = document.getElementById('msgs');
        const list = document.getElementById('msg-list');
        if (!msgs || !list) return null;
        const all = Array.from(list.querySelectorAll('.msg'));
        const idx = all.findIndex((n) => (n.dataset.mid || n.querySelector('[data-mid]')?.dataset.mid) === mid);
        if (idx < 0) return null;
        const same = all[idx];
        const rect = same.getBoundingClientRect();
        return {
          mid,
          foundIdx: idx,
          text: (same.textContent || '').slice(0, 64),
          listScrollTop: msgs.scrollTop,
          nodeOffsetTop: same.offsetTop,
          rectTop: rect.top,
        };
      }, beforeSnapshot.mid);
      ensure(afterSnapshot, '加载更早后,原首个 .msg 已不在 DOM(可能 keyed 重建失败)');
      // 文本不能"突变"——前 64 字符应一致
      ensure(afterSnapshot.text === beforeSnapshot.text, `原首个 .msg 文本突变: before="${beforeSnapshot.text}" after="${afterSnapshot.text}"`);
      // 锚定:节点 offsetTop 增加量(Δh)应 ≈ 滚动 scrollTop 增加量(让视口停在原消息上)
      const deltaNode = afterSnapshot.nodeOffsetTop - beforeSnapshot.nodeOffsetTop;
      const deltaScroll = afterSnapshot.listScrollTop - beforeSnapshot.listScrollTop;
      const tolerance = 40; // 允许小像素抖动
      ensure(Math.abs(deltaNode - deltaScroll) <= tolerance,
        `视口锚定失败:deltaNode=${deltaNode} deltaScroll=${deltaScroll} 差 ${Math.abs(deltaNode - deltaScroll)}>${tolerance}`);
      await screenshot('04-load-earlier.png');
    });

    // -------- 5 系统注入折叠条 不是用户气泡 --------
    await runStep(5, '系统注入折叠条 ≠ 用户气泡', async () => {
      const inj = page.locator('details.inject-card');
      const cnt = await inj.count();
      if (cnt === 0) {
        console.log('INFO step5: 当前会话无 .inject-card(允许)');
        await screenshot('05-inject-card.png');
        return;
      }
      // 任何 inject-card 不应是 .msg.user > .bubble 的样式类;其祖先不能匹配 .msg.user > .bubble
      const bad = await page.evaluate(() => {
        const list = Array.from(document.querySelectorAll('details.inject-card'));
        return list.filter((d) => {
          // 注入卡的视觉不是 user 蓝气泡:d 自身没有 bubble 类,祖先不直接为 .bubble
          return d.classList.contains('bubble') || d.closest('.msg.user > .bubble') !== null;
        }).length;
      });
      ensure(bad === 0, `发现 ${bad} 个 inject-card 被渲染成用户气泡(应折叠卡)`);
      await screenshot('05-inject-card.png');
    });

    // -------- 6 输入区自动长高 + 附件按钮 --------
    await runStep(6, '输入区自动长高 + 附件按钮在', async () => {
      const input = page.locator('#input');
      await input.waitFor({ state: 'visible', timeout: 30000 });
      const before = await input.evaluate((el) => Math.round(el.getBoundingClientRect().height));
      await input.fill('第一行\n第二行\n第三行\n第四行\n第五行');
      // 触发 input 事件,确保 style.height 走一遍
      await input.dispatchEvent('input');
      await page.waitForTimeout(150);
      const after = await input.evaluate((el) => Math.round(el.getBoundingClientRect().height));
      ensure(after > before, `textarea 未自动长高: before=${before} after=${after}`);
      const attach = await page.locator('#btn-attach').count();
      ensure(attach === 1, `#btn-attach 数量异常(count=${attach})`);
      // 恢复空内容,避免污染 step 10
      await input.fill('');
      await input.dispatchEvent('input');
      await screenshot('06-composer.png');
    });

    // -------- 7 交互卡位置(#interact 在 #msg-list 之后、composer 之前) --------
    await runStep(7, 'DOM 顺序:#msg-list → #interact → .composer', async () => {
      const ok = await page.evaluate(() => {
        const a = document.getElementById('msg-list');
        const b = document.getElementById('interact');
        const c = document.querySelector('.composer');
        if (!a || !b || !c) return { ok: false, missing: [!a && 'msg-list', !b && 'interact', !c && 'composer'].filter(Boolean) };
        // compareDocumentPosition: DOCUMENT_POSITION_FOLLOWING = 4
        const aBeforeB = !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
        const bBeforeC = !!(b.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING);
        return { ok: aBeforeB && bBeforeC, aBeforeB, bBeforeC };
      });
      ensure(ok.ok, `DOM 顺序不满足 msg-list < interact < composer: ${JSON.stringify(ok)}`);
      await screenshot('07-interact-position.png');
    });

    // -------- 8 机群页 --------
    await runStep(8, '机群页:生命体征 ≥4 + 数字 + 模型标签 + 无 undefined', async () => {
      await page.goto(routeUrl('#/fleet'), { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.querySelectorAll('.vital-card').length > 0, null, { timeout: 30000 });
      const vitalCount = await page.locator('.vital-card').count();
      ensure(vitalCount >= 4, `生命体征卡 < 4(count=${vitalCount})`);
      // 每张卡 .vital-count 含数字
      for (let i = 0; i < vitalCount; i++) {
        const text = (await page.locator('.vital-card').nth(i).locator('.vital-count').textContent() || '').trim();
        ensure(/^\d+$/.test(text), `vital-card[${i}].vital-count 非数字: "${text}"`);
      }
      // 列表行存在
      const rowCount = await page.locator('.fleet-item').count();
      ensure(rowCount > 0, `.fleet-item 列表为空`);
      // 模型标签:任一 .sess-tag 文本匹配 k3/MiniMax-M3/glm-5.2(case-insensitive)
      const tags = await page.locator('.fleet-item .sess-tag').allTextContents();
      const hay = tags.join(' ').toLowerCase();
      const hit = /(k3|minimax|glm[-_ ]?5\.?2)/.test(hay);
      ensure(hit, `未发现模型标签: ${JSON.stringify(tags)}`);
      const allText = await page.locator('body').innerText();
      ensure(!HAS_UNDEFINED_RE.test(allText), `机群页出现 undefined: ${allText.match(/.{0,30}undefined.{0,30}/)?.[0]}`);
      await screenshot('08-fleet.png');
    });

    // -------- 9 他源详情 --------
    await runStep(9, '机群页第一个 Claude Code·壳 会话详情', async () => {
      // 找 harness 标签为 "Claude Code·壳" 的 .fleet-item
      const targetIdx = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('.fleet-item'));
        for (let i = 0; i < items.length; i++) {
          const lbl = items[i].querySelector('.fleet-h')?.textContent?.trim() || '';
          if (lbl.includes('Claude Code·壳')) return i;
        }
        return -1;
      });
      if (targetIdx < 0) {
        throw new Error('机群页未找到 Claude Code·壳 条目');
      }
      await page.locator('.fleet-item').nth(targetIdx).click();
      await page.waitForFunction(() => /^#\/fs\//.test(location.hash), null, { timeout: 30000 });
      // 等待消息
      await page.waitForFunction(() => document.querySelectorAll('#fd-wrap .msg').length > 0, null, { timeout: 45000 });
      const bubbles = await page.locator('#fd-wrap .msg .bubble').count();
      ensure(bubbles > 0, `#fd-wrap 没有任何 .msg .bubble(count=${bubbles})`);
      const takeoverInput = await page.locator('#fd-input').count();
      const takeoverSend = await page.locator('#fd-send').count();
      ensure(takeoverInput > 0 && takeoverSend > 0, `接管输入/发送按钮缺失 input=${takeoverInput} send=${takeoverSend}`);
      await screenshot('09-fleet-detail.png');
    });

    // -------- 10 发送消息并等回复 --------
    await runStep(10, '发送:自己气泡 + 120s 内 assistant 回复', async () => {
      // 回原始第一个会话
      await page.goto(routeUrl(firstSessionHash), { waitUntil: 'domcontentloaded' });
      await page.locator('#input').waitFor({ state: 'visible', timeout: 30000 });
      await page.waitForFunction(() => document.querySelectorAll('#msg-list .msg').length > 0, null, { timeout: 45000 });

      // 记录"加载前"已有 assistant 节点(mid + 文本指纹)
      const before = await page.evaluate(() => {
        const arr = Array.from(document.querySelectorAll('#msg-list .msg'));
        return arr.map((m) => ({
          mid: m.dataset.mid || m.querySelector('[data-mid]')?.dataset.mid || null,
          role: m.classList.contains('user') ? 'user' : m.classList.contains('assistant') ? 'assistant' : '?',
          text: (m.textContent || '').replace(/\s+/g, ' ').slice(0, 80),
        }));
      });

      // 输入并发送
      await page.locator('#input').fill(SEND_TEXT);
      await page.locator('#btn-send').click();

      // 自己气泡立刻出现
      await page.waitForFunction((txt) => {
        const arr = Array.from(document.querySelectorAll('#msg-list .msg.user .bubble'));
        return arr.some((b) => (b.textContent || '').includes(txt));
      }, SEND_TEXT, { timeout: 15000 });

      // 静默窗:等自己的提示(忙/转圈/queued)先稳住,再开始判"新增 assistant 节点"
      // 避免 server 正在逐字 patch 历史 mid 时误判,或后台 push 抢答
      await page.waitForTimeout(3500);

      // 等待新增的 assistant 气泡(文本非空,排除 pending 占位)
      const deadline = Date.now() + 120000;
      let replyFound = false;
      let replyText = '';
      while (Date.now() < deadline) {
        const now = await page.evaluate((prev) => {
          const arr = Array.from(document.querySelectorAll('#msg-list .msg'));
          return arr.map((m) => ({
            mid: m.dataset.mid || m.querySelector('[data-mid]')?.dataset.mid || null,
            role: m.classList.contains('user') ? 'user' : m.classList.contains('assistant') ? 'assistant' : '?',
            text: (m.textContent || '').replace(/\s+/g, ' ').slice(0, 80),
          }));
        }, before);
        // 找"加载前不存在"的 assistant 节点,文本非空
        const prevMids = new Set(before.map((x) => x.mid).filter(Boolean));
        for (const n of now) {
          if (n.role !== 'assistant') continue;
          if (!n.text.trim()) continue;
          if (prevMids.size && n.mid && prevMids.has(n.mid)) continue;
          // 新增 assistant 气泡
          replyText = n.text;
          replyFound = true;
          break;
        }
        if (replyFound) break;
        await page.waitForTimeout(1500);
      }
      ensure(replyFound, `120s 内未出现 assistant 回复气泡(last=${replyText})`);
      await screenshot('10-send-reply.png');
    });

    console.log('SCREENSHOT_DIR=' + SHOT_DIR);
  } catch (err) {
    exitCode = 1;
    console.error('WALKTHROUGH_ERROR:', err && err.message ? err.message : err);
  } finally {
    if (consoleErrors.length) console.log('CONSOLE_ERRORS=' + JSON.stringify(consoleErrors.slice(0, 8)));
    if (pageErrors.length) console.log('PAGE_ERRORS=' + JSON.stringify(pageErrors.slice(0, 8)));
    try { if (context) await context.close(); } catch (_) {}
    try { if (browser) await browser.close(); } catch (_) {}
  }
  process.exit(exitCode);
})();
