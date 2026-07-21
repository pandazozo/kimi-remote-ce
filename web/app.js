/* app.js — Kimi Remote H5(vanilla,无构建)
 * 路由:#/login  #/(会话列表)  #/s/{id}(聊天)
 * 约定:网关同源;REST 信封 {code:0,msg,data};WS 帧 JSON。
 */
(function () {
  'use strict';

  // ---------------- 工具 ----------------
  var $app = document.getElementById('app');
  var $toastRoot = document.getElementById('toast-root');

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toast(msg, isErr) {
    var t = el('div', 'toast' + (isErr ? ' err' : ''), msg);
    $toastRoot.appendChild(t);
    setTimeout(function () { t.remove(); }, 2600);
  }
  function fmtSize(n) {
    if (n < 1024) return n + 'B';
    if (n < 1048576) return (n / 1024).toFixed(0) + 'KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + 'MB';
    return (n / 1073741824).toFixed(2) + 'GB';
  }
  // 服务端时间戳有时是 UTC 但缺 Z 后缀,统一按 UTC 解析再转本地
  function parseTs(ts) {
    if (typeof ts === 'string' && !/(Z|[+-]\d{2}:?\d{2})$/.test(ts)) ts += 'Z';
    return new Date(ts);
  }
  function fmtTime(ts) {
    var d = parseTs(ts); if (isNaN(d)) return '';
    var diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
    if (diff < 172800) return '昨天';
    return (d.getMonth() + 1) + '-' + d.getDate();
  }
  function debounce(fn, ms) {
    var t; return function () { clearTimeout(t); var a = arguments, s = this; t = setTimeout(function () { fn.apply(s, a); }, ms); };
  }

  // ---------------- 状态 ----------------
  var state = {
    authed: false,
    sessions: [], showArchived: false,
    overlay: {},               // 网关 overlay:{sid:{title?,pinned?}}
    sid: null, msgs: [], hasMore: false, busy: false, earlierLoading: false,
    sessionInfo: null, statusData: null,
    promptsInfo: { active: null, queued: [] },   // GET /prompts 的权威队列(active+queued)
    queuedTimeMap: {},                           // prompt_id → 首次见到的时间(服务端无 created_at 时兜底)
    lastCompletedPrompt: null,                   // {text, at} 执行完的淡出记录
    pendingMsgs: [],
    inFlight: null,
    attachments: [],
    models: [], skills: [],
    modelOverride: null, permOverride: null, planOverride: null, thinkingOverride: null,
    approvals: [], questions: [],
    onlyMine: false,
    guardMap: {},               // sid → {bash:n, subagent:n, cron:n}(主轮空但有守护任务)
    tasksCache: { ts: 0 },
    activity: null,             // 详情页活动数据 {tasks, running, byKind, children}
    healthTimer: null, pollTimer: null, statusTimer: null, listTimer: null,
  };

  // ---------------- API ----------------
  // 网络/502 失败自动重试一次(间隔 1.2s):Clash 核心重启会造成秒级抖动,重试把它抹平
  function api(path, opts) {
    opts = opts || {};
    function attempt(retried) {
      return fetch(path, {
        method: opts.method || 'GET',
        headers: opts.body ? { 'content-type': 'application/json' } : undefined,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        credentials: 'same-origin',
      }).then(function (res) {
        if (res.status === 401) { goLogin(); throw new Error('unauthorized'); }
        if (res.status === 502 && !retried) {
          return new Promise(function (r) { setTimeout(r, 1200); }).then(function () { return attempt(true); });
        }
        if (res.status === 204) return null;
        return res.json().then(function (j) {
          if (!res.ok || (j && j.code !== 0 && j.code !== undefined)) {
            throw new Error((j && j.msg) || ('HTTP ' + res.status));
          }
          return j ? j.data : null;
        });
      }, function (netErr) {
        if (!retried) {
          return new Promise(function (r) { setTimeout(r, 1200); }).then(function () { return attempt(true); });
        }
        throw netErr;
      });
    }
    return attempt(false);
  }

  // ---------------- WS ----------------
  var ws = {
    conn: null, ok: false, delay: 1000,
    connect: function () {
      var self = this;
      if (self.conn && (self.conn.readyState === 0 || self.conn.readyState === 1)) return;
      var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      var c = new WebSocket(proto + '//' + location.host + '/ws');
      self.conn = c;
      c.onopen = function () {
        self.ok = true; self.delay = 1000;
        renderConnBar();
        c.send(JSON.stringify({ type: 'client_hello', id: 'h-' + Date.now(), payload: { client_id: 'h5-' + Math.random().toString(36).slice(2, 10), subscriptions: [] } }));
        if (state.sid) self.subscribe(state.sid);
      };
      c.onmessage = function (ev) {
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        self.onFrame(m);
      };
      c.onclose = function () {
        self.ok = false; self.conn = null; renderConnBar();
        setTimeout(function () { self.connect(); }, self.delay);
        self.delay = Math.min(self.delay * 2, 30000);
      };
      c.onerror = function () { try { c.close(); } catch (e) {} };
    },
    subscribe: function (sid) {
      if (this.ok && this.conn) {
        this.conn.send(JSON.stringify({ type: 'subscribe', id: 's-' + Date.now(), payload: { session_ids: [sid] } }));
      }
    },
    onFrame: function (m) {
      if (m.type === 'session_event') {
        if (m.session_id === state.sid) {
          scheduleRefresh();
          refreshInteractions();
          pollStatusOnce();
        } else if (!state.sid) {
          scheduleListRefresh();
        }
        touchSession(m.session_id);
      } else if (m.type === 'resync_required') {
        if (state.sid) loadMessages(state.sid);
      }
      // server_hello / ack / error / pong:无需处理
    },
  };

  var scheduleListRefresh = debounce(function () {
    if (!state.sid) loadSessions({ quiet: true });
  }, 800);

  var scheduleRefresh = debounce(function () {
    if (state.sid) { loadMessages(state.sid, { quiet: true }); loadStatus(state.sid); }
  }, 350);

  var refreshInteractions = debounce(function () {
    if (!state.sid) return;
    api('/api/v1/sessions/' + state.sid + '/approvals?status=pending').then(function (d) {
      state.approvals = (d && d.items) || []; renderInteractionCards();
    }).catch(function () {});
    api('/api/v1/sessions/' + state.sid + '/questions?status=pending').then(function (d) {
      state.questions = (d && d.items) || []; renderInteractionCards();
    }).catch(function () {});
  }, 300);

  function touchSession(sid) {
    var s = state.sessions.find(function (x) { return x.id === sid; });
    if (s) s.updated_at = new Date().toISOString();
  }

  // ---------------- 路由 ----------------
  function goLogin() {
    state.authed = false;
    if (location.hash !== '#/login') location.hash = '#/login';
  }
  function router() {
    var h = location.hash || '#/';
    stopViewTimers();
    if (h === '#/login') return renderLogin();
    if (h === '#/fleet') return renderFleet();
    var fds = h.match(/^#\/fs\/([^/]+)\/(.+)$/);
    if (fds) return renderFleetDetail(decodeURIComponent(fds[1]), decodeURIComponent(fds[2]));
    var inv = h.match(/^#\/invite\/(.+)$/);
    if (inv) return renderInvite(decodeURIComponent(inv[1]));
    var m = h.match(/^#\/s\/(.+)$/);
    if (m) return renderChat(decodeURIComponent(m[1]));
    return renderList();
  }

  function stopViewTimers() {
    if (state.healthTimer) { clearInterval(state.healthTimer); state.healthTimer = null; }
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
    if (state.statusTimer) { clearInterval(state.statusTimer); state.statusTimer = null; }
    if (state.listTimer) { clearInterval(state.listTimer); state.listTimer = null; }
    if (state.liveTimer) { clearInterval(state.liveTimer); state.liveTimer = null; }
  }

  // ---------------- 邀请认领页 ----------------
  function renderInvite(token) {
    $app.innerHTML =
      '<div class="login-wrap"><div class="login-card">' +
      '<h1>加入 Kimi Remote</h1><div class="sub" id="inv-sub">你收到一个成员邀请,设置账号即可使用</div>' +
      '<input id="inv-name" placeholder="用户名(字母数字._-)" autocomplete="username">' +
      '<input id="inv-pw" type="password" placeholder="设置密码(至少 6 位)" autocomplete="new-password">' +
      '<div class="login-err" id="inv-err"></div>' +
      '<button class="btn" id="inv-ok">确认入驻</button>' +
      '</div></div>';

    fetch('/invites/' + encodeURIComponent(token), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || j.code !== 0) {
          document.getElementById('inv-sub').textContent = '邀请链接无效或已过期,请向管理员重新索取';
          document.getElementById('inv-ok').disabled = true;
        } else if (j.data.note) {
          document.getElementById('inv-sub').textContent = j.data.note;
        }
      }).catch(function () {});

    function claim() {
      var name = document.getElementById('inv-name').value.trim();
      var pw = document.getElementById('inv-pw').value;
      var err = document.getElementById('inv-err');
      err.textContent = '';
      fetch('/invites/' + encodeURIComponent(token) + '/claim', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: name, password: pw }), credentials: 'same-origin',
      }).then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
        .then(function (o) {
          if (o.j && o.j.code === 0) {
            state.authed = true;
            $app.innerHTML =
              '<div class="login-wrap"><div class="login-card">' +
              '<h1>入驻成功 ✅</h1><div class="sub">欢迎,' + escHtml(name) + '</div>' +
              '<p style="font-size:14px;color:var(--text2);margin-bottom:16px">你现在已经可以看到被授权机器的会话了。自己的 Mac 要接入,请联系管理员获取一行安装命令。</p>' +
              '<button class="btn" id="inv-go">进入会话列表</button></div></div>';
            document.getElementById('inv-go').onclick = function () { location.hash = '#/'; };
          } else {
            err.textContent = (o.j && o.j.msg) || '认领失败(' + o.s + ')';
          }
        }).catch(function () { err.textContent = '网络错误,请重试'; });
    }
    document.getElementById('inv-ok').onclick = claim;
    document.getElementById('inv-pw').onkeydown = function (e) { if (e.key === 'Enter') claim(); };
  }

  // ---------------- 登录页 ----------------
  function renderLogin() {
    $app.innerHTML =
      '<div class="login-wrap"><div class="login-card">' +
      '<h1>Kimi Remote</h1><div class="sub">手机远程控制本机 Kimi Code</div>' +
      '<input id="uname" placeholder="用户名(单账号环境留空)" autocomplete="username">' +
      '<input id="pw" type="password" placeholder="访问密码" autocomplete="current-password">' +
      '<div class="login-err" id="pwerr"></div>' +
      '<button class="btn" id="pwbtn">登 录</button>' +
      '<div style="text-align:center;margin-top:14px;font-size:11px;color:var(--text2)">v' + (window.APP_VERSION || '?') + '</div>' +
      '</div></div>';
    var $pw = document.getElementById('pw');
    function submit() {
      var $err = document.getElementById('pwerr');
      $err.textContent = '';
      var username = document.getElementById('uname').value.trim();
      fetch('/login', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: $pw.value, username: username || undefined }), credentials: 'same-origin',
      }).then(function (res) {
        if (res.status === 204) { state.authed = true; location.hash = '#/'; }
        else if (res.status === 429) $err.textContent = '尝试过多,请 10 分钟后再试';
        else $err.textContent = '用户名或密码错误';
      }).catch(function () { $err.textContent = '网络错误,请重试'; });
    }
    document.getElementById('pwbtn').onclick = submit;
    $pw.onkeydown = function (e) { if (e.key === 'Enter') submit(); };
    $pw.focus();
  }

  // ---------------- 机群联邦页(#/fleet) ----------------
  var FLEET_HARNESS = {
    kimi: { label: 'Kimi', color: '#5b7cfa' },
    codex: { label: 'Codex', color: '#3fb27f' },
    claude: { label: 'Claude Code·壳', color: '#e0a458' },
    zcode: { label: 'Z Code', color: '#a06ee8' },
    workbuddy: { label: 'WorkBuddy', color: '#4fc3d9' },
  };

  function renderFleet() {
    $app.innerHTML =
      '<div class="topbar"><button class="icon-btn" id="btn-back">‹</button>' +
      '<h1>机群 · 全部会话</h1>' +
      '<button class="icon-btn" id="btn-refresh" title="刷新">⟳</button></div>' +
      '<div id="offbar"></div><div id="connbar"></div>' +
      '<div class="view"><div class="wrap" id="fleet-wrap">' +
      '<div class="skel-item"></div><div class="skel-item"></div></div></div>';
    document.getElementById('btn-back').onclick = function () { location.hash = '#/'; };
    document.getElementById('btn-refresh').onclick = loadFleet;
    ws.connect(); renderConnBar();
    loadFleet();
    state.listTimer = setInterval(function () { if (!document.hidden) loadFleet({ quiet: true }); }, 20000);
  }

  function loadFleet(opts) {
    opts = opts || {};
    var wrap = document.getElementById('fleet-wrap');
    if (!wrap) return;
    Promise.all([
      api('/fleet/sessions?limit=60').catch(function (e) { return { __err: e.message }; }),
      api('/api/v1/sessions?page_size=50').catch(function () { return { items: [] }; }),
    ]).then(function (arr) {
      var fleet = arr[0], kimi = arr[1];
      if (fleet && fleet.__err) {
        wrap.innerHTML = '<div class="empty">联邦探针离线:' + escHtml(fleet.__err) + '<br>kimi 会话不受影响,回上一页可用</div>';
        return;
      }
      var items = ((fleet && fleet.items) || []).slice();
      var kimiItems = (kimi && kimi.items) || [];
      kimiItems.forEach(function (s) {
        items.push({
          harness: 'kimi', id: s.id,
          title: displayTitle(s),
          cwd: (s.metadata && s.metadata.cwd) || null,
          updated_at: s.updated_at, archived: s.archived, busy: !!(s.busy || s.main_turn_active), _kimi: s,
        });
      });
      items.sort(function (a, b) { return String(b.updated_at).localeCompare(String(a.updated_at)); });
      state.fleetItems = items;

      // 顶部生命体征卡(每 harness:计数 + 最新活动 + 运行态)
      var stats = {};
      items.forEach(function (s) {
        var st = stats[s.harness] || (stats[s.harness] = { count: 0, latest: '', busy: 0 });
        st.count++;
        if (String(s.updated_at) > st.latest) st.latest = String(s.updated_at);
        if (s.busy) st.busy++;
      });
      var html = '<div class="fleet-vitals">' + Object.keys(FLEET_HARNESS).map(function (h) {
        var st = stats[h];
        if (!st) return '';
        var m = FLEET_HARNESS[h];
        return '<div class="vital-card" style="border-top-color:' + m.color + '">' +
          '<div class="vital-name" style="color:' + m.color + '">' + m.label + '</div>' +
          '<div class="vital-count">' + st.count + '</div>' +
          '<div class="vital-sub">' +
          (st.busy ? '<span class="st st-run"><span class="dot pulse"></span>' + st.busy + ' 运行中 · </span>' : '') +
          fmtTime(st.latest) + '</div></div>';
      }).join('') + '</div>' +
        '<div class="fleet-note">每条 = 壳(工具) + 模型标签(真实驱动模型);「Claude Code·壳」均由国产模型驱动,与 Anthropic 账号无关</div>';

      if (!items.length) { wrap.innerHTML = html + '<div class="empty">各源都没有会话</div>'; return; }
      items.forEach(function (s) {
        var m = FLEET_HARNESS[s.harness] || { label: s.harness, color: '#9a9aa3' };
        // 非 kimi 源没有 busy 字段:近 5 分钟有写入视为「活跃」(owner 反馈「蜂群在跑但全显示空闲」)
        var isActive = !s.busy && s.harness !== 'kimi' && s.updated_at &&
          (Date.now() - new Date(s.updated_at).getTime()) < 5 * 60 * 1000;
        var busy = s.busy ? '<span class="st st-run"><span class="dot pulse"></span>运行中</span>'
          : isActive ? '<span class="st st-guard"><span class="dot pulse"></span>活跃</span>' : '';
        var arch = s.archived ? '<span class="badge archived">归档</span>' : '';
        var cwdShort = s.cwd ? String(s.cwd).replace(/^\/Users\/essence/, '~') : '';
        html +=
          '<button class="sess-item fleet-item" data-h="' + s.harness + '" data-id="' + escHtml(s.id) + '">' +
          '<div class="sess-main"><div class="sess-title">' +
          '<span class="fleet-h" style="background:' + m.color + '">' + m.label + '</span>' +
          escHtml(s.title || '(无标题)') + '</div>' +
          '<div class="sess-meta">' + busy + arch +
          (s.model ? '<span class="sess-tag">' + escHtml(s.model) + '</span>' : '') +
          (cwdShort ? '<span>' + escHtml(cwdShort) + '</span>' : '') +
          '<span>' + fmtTime(s.updated_at) + '</span></div></div>' +
          '<span style="color:var(--text2)">›</span></button>';
      });
      wrap.innerHTML = html;
      // kimi 会话可点进详情;其他源 v1 只读(点击提示)
      wrap.querySelectorAll('.fleet-item').forEach(function (b) {
        b.onclick = function () {
          if (b.dataset.h === 'kimi') location.hash = '#/s/' + encodeURIComponent(b.dataset.id);
          else location.hash = '#/fs/' + encodeURIComponent(b.dataset.h) + '/' + encodeURIComponent(b.dataset.id);
        };
      });
    }).catch(function (e) {
      if (!opts.quiet) wrap.innerHTML = '<div class="empty">加载失败:' + escHtml(e.message) + '</div>';
    });
  }

  // ---------------- 他源会话详情(#/fs/:h/:id,只读 + claude 接管) ----------------
  function renderFleetDetail(harness, id) {
    var m = FLEET_HARNESS[harness] || { label: harness, color: '#9a9aa3' };
    var item = (state.fleetItems || []).find(function (s) { return s.harness === harness && s.id === id; }) || {};
    state.fd = { harness: harness, id: id, file: item.file || '', cwd: item.cwd || '', title: item.title || '' };
    $app.innerHTML =
      '<div class="topbar"><button class="icon-btn" id="btn-back">‹</button>' +
      '<h1><span class="fleet-h" style="background:' + m.color + '">' + m.label + '</span> ' + escHtml(item.title || '会话详情') + '</h1>' +
      '<button class="icon-btn" id="btn-refresh" title="刷新">⟳</button></div>' +
      '<div class="view"><div class="wrap" id="fd-wrap"><div class="skel-item"></div><div class="skel-item"></div></div></div>' +
      (harness === 'claude' || harness === 'codex'
        ? '<div class="composer"><div class="composer-inner"><div class="input-row">' +
          '<textarea id="fd-input" rows="1" placeholder="接管这个 ' + m.label + ' 会话,直接对它说话…"></textarea>' +
          '<button class="round-btn send" id="fd-send" title="发送">↑</button></div></div></div>'
        : '<div class="reconn-bar">该源 v1 只读;接管目前开放 Claude / Codex</div>');
    document.getElementById('btn-back').onclick = function () { location.hash = '#/fleet'; };
    document.getElementById('btn-refresh').onclick = loadFleetDetail;
    loadFleetDetail();
    state.listTimer = setInterval(function () { if (!document.hidden) loadFleetDetail({ quiet: true }); }, 15000);
    if (harness === 'claude' || harness === 'codex') {
      var input = document.getElementById('fd-input');
      input.addEventListener('input', function () {
        input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 132) + 'px';
      });
      document.getElementById('fd-send').onclick = function () {
        var text = input.value.trim();
        if (!text) return;
        input.value = ''; input.style.height = 'auto';
        fdTakeover(text);
      };
    }
  }

  function loadFleetDetail(opts) {
    opts = opts || {};
    var wrap = document.getElementById('fd-wrap');
    if (!wrap || !state.fd) return;
    var q = '/fleet/messages?h=' + encodeURIComponent(state.fd.harness) +
      '&id=' + encodeURIComponent(state.fd.id) +
      '&file=' + encodeURIComponent(state.fd.file) + '&limit=120';
    api(q).then(function (d) {
      var items = (d && d.items) || [];
      if (!items.length) { wrap.innerHTML = '<div class="empty">没有可读消息(或该源只存了索引)</div>'; return; }
      var html = '';
      items.forEach(function (msg) {
        if (msg.role === 'user') {
          html += '<div class="msg user"><div class="bubble">' + escHtml(msg.text) + '</div></div>';
        } else {
          html += '<div class="msg assistant"><div class="bubble">' + window.MD.render(msg.text) + '</div></div>';
        }
      });
      wrap.innerHTML = html;
      if (!opts.quiet) {
        var v = document.querySelector('.view');
        if (v) v.scrollTop = v.scrollHeight;
      }
    }).catch(function (e) {
      if (!opts.quiet) wrap.innerHTML = '<div class="empty">加载失败:' + escHtml(e.message) + '</div>';
    });
  }

  function fdTakeover(text) {
    var wrap = document.getElementById('fd-wrap');
    wrap.innerHTML += '<div class="msg user"><div class="bubble">' + escHtml(text) + '</div></div>' +
      '<div class="msg assistant" id="fd-pending"><div class="bubble"><span class="spin"></span> Claude 思考中…</div></div>';
    var v = document.querySelector('.view'); if (v) v.scrollTop = v.scrollHeight;
    api('/fleet/takeover', {
      method: 'POST',
      body: { harness: state.fd.harness, id: state.fd.id, text: text, cwd: state.fd.cwd },
    }).then(function (d) {
      var r = (d && d.result) || '';
      var p = document.getElementById('fd-pending');
      if (p) p.outerHTML = '<div class="msg assistant"><div class="bubble">' + window.MD.render(r || '(无文本结果)') + '</div></div>';
      if (v) v.scrollTop = v.scrollHeight;
      setTimeout(function () { loadFleetDetail({ quiet: true }); }, 1500);
    }).catch(function (e) {
      var p = document.getElementById('fd-pending');
      if (p) p.outerHTML = '<div class="msg assistant"><div class="bubble" style="color:var(--danger)">接管失败:' + escHtml(e.message) + '</div></div>';
    });
  }

  // ---------------- 会话列表页 ----------------
  function renderList() {
    state.sid = null;
    $app.innerHTML =
      '<div class="topbar"><h1>Kimi Remote</h1>' +
      '<button class="icon-btn" id="btn-fleet" title="机群">⬢</button>' +
      '<button class="icon-btn" id="btn-refresh" title="刷新">⟳</button>' +
      '<button class="icon-btn" id="btn-new" title="新建会话">＋</button>' +
      '<div class="menu"><button class="icon-btn" id="btn-menu">⋮</button>' +
      '<div class="menu-pop" id="menu-pop" style="display:none">' +
      '<button id="m-arch"></button><button id="m-logout">退出登录</button>' +
      '</div></div></div>' +
      '<div id="offbar"></div><div id="connbar"></div>' +
      '<div class="view"><div class="wrap" id="sess-wrap">' +
      '<div class="skel-item"></div><div class="skel-item"></div><div class="skel-item"></div></div></div>';

    document.getElementById('btn-refresh').onclick = loadSessions;
    document.getElementById('btn-fleet').onclick = function () { location.hash = '#/fleet'; };
    document.getElementById('btn-new').onclick = function () { openNewSessionSheet(); };
    var pop = document.getElementById('menu-pop');
    document.getElementById('btn-menu').onclick = function () {
      pop.style.display = pop.style.display === 'none' ? 'block' : 'none';
    };
    document.getElementById('m-arch').textContent = state.showArchived ? '隐藏已归档' : '显示已归档';
    document.getElementById('m-arch').onclick = function () {
      state.showArchived = !state.showArchived; pop.style.display = 'none'; renderList();
    };
    document.getElementById('m-logout').onclick = function () {
      fetch('/logout', { method: 'POST', credentials: 'same-origin' }).finally(goLogin);
    };

    loadSessions();
    ws.connect(); renderConnBar();
    checkHealth();
    state.healthTimer = setInterval(checkHealth, 30000);
    // 列表页 15s 轮询 + WS 事件驱动刷新,状态点保持实时
    state.listTimer = setInterval(function () { if (!document.hidden) loadSessions({ quiet: true }); }, 15000);
  }

  function checkHealth() {
    fetch('/healthz', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) {
      var bar = document.getElementById('offbar'); if (!bar) return;
      bar.innerHTML = (j && j.upstream === false)
        ? '<div class="offline-bar">⚠ Mac 离线 — 隧道未连接,请确认 Mac 开机且未休眠</div>' : '';
    }).catch(function () {});
  }

  function renderConnBar() {
    var bar = document.getElementById('connbar'); if (!bar) return;
    bar.innerHTML = ws.ok ? '' : '<div class="reconn-bar">连接断开,重连中…</div>';
  }

  function loadSessions(opts) {
    opts = opts || {};
    var wrap = document.getElementById('sess-wrap');
    if (!wrap) return;
    var keepScroll = wrap.parentElement ? wrap.parentElement.scrollTop : 0;
    var url = '/api/v1/sessions?page_size=50' + (state.showArchived ? '&include_archive=1' : '');
    Promise.all([api(url), loadOverlay()]).then(function (arr) {
      var d = arr[0];
      state.sessions = (d && d.items) || [];
      state.sessions.sort(function (a, b) {
        var pa = state.overlay[a.id] && state.overlay[a.id].pinned ? 1 : 0;
        var pb = state.overlay[b.id] && state.overlay[b.id].pinned ? 1 : 0;
        if (pa !== pb) return pb - pa;
        return String(b.updated_at).localeCompare(String(a.updated_at));
      });
      if (!state.sessions.length) {
        wrap.innerHTML = '<div class="empty">暂无会话,点右上角 ＋ 新建</div>';
        return;
      }
      wrap.innerHTML = '';
      // 重名检测(displayTitle 可能触发 D-17 过期清理,先算后渲染保证一致)
      var dupes = dupTitleSet(state.sessions);
      // 系统会话分组(2026-07-21 owner:列表里系统创建的太多,默认折叠)
      var isSys = function (s) {
        var t = displayTitle(s) || '';
        return /^H5裁决·/.test(t) || t === '/usage' ||
          (t === 'New Session' && !(s.last_prompt || '').trim()) ||
          /^(dbg\d|.*-probe|smoke|R\d{3}|executor-watchdog)/.test(t);
      };
      var sysItems = state.sessions.filter(isSys);
      var userItems = state.sessions.filter(function (s) { return !isSys(s); });
      userItems.forEach(function (s) {
        wrap.appendChild(sessionItem(s, dupes.has(normTitle(displayTitle(s)))));
      });
      if (sysItems.length) {
        var foldKey = 'kr-sys-fold';
        var folded = localStorage.getItem(foldKey) !== '0'; // 默认折叠
        var head = el('button', 'sys-group-head');
        head.innerHTML = '<span class="sys-caret">' + (folded ? '▸' : '▾') + '</span> 系统会话 (' + sysItems.length + ')';
        head.onclick = function () {
          folded = !folded;
          localStorage.setItem(foldKey, folded ? '1' : '0');
          head.querySelector('.sys-caret').textContent = folded ? '▸' : '▾';
          sysBox.style.display = folded ? 'none' : '';
        };
        wrap.appendChild(head);
        var sysBox = el('div', 'sys-group');
        sysBox.style.display = folded ? 'none' : '';
        sysItems.forEach(function (s) {
          sysBox.appendChild(sessionItem(s, dupes.has(normTitle(displayTitle(s)))));
        });
        wrap.appendChild(sysBox);
      }
      if (wrap.parentElement && opts.quiet) wrap.parentElement.scrollTop = keepScroll;
      // 订阅全部会话事件,状态点实时刷新
      if (ws.ok) ws.subscribe(state.sessions.map(function (s) { return s.id; }));
      // 守护状态富化:非运行中的会话惰性探测守护任务(并发 4)
      enrichGuardStates();
    }).catch(function (e) {
      if (!opts.quiet) wrap.innerHTML = '<div class="empty">加载失败:' + escHtml(e.message) + '</div>';
    });
  }

  // 守护探测:主轮空闲的会话可能还有 bash 守护/子代理/cron 在跑(tasks 里 status=running)
  var guardLoading = false;
  function enrichGuardStates() {
    if (guardLoading || document.hidden) return;
    guardLoading = true;
    var candidates = state.sessions.filter(function (s) {
      return !(s.busy || s.main_turn_active);
    });
    var i = 0;
    function next() {
      if (i >= candidates.length) { guardLoading = false; state.tasksCache.ts = Date.now(); return; }
      var batch = candidates.slice(i, i + 4); i += 4;
      Promise.all(batch.map(function (s) {
        return api('/api/v1/sessions/' + s.id + '/tasks').then(function (d) {
          var running = ((d && d.items) || []).filter(function (t) { return t.status === 'running'; });
          var g = {};
          running.forEach(function (t) { var k = t.kind || 'bash'; g[k] = (g[k] || 0) + 1; });
          if (running.length) state.guardMap[s.id] = g;
          else delete state.guardMap[s.id];
        }).catch(function () {});
      })).then(function () {
        // 增量更新 pill(不重排不重置滚动)
        var wrap = document.getElementById('sess-wrap');
        if (wrap && !state.sid) {
          wrap.querySelectorAll('.sess-item').forEach(function (itemEl, idx) {
            var s = state.sessions[idx];
            if (!s) return;
            var meta = itemEl.querySelector('.sess-meta .st');
            if (meta) {
              var tmp = document.createElement('span');
              tmp.innerHTML = statusPill(s);
              meta.replaceWith(tmp.firstChild);
            }
          });
        }
        next();
      });
    }
    next();
  }

  // ---------------- overlay(重命名/置顶)与派生信息 ----------------
  function loadOverlay() {
    return fetch('/overlay/session-meta', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (j) { state.overlay = (j && j.data && j.data.sessions) || {}; })
      .catch(function () {});
  }

  function saveOverlay(id, patch) {
    return fetch('/overlay/sessions/' + encodeURIComponent(id), {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch), credentials: 'same-origin',
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.code === 0) {
        if (Object.keys(j.data || {}).length) state.overlay[id] = j.data;
        else delete state.overlay[id];
      }
      return j;
    });
  }

  // 剥离系统注入内容(<system-reminder>/<system> 块)——标题派生与「我的输入」共用
  function stripSystem(text) {
    if (!text) return '';
    return String(text)
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
      .replace(/<system>[\s\S]*?<\/system>/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  function isSystemInjected(text) {
    return /<system-reminder>|<system>/.test(text || '');
  }

  // 消息来源判定(2026-07-20 根治「系统注入显示成用户消息」):
  // 优先 metadata.origin.kind —— kimi server 实测枚举:user(本人输入)/injection(系统注入,
  // 带 variant 如 todo_list_reminder、image_compression)/task(任务通知)/compaction_summary
  // (上下文压缩)/skill_activation(技能激活)。除显式 user 外一律算注入;
  // 无元数据(老消息)再退文本特征:<system-reminder>/<system> 块、STEER-PROBE 类探针前缀、
  // <notification> 任务通知前缀。
  function msgOriginKind(m) {
    var md = m && m.metadata, o = md && md.origin;
    return (o && o.kind) || null;
  }
  function isInjectedUserMsg(m, rawText) {
    if ((m && m.role) !== 'user') return false;
    var kind = msgOriginKind(m);
    if (kind) return kind !== 'user';
    var t = rawText || '';
    if (isSystemInjected(t)) return true;
    return /^\s*(STEER-PROBE|<notification[\s>])/.test(t);
  }
  function injectLabel(m) {
    var kind = msgOriginKind(m);
    var variant = m && m.metadata && m.metadata.origin && m.metadata.origin.variant;
    if (kind === 'task') return '任务通知';
    if (kind === 'compaction_summary') return '上下文压缩摘要';
    if (kind === 'skill_activation') return '技能激活指令';
    return '系统注入' + (variant ? ' · ' + variant : '');
  }

  function displayTitle(s) {
    var o = state.overlay[s.id];
    if (o && o.title) {
      // D-17 对齐:overlay 落笔时的上游 title 与当前一致 → overlay 是最新,用它;
      // 上游此后又改过名 → 上游最新,overlay 过期,静默清除后以最新/title为准
      if (!o.base_title || (o.base_title === (s.title || ''))) return o.title;
      expireOverlayTitle(s.id);
    }
    if (s.title && s.title !== 'New Session') return s.title;
    var derived = stripSystem(s.last_prompt || '').slice(0, 42);
    return derived || (s.metadata && s.metadata.cwd) || s.id.slice(0, 18);
  }

  // 上游改名后清掉过期 overlay title(D-17;fire-and-forget)
  function expireOverlayTitle(id) {
    if (state.overlay[id]) delete state.overlay[id].title;
    fetch('/overlay/sessions/' + encodeURIComponent(id), {
      method: 'PUT', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: null }),
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.code === 0) {
        if (Object.keys(j.data || {}).length) state.overlay[id] = j.data;
        else delete state.overlay[id];
      }
    }).catch(function () {});
  }

  // 来源 tag:zaios 调度 / 临时 / Work 项目——解决「分不清谁建的」
  function sourceTag(s) {
    var cwd = (s.metadata && s.metadata.cwd) || '';
    if (/\/Work\/zaios/.test(cwd)) return 'zaios 调度';
    if (cwd === '/tmp' || cwd === '/private/tmp') return '临时';
    var m = cwd.match(/\/Work\/([^/]+)/);
    if (m) return 'Work/' + m[1];
    return null;
  }

  // 会话状态点(列表/详情共用):待处理(橙)>运行中(脉冲绿)>守护中(青)>空闲(灰)
  function statusPill(s) {
    if (s.pending_interaction && s.pending_interaction !== 'none') return '<span class="st st-pend"><span class="dot"></span>待处理</span>';
    if (s.busy || s.main_turn_active) return '<span class="st st-run"><span class="dot pulse"></span>运行中</span>';
    if (state.guardMap[s.id]) return '<span class="st st-guard"><span class="dot"></span>守护中</span>';
    return '<span class="st st-idle"><span class="dot"></span>空闲</span>';
  }

  function normTitle(t) { return String(t || '').trim().toLowerCase(); }

  // 重名会话集合(归一化标题出现 ≥2 次)
  function dupTitleSet(list) {
    var seen = {}, dup = new Set();
    list.forEach(function (s) {
      var t = normTitle(displayTitle(s));
      if (!t) return;
      if (seen[t]) dup.add(t);
      seen[t] = true;
    });
    return dup;
  }

  function sessionItem(s, isDup) {
    var b = el('button', 'sess-item');
    var archived = s.archived ? '<span class="badge archived">已归档</span>' : '';
    var dup = isDup ? '<span class="badge pending">重名</span>' : '';
    var pin = (state.overlay[s.id] && state.overlay[s.id].pinned) ? '<span class="pin">📌</span>' : '';
    var tag = sourceTag(s);
    b.innerHTML =
      '<div class="sess-main"><div class="sess-title">' + pin + escHtml(displayTitle(s)) + '</div>' +
      '<div class="sess-meta">' + statusPill(s) + archived + dup +
      (tag ? '<span class="sess-tag">' + escHtml(tag) + '</span>' : '') +
      (s.message_count > 0 ? '<span>' + s.message_count + ' 条</span>' : '') +
      '<span>' + fmtTime(s.updated_at) + '</span></div></div>' +
      '<span style="color:var(--text2)">›</span>';
    b.onclick = function () { location.hash = '#/s/' + encodeURIComponent(s.id); };
    return b;
  }

  // ---------------- 新建会话弹层 ----------------
  function openNewSessionSheet() {
    var mask = el('div', 'mask');
    mask.innerHTML =
      '<div class="sheet"><h2>新建会话</h2>' +
      '<div class="field"><label>标题(可空)</label><input id="ns-title" placeholder="给会话起个名"></div>' +
      '<div class="field"><label>工作目录 cwd</label><input id="ns-cwd" value="~">' +
      '<div class="chips" id="ns-cwd-chips"><button class="chip" data-cwd="~">~</button></div></div>' +
      '<div class="field"><label>模型</label><select id="ns-model"><option value="">默认</option></select></div>' +
      '<div class="field"><label>权限模式</label><select id="ns-perm">' +
      '<option value="auto" selected>auto(自动批准常规操作)</option>' +
      '<option value="manual">manual(每步手机审批)</option>' +
      '<option value="yolo">yolo(全部自动,慎用)</option></select></div>' +
      '<div class="switch-row"><span>Plan 模式(先出计划)</span><input type="checkbox" id="ns-plan" style="width:22px;height:22px"></div>' +
      '<div class="sheet-row"><button class="btn ghost" id="ns-cancel">取消</button>' +
      '<button class="btn" id="ns-ok">创建</button></div></div>';
    document.body.appendChild(mask);
    mask.onclick = function (e) { if (e.target === mask) mask.remove(); };
    mask.querySelector('#ns-cancel').onclick = function () { mask.remove(); };
    mask.querySelectorAll('.chip').forEach(function (c) {
      c.onclick = function () { mask.querySelector('#ns-cwd').value = c.dataset.cwd; };
    });

    // 模型下拉
    api('/api/v1/models').then(function (d) {
      var items = (d && d.items) || (Array.isArray(d) ? d : []);
      var sel = mask.querySelector('#ns-model');
      items.forEach(function (m) {
        var id = typeof m === 'string' ? m : (m.model || m.id || m.alias || m.name);
        if (!id) return;
        var label = (typeof m === 'object' && m.display_name) ? m.display_name + '(' + id + ')' : id;
        var o = el('option', '', label); o.value = id; sel.appendChild(o);
      });
    }).catch(function () {});

    // cwd 预填:本机 home + 最近工作区(fs:home,替代硬编码路径)
    api('/api/v1/fs:home').then(function (d) {
      var home = d && d.home;
      if (!home) return;
      var input = mask.querySelector('#ns-cwd');
      input.value = home;
      input.dataset.home = home;
      var roots = (d.recent_roots || []).filter(function (r) { return r && r !== home; }).slice(0, 4);
      var chips = mask.querySelector('#ns-cwd-chips');
      if (!chips) return;
      chips.innerHTML = '<button class="chip" data-cwd="' + escHtml(home) + '">~</button>';
      roots.forEach(function (r) {
        var b = el('button', 'chip', escHtml(r.replace(home, '~')));
        b.dataset.cwd = r;
        b.onclick = function () { input.value = r; };
        chips.appendChild(b);
      });
      chips.querySelectorAll('.chip').forEach(function (c) {
        c.onclick = function () { input.value = c.dataset.cwd; };
      });
    }).catch(function () {});

    mask.querySelector('#ns-ok').onclick = function () {
      var body = {
        metadata: { cwd: mask.querySelector('#ns-cwd').value.trim().replace(/^~(?=\/|$)/, mask.querySelector('#ns-cwd').dataset.home || '~') },
        agent_config: {
          permission_mode: mask.querySelector('#ns-perm').value,
          plan_mode: mask.querySelector('#ns-plan').checked,
        },
      };
      var title = mask.querySelector('#ns-title').value.trim();
      if (title) body.title = title;
      var model = mask.querySelector('#ns-model').value;
      if (model) body.agent_config.model = model;
      mask.querySelector('#ns-ok').disabled = true;
      api('/api/v1/sessions', { method: 'POST', body: body }).then(function (d) {
        mask.remove();
        if (d && d.id) location.hash = '#/s/' + encodeURIComponent(d.id);
      }).catch(function (e) {
        toast('创建失败:' + e.message, true);
        mask.querySelector('#ns-ok').disabled = false;
      });
    };
  }

  // ---------------- 聊天页 ----------------
  function renderChat(sid) {
    state.sid = sid; state.msgs = []; state.attachments = []; state.busy = false;
    state.pendingMsgs = []; state.inFlight = null;
    state.msgNodes = new Map(); state.liveText = ''; state.liveThink = '';
    state.turnStartedAt = null; state._domInit = false;
    state.approvals = []; state.questions = []; state.skills = [];
    state.modelOverride = null; state.permOverride = null; state.planOverride = null;

    $app.innerHTML =
      '<div class="topbar">' +
      '<button class="icon-btn" id="btn-back">‹</button>' +
      '<h1 id="chat-title">会话</h1><span id="chat-status"></span>' +
      '<div class="menu"><button class="icon-btn" id="btn-menu">⋮</button>' +
      '<div class="menu-pop" id="menu-pop" style="display:none">' +
      '<button id="m-pin">置顶</button>' +
      '<button id="m-rename">重命名</button>' +
      '<button id="m-mine">只看我的输入</button>' +
      '<button id="m-perm">权限模式</button>' +
      '<button id="m-model">切换模型</button>' +
      '<button id="m-archive">归档会话</button>' +
      '</div></div></div>' +
      '<div id="infobar"></div>' +
      '<div id="activitybar" style="display:none"></div>' +
      '<div id="activity-panel" style="display:none"></div>' +
      '<div id="offbar"></div><div id="connbar"></div>' +
      '<div class="msgs" id="msgs"><div class="msgs-inner" id="msgs-inner">' +
      '<div id="msg-list">' +
      '<div class="skel-msg"></div><div class="skel-msg w60"></div><div class="skel-msg"></div></div>' +
      '<div id="liveview" style="display:none"></div></div></div>' +
      '<div id="interact"></div>' +
      '<div id="runbar" style="display:none"><span class="tdots"><i></i><i></i><i></i></span><span id="runbar-text">正在思考…</span></div>' +
      '<div id="queuebar" style="display:none"></div>' +
      '<div class="composer"><div class="composer-inner">' +
      '<div class="slash-panel" id="slash" style="display:none"></div>' +
      '<div class="attach-chips" id="chips"></div>' +
      '<div class="composer-hint" id="composer-hint" style="display:none"></div>' +
      '<div class="input-wrap"><textarea id="input" rows="1" placeholder="发消息,或输入 / 指令"></textarea></div>' +
      '<div class="action-row">' +
      '<div class="act-left">' +
      '<button class="round-btn" id="btn-attach" title="附件">📎</button>' +
      '<button class="round-btn steer" id="btn-steer" title="立即引导(插入到当前执行中)" style="display:none">⚡</button>' +
      '<button class="round-btn stop" id="btn-stop" title="停止当前执行" style="display:none">■</button>' +
      '</div>' +
      '<button class="round-btn send" id="btn-send" disabled title="发送">↑</button>' +
      '</div>' +
      '<input type="file" id="file-input" multiple style="display:none">' +
      '</div></div>';

    document.getElementById('btn-back').onclick = function () { location.hash = '#/'; };
    var pop = document.getElementById('menu-pop');
    document.getElementById('btn-menu').onclick = function () {
      pop.style.display = pop.style.display === 'none' ? 'block' : 'none';
    };
    document.getElementById('m-archive').onclick = function () {
      pop.style.display = 'none';
      api('/api/v1/sessions/' + sid + ':archive', { method: 'POST' }).then(function () {
        toast('已归档'); location.hash = '#/';
      }).catch(function (e) { toast(e.message, true); });
    };
    document.getElementById('m-pin').onclick = function () {
      pop.style.display = 'none';
      var pinned = !!(state.overlay[sid] && state.overlay[sid].pinned);
      saveOverlay(sid, { pinned: !pinned }).then(function () {
        toast(pinned ? '已取消置顶' : '已置顶');
      }).catch(function () { toast('操作失败', true); });
    };
    document.getElementById('m-mine').onclick = function () {
      pop.style.display = 'none';
      state.onlyMine = !state.onlyMine;
      document.getElementById('m-mine').textContent = state.onlyMine ? '查看全部消息' : '只看我的输入';
      renderMessages();
      if (state.onlyMine) toast('只看我的输入(已隐藏系统注入)');
    };
    document.getElementById('m-rename').onclick = function () {
      pop.style.display = 'none';
      var t = prompt('新标题(留空恢复默认)', displayTitle(state.sessionInfo || { id: sid }));
      if (t == null) return;
      saveOverlay(sid, { title: t.trim() || null }).then(function () {
        document.getElementById('chat-title').textContent = displayTitle(state.sessionInfo || { id: sid });
        toast(t.trim() ? '已重命名' : '已恢复默认标题');
      }).catch(function () { toast('重命名失败', true); });
    };
    document.getElementById('m-perm').onclick = function () {
      pop.style.display = 'none';
      var cur = state.permOverride || (state.sessionInfo && state.sessionInfo.agent_config && state.sessionInfo.agent_config.permission_mode) || 'auto';
      var next = cur === 'auto' ? 'manual' : cur === 'manual' ? 'yolo' : 'auto';
      state.permOverride = next;
      toast('后续消息权限模式:' + next);
    };
    document.getElementById('m-model').onclick = function () {
      pop.style.display = 'none'; openModelPicker();
    };
    document.getElementById('btn-stop').onclick = stopTurn;
    document.getElementById('btn-steer').onclick = function () {
      var inputEl = document.getElementById('input');
      var text = inputEl.value.trim();
      if (!text) { toast('先输入要引导的内容', true); inputEl.focus(); return; }
      steerMessage(text);
      inputEl.value = ''; inputEl.style.height = 'auto'; updateSendBtn();
    };

    setupComposer(sid);
    ws.connect(); renderConnBar(); ws.subscribe(sid);

    loadSessionInfo(sid);
    loadMessages(sid);
    refreshInteractions();
    loadSkills(sid);
    loadActivity(sid);
    checkHealth();
    pollStatusOnce();

    // 状态轮询:驱动状态 chip / 运行指示条 / composer 三态
    state.statusTimer = setInterval(pollStatusOnce, 4000);
    // 流式轮询:忙碌时 1.2s 拉 in_flight 增量文本(打字机)
    state.liveTimer = setInterval(pollLive, 1200);
    // 兜底刷新:无论 WS 生死,每 20s 强刷一次消息(WS 断连/订阅丢失/事件丢失的自愈网)
    state.pollTimer = setInterval(function () {
      if (state.sid && !document.hidden) { loadMessages(sid, { quiet: true }); }
    }, 20000);
  }

  // 流式视图:in_flight_turn.assistant_text / thinking_text 增量渲染为「正在输入」气泡
  function pollLive() {
    var sid = state.sid;
    if (!sid || document.hidden || !state.busy) return;
    api('/api/v1/sessions/' + sid + '/snapshot').then(function (snap) {
      var f = (snap && snap.in_flight_turn) || null;
      var atext = (f && f.assistant_text) || '';
      var think = (f && f.thinking_text) || '';
      if (atext !== state.liveText || think !== state.liveThink) {
        state.liveText = atext; state.liveThink = think;
        renderLiveView();
      }
    }).catch(function () {});
  }

  function renderLiveView() {
    var lv = document.getElementById('liveview');
    if (!lv) return;
    var atext = state.liveText, think = state.liveThink;
    if (!atext && !think) { lv.style.display = 'none'; lv.innerHTML = ''; return; }
    lv.style.display = 'block';
    var html = '<div class="msg assistant live">';
    if (think) {
      html += '<details class="think-card live-think"><summary>💭 正在思考(' + Math.round(think.length / 3) + ' 字)…</summary>' +
        '<div class="body">' + escHtml(think.slice(-3000)) + '</div></details>';
    }
    if (atext) {
      html += '<div class="bubble">' + window.MD.render(atext) + '<span class="cursor">▍</span></div>';
    }
    lv.innerHTML = html + '</div>';
    var msgsEl = document.getElementById('msgs');
    if (msgsEl && stickBottom) msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  // 活动条:后台守护任务 + 子会话(点开展开面板)
  var activityOpen = false;
  function loadActivity(sid) {
    Promise.all([
      api('/api/v1/sessions/' + sid + '/tasks').catch(function () { return null; }),
      api('/api/v1/sessions/' + sid + '/children').catch(function () { return null; }),
    ]).then(function (arr) {
      var bar = document.getElementById('activitybar');
      if (!bar) return;
      var tasks = (arr[0] && arr[0].items) || [];
      var children = (arr[1] && arr[1].items) || [];
      var running = tasks.filter(function (t) { return t.status === 'running'; });
      var byKind = {};
      running.forEach(function (t) { var k = t.kind || 'bash'; byKind[k] = (byKind[k] || 0) + 1; });
      state.activity = { tasks: tasks, running: running, byKind: byKind, children: children };
      if (!running.length && !children.length && !tasks.length) { bar.style.display = 'none'; return; }
      bar.style.display = 'flex';
      var parts = [];
      if (running.length) {
        parts.push('<span class="st st-guard"><span class="dot"></span>守护 ' + running.length +
          '(' + Object.keys(byKind).map(function (k) { return k + ' ' + byKind[k]; }).join(' · ') + ')</span>');
      }
      if (children.length) parts.push('<span class="st st-idle"><span class="dot"></span>子会话 ' + children.length + '</span>');
      if (!running.length && tasks.length) parts.push('<span class="act-hist">历史任务 ' + tasks.length + '</span>');
      parts.push('<span class="qbar-arrow">' + (activityOpen ? '收起 ▴' : '详情 ▾') + '</span>');
      bar.innerHTML = parts.join('');
      bar.onclick = function () {
        activityOpen = !activityOpen;
        renderActivityPanel();
        loadActivity(state.sid);
      };
      renderActivityPanel();
    });
  }

  function renderActivityPanel() {
    var panel = document.getElementById('activity-panel');
    if (!panel) return;
    var a = state.activity;
    if (!activityOpen || !a) { panel.style.display = 'none'; return; }
    panel.style.display = 'block';
    var html = '';
    var list = a.running.concat(a.tasks.filter(function (t) { return t.status !== 'running'; }).slice(0, 8));
    list.forEach(function (t) {
      var icon = t.status === 'running' ? '🟢' : t.status === 'failed' ? '🔴' : '⚪';
      var desc = (t.description || t.kind || 'task').replace(/\s+/g, ' ').slice(0, 64);
      var dur = t.started_at ? fmtTime(t.started_at) : '';
      html += '<div class="act-item">' + icon + ' <span class="act-kind">' + escHtml(t.kind || '?') + '</span>' +
        '<span class="act-desc" title="' + escHtml(t.description || '') + '">' + escHtml(desc) + '</span>' +
        '<span class="act-time">' + dur + '</span></div>';
    });
    if (a.children.length) {
      html += '<div class="act-sep">子会话(子代理)</div>';
      a.children.forEach(function (c) {
        html += '<button class="act-item act-child" data-sid="' + escHtml(c.id) + '">' +
          (c.busy ? '🟢' : '⚪') + '<span class="act-desc">' + escHtml((c.title || c.id).slice(0, 50)) + '</span>›</button>';
      });
    }
    panel.innerHTML = html || '<div class="empty" style="padding:8px">暂无任务</div>';
    panel.querySelectorAll('.act-child').forEach(function (b) {
      b.onclick = function () { location.hash = '#/s/' + encodeURIComponent(b.dataset.sid); };
    });
  }

  // 守护任务轻量轮询(并入 4s 状态轮询;2026-07-20 根修:原先 loadActivity 仅进会话时拉一次,
  // 后台任务后来起跑,chip 永远停在「空闲」——主轮空闲≠没在干活)
  function refreshGuardTasks(sid) {
    api('/api/v1/sessions/' + sid + '/tasks').then(function (d) {
      var tasks = (d && d.items) || [];
      var running = tasks.filter(function (t) { return t.status === 'running'; });
      var byKind = {};
      running.forEach(function (t) { var k = t.kind || 'bash'; byKind[k] = (byKind[k] || 0) + 1; });
      var prev = (state.activity && state.activity.running && state.activity.running.length) || 0;
      state.activity = state.activity || { tasks: [], running: [], byKind: {}, children: [] };
      state.activity.tasks = tasks; state.activity.running = running; state.activity.byKind = byKind;
      if (running.length !== prev) renderStatusChip(state.busy);
    }).catch(function () {});
  }

  // 拉 status + (忙碌时)snapshot,刷新 状态chip / 运行指示条 / composer 三态
  function pollStatusOnce() {
    var sid = state.sid;
    if (!sid || document.hidden) return;
    api('/api/v1/sessions/' + sid + '/status').then(function (d) {
      state.statusData = d || null;
      renderInfobar();
      var busy = !!(d && (d.busy || d.main_turn_active));
      var wasBusy = state.busy;
      renderStatusChip(busy);
      if (wasBusy && !busy) {
        // turn 刚结束:assistant 结论文本此刻才完整落库;WS 事件可能丢,强制全量重拉补齐尾部
        loadMessages(sid, { quiet: true });
      }
      if (busy) {
        api('/api/v1/sessions/' + sid + '/snapshot').then(function (snap) {
          state.inFlight = (snap && snap.in_flight_turn) || null;
          renderRunbar();
        }).catch(function () {});
      } else {
        state.inFlight = null;
        renderRunbar();
      }
    }).catch(function () {});
    refreshGuardTasks(sid);   // 每次状态轮询顺带刷守护任务(chip 守护态的数据源)
    // 权威队列:active + queued(每条含 prompt_id/status/content)
    api('/api/v1/sessions/' + sid + '/prompts').then(function (d) {
      if (!d) return;
      var queued = d.queued || [];
      queued.forEach(function (q) {
        if (!q.created_at && !state.queuedTimeMap[q.prompt_id]) {
          state.queuedTimeMap[q.prompt_id] = new Date().toISOString();
        }
      });
      // active 消失(执行完)时记录「刚完成」,给队列条 8s 淡出而不是瞬间消失
      var newActive = d.active || null;
      if (state.promptsInfo.active && !newActive) {
        state.lastCompletedPrompt = { text: promptText(state.promptsInfo.active), at: Date.now() };
        setTimeout(renderQueueBar, 8100);
      }
      state.promptsInfo = { active: newActive, queued: queued };
      renderQueueBar();
    }).catch(function () {});
  }

  function renderStatusChip(busy) {
    state.busy = !!busy;
    var chip = document.getElementById('chat-status');
    if (chip) {
      var pend = state.approvals.length > 0 || state.questions.length > 0 ||
        (state.sessionInfo && state.sessionInfo.pending_interaction && state.sessionInfo.pending_interaction !== 'none');
      // 守护态(2026-07-20 根修「状态显示空闲但底部还在执行」):主轮空闲但后台任务在跑时必须可见
      var guard = (state.activity && state.activity.running && state.activity.running.length) || 0;
      chip.innerHTML = busy
        ? '<span class="st st-run"><span class="dot pulse"></span>运行中</span>'
        : pend
          ? '<span class="st st-pend"><span class="dot"></span>待处理</span>'
          : guard
            ? '<span class="st st-guard"><span class="dot"></span>守护 ' + guard + '</span>'
            : '<span class="st st-idle"><span class="dot"></span>空闲</span>';
    }
    renderComposerMode();
  }

  // 排队条:权威队列展示——▶执行中(active)+ ⏳排队N条(逐条操作)+ ✓刚完成(淡出)
  // 解决「指令消失」:queued→active→done 全生命周期在条内可见,不跳变
  var queueExpanded = false;
  function renderQueueBar() {
    var bar = document.getElementById('queuebar');
    if (!bar) return;
    var active = state.promptsInfo.active;
    var queued = state.promptsInfo.queued;
    var done = state.lastCompletedPrompt;

    if (!active && !queued.length) {
      if (done && (Date.now() - done.at) < 8000) {
        bar.style.display = 'block';
        bar.innerHTML = '<div class="qbar-head done">✓ 已开始执行并处理完:' + escHtml(done.text.slice(0, 50)) + '</div>';
      } else {
        bar.style.display = 'none';
      }
      return;
    }
    bar.style.display = 'block';

    var html = '';
    // ▶ 当前执行
    if (active) {
      var atext = promptText(active);
      var ats = active.created_at || state.queuedTimeMap[active.prompt_id];
      html += '<div class="qbar-item active">' +
        '<span class="qbar-live">▶</span>' +
        '<span class="qbar-time">' + fmtClock(ats) + '</span>' +
        '<span class="qbar-text" title="' + escHtml(atext) + '">正在执行:' + escHtml(atext.slice(0, 50)) + '</span>' +
        '</div>';
    }
    // ⏳ 队列头
    if (queued.length) {
      html += '<div class="qbar-head" id="qbar-toggle">⏳ 排队 <b>' + queued.length + '</b> 条' +
        '<span class="qbar-arrow">' + (queueExpanded ? '收起 ▴' : '展开 ▾') + '</span></div>';
      if (queueExpanded) {
        queued.forEach(function (q, i) {
          var text = promptText(q);
          var ts = q.created_at || state.queuedTimeMap[q.prompt_id];
          html += '<div class="qbar-item" data-pid="' + escHtml(q.prompt_id) + '">' +
            '<span class="qbar-idx">#' + (i + 1) + '</span>' +
            '<span class="qbar-time">' + fmtClock(ts) + '</span>' +
            '<span class="qbar-text" title="' + escHtml(text) + '">' + escHtml(text.slice(0, 60)) + (text.length > 60 ? '…' : '') + '</span>' +
            (active ? '<button class="qbar-act steer-one" title="插队到当前执行">⚡</button>' : '') +
            '<button class="qbar-act cancel-one" title="取消排队">✕</button>' +
            '</div>';
        });
      }
    }
    bar.innerHTML = html;
    var tog = document.getElementById('qbar-toggle');
    if (tog) tog.onclick = function () { queueExpanded = !queueExpanded; renderQueueBar(); };
    bar.querySelectorAll('.steer-one').forEach(function (btn) {
      btn.onclick = function () {
        var pid = btn.closest('.qbar-item').dataset.pid;
        var item = state.promptsInfo.queued.find(function (x) { return x.prompt_id === pid; });
        steerQueued(item);
      };
    });
    bar.querySelectorAll('.cancel-one').forEach(function (btn) {
      btn.onclick = function () {
        cancelQueued(btn.closest('.qbar-item').dataset.pid);
      };
    });
  }

  function promptText(p) {
    return (p.content || []).filter(function (b) { return b.type === 'text'; })
      .map(function (b) { return b.text; }).join(' ').replace(/\s+/g, ' ').trim();
  }

  // ⚡ 插队执行某条排队项:steer 的目标是【排队项自身】的 prompt_id(实测:传 active id 报 40402 "not pending")
  function steerQueued(item) {
    if (!item) return;
    api('/api/v1/sessions/' + state.sid + '/prompts:steer', {
      method: 'POST',
      body: { prompt_ids: [item.prompt_id], content: item.content },
    }).then(function () {
      toast('已插队执行');
      pollStatusOnce(); scheduleRefresh();
    }).catch(function (e) { toast('插队失败:' + e.message, true); });
  }

  // ✕ 取消某条排队
  function cancelQueued(promptId) {
    api('/api/v1/sessions/' + state.sid + '/prompts/' + encodeURIComponent(promptId), {
      method: 'POST',
    }).then(function () {
      toast('已取消');
      pollStatusOnce(); scheduleRefresh();
    }).catch(function (e) { toast('取消失败:' + e.message, true); });
  }

  // 运行指示条:正在思考/正在生成/正在执行工具X(busy 即显示,snapshot 未到时给默认文案)
  function renderRunbar() {
    var bar = document.getElementById('runbar');
    if (!bar) return;
    if (!state.busy) {
      bar.style.display = 'none';
      state.turnStartedAt = null;
      if (state.liveText || state.liveThink) { state.liveText = ''; state.liveThink = ''; renderLiveView(); }
      return;
    }
    if (!state.turnStartedAt) state.turnStartedAt = Date.now();
    var f = state.inFlight;
    var text = '正在思考…';
    if (f) {
      var tools = f.running_tools;
      if (tools && tools.length) {
        var names = tools.map(function (t) { return t.tool_name || t.name || t; }).slice(0, 3).join('、');
        text = '正在执行 ' + names + '…';
      } else if (f.assistant_text) {
        text = '正在生成回复…';
      } else if (f.thinking_text) {
        text = '正在深度思考…';
      }
    }
    var elapsed = Math.floor((Date.now() - state.turnStartedAt) / 1000);
    document.getElementById('runbar-text').textContent = text + ' (' + elapsed + 's)';
    bar.style.display = 'flex';
  }

  // composer 三态:空闲(📎+↑) / 运行中(⚡引导+■停止+↑排队) / 待审批(锁定)
  function renderComposerMode() {
    var attach = document.getElementById('btn-attach');
    var steerBtn = document.getElementById('btn-steer');
    var stopBtn = document.getElementById('btn-stop');
    var send = document.getElementById('btn-send');
    var input = document.getElementById('input');
    var hint = document.getElementById('composer-hint');
    if (!send) return;
    var locked = state.approvals.length > 0 || state.questions.length > 0;

    if (locked) {
      attach.style.display = 'none';
      steerBtn.style.display = 'none';
      stopBtn.style.display = 'none';
      input.disabled = true; send.disabled = true;
      hint.textContent = state.approvals.length ? '⏸ 等待审批:请先处理上方的审批请求' : '⏸ 等待回答:请先处理上方的问题';
      hint.style.display = 'block';
    } else {
      input.disabled = false;
      hint.style.display = 'none';
      if (state.busy) {
        attach.style.display = 'inline-flex';
        steerBtn.style.display = 'inline-flex';
        stopBtn.style.display = 'inline-flex';
        send.title = '排队发送(等当前执行完再处理)';
        input.placeholder = '发送将排队;点 ⚡ 立即引导';
      } else {
        attach.style.display = 'inline-flex';
        steerBtn.style.display = 'none';
        stopBtn.style.display = 'none';
        send.title = '发送';
        input.placeholder = '发消息,或输入 / 指令';
      }
      updateSendBtn();
    }
  }

  // ■ 停止当前执行(WS abort)
  function stopTurn() {
    if (!state.sid || !ws.ok || !ws.conn) { toast('连接不可用', true); return; }
    ws.conn.send(JSON.stringify({ type: 'abort', id: 'ab-' + Date.now(), payload: { session_id: state.sid } }));
    toast('已发送停止指令');
    setTimeout(pollStatusOnce, 1500);
  }

  // ⚡ 立即引导(输入框新文本):两步走——先 POST 入队拿 prompt_id,再 steer 该 id(实测契约)
  function steerMessage(text) {
    var sid = state.sid;
    var content = [{ type: 'text', text: text }];
    api('/api/v1/sessions/' + sid + '/prompts', {
      method: 'POST', body: { content: content },
    }).then(function (d) {
      var pid = d && d.prompt_id;
      if (!pid) { toast('引导失败:未拿到排队句柄', true); return; }
      api('/api/v1/sessions/' + sid + '/prompts:steer', {
        method: 'POST',
        body: { prompt_ids: [pid], content: content },
      }).then(function () {
        toast('已引导');
        pollStatusOnce(); scheduleRefresh();
      }).catch(function (e) { toast('引导失败:' + e.message, true); });
    }).catch(function (e) { toast('发送失败:' + e.message, true); });
  }

  function loadSessionInfo(sid) {
    Promise.all([api('/api/v1/sessions/' + sid), loadOverlay()]).then(function (arr) {
      var d = arr[0];
      state.sessionInfo = d || {};
      document.getElementById('chat-title').textContent = displayTitle(state.sessionInfo);
      renderStatusChip(!!d.busy);
      renderInfobar();
    }).catch(function () {});
  }

  // 会话信息条:模型 · 思考档 · 权限 · 上下文用量(可点改)
  function renderInfobar() {
    var bar = document.getElementById('infobar');
    if (!bar) return;
    var cfg = (state.sessionInfo && state.sessionInfo.agent_config) || {};
    var st = state.statusData || {};
    var model = state.modelOverride || st.model || cfg.model || '默认';
    var thinking = state.thinkingOverride || st.thinking_level || '默认';
    var perm = state.permOverride || st.permission || cfg.permission_mode || 'auto';
    var ctx = (st.context_usage != null) ? Math.round(st.context_usage * 100) + '%' : null;
    bar.innerHTML =
      '<button class="info-chip" id="ic-model" title="切换模型">🧠 ' + escHtml(String(model).replace('kimi-code/', '')) + '</button>' +
      '<button class="info-chip" id="ic-thinking" title="思考强度">💭 ' + escHtml(thinking) + '</button>' +
      '<button class="info-chip" id="ic-perm" title="权限模式">🔐 ' + escHtml(perm) + '</button>' +
      (ctx ? '<span class="info-chip static" title="上下文用量">📊 ' + ctx + '</span>' : '') +
      (st.plan_mode || cfg.plan_mode ? '<span class="info-chip static">📋 plan</span>' : '');
    var bm = document.getElementById('ic-model');
    if (bm) bm.onclick = openModelPicker;
    var bt = document.getElementById('ic-thinking');
    if (bt) bt.onclick = openThinkingPicker;
    var bp = document.getElementById('ic-perm');
    if (bp) bp.onclick = function () {
      var cur = state.permOverride || (state.statusData && state.statusData.permission) || 'auto';
      state.permOverride = cur === 'auto' ? 'manual' : cur === 'manual' ? 'yolo' : 'auto';
      toast('后续消息权限模式:' + state.permOverride);
      renderInfobar();
    };
  }

  function openThinkingPicker() {
    var levels = [['low', 'low(快)'], ['high', 'high(深)'], ['max', 'max(最深)']];
    var mask = el('div', 'mask');
    mask.innerHTML = '<div class="sheet"><h2>思考强度(作用于后续消息)</h2>' +
      levels.map(function (l) { return '<button class="opt-btn" data-id="' + l[0] + '">' + l[1] + '</button>'; }).join('') +
      '<div class="sheet-row"><button class="btn ghost" id="tp-cancel">取消</button></div></div>';
    document.body.appendChild(mask);
    mask.querySelector('#tp-cancel').onclick = function () { mask.remove(); };
    mask.onclick = function (e) { if (e.target === mask) mask.remove(); };
    mask.querySelectorAll('.opt-btn').forEach(function (b) {
      b.onclick = function () {
        state.thinkingOverride = b.dataset.id;
        toast('后续消息思考强度:' + state.thinkingOverride);
        renderInfobar();
        mask.remove();
      };
    });
  }

  function loadStatus(sid) { pollStatusOnce(); }

  function loadSkills(sid) {
    api('/api/v1/sessions/' + sid + '/skills').then(function (d) {
      var items = (d && d.items) || (Array.isArray(d) ? d : []);
      state.skills = items.map(function (s) {
        return typeof s === 'string' ? s : (s.name || s.id);
      }).filter(Boolean);
    }).catch(function () {});
  }

  // ---------------- 消息渲染 ----------------
  var stickBottom = true;

  // 消息排序:created_at 为主,id 决胜(同毫秒突发批次保持因果序)
  function cmpMsg(a, b) {
    var c = String(a.created_at).localeCompare(String(b.created_at));
    return c || String(a.id).localeCompare(String(b.id));
  }
  // 按 id 合并消息集:fresh(最新一页)覆盖同 id;本地有而 fresh 没有的保留
  // —— 保留的两类:①用户已翻页加载的更早消息 ②高活跃时滚出最新一页窗口的中间消息(防缺口)
  function mergeMessages(local, fresh) {
    var freshById = {};
    fresh.forEach(function (m) { if (m.id) freshById[m.id] = m; });
    var out = [];
    local.forEach(function (m) {
      if (m.id && freshById[m.id]) { out.push(freshById[m.id]); delete freshById[m.id]; }
      else out.push(m);
    });
    fresh.forEach(function (m) { if (!m.id || freshById[m.id]) out.push(m); });
    out.sort(cmpMsg);
    return out;
  }
  // 消息内容签名:kimi server 会原地更新 assistant 消息(先建空占位,thinking/text/tool_use
  // 逐步追加),id 不变内容变。签名变 → keyed 渲染必须重渲染该节点,否则结论文本永不出现。
  function msgSig(m) {
    var c = m.content, s;
    if (typeof c === 'string') s = c;
    else { try { s = JSON.stringify(c); } catch (e) { s = String(c); } }
    s = (m.role || '') + '|' + (s || '');
    var h = 0;
    for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
    return s.length + ':' + h;
  }

  function loadMessages(sid, opts) {
    opts = opts || {};
    // 大会话经隧道可达数百 KB(家庭上行物理瓶颈),3.5s 未完成则给出进度提示
    var slowTimer = null;
    if (!opts.quiet) {
      slowTimer = setTimeout(function () {
        var l = document.getElementById('msg-list');
        if (l && l.querySelector('.skel-msg')) {
          l.innerHTML = '<div class="empty">大会话加载中(家庭上行带宽有限,约需几秒~二十秒)…</div>';
        }
      }, 3500);
    }
    api('/api/v1/sessions/' + sid + '/messages?page_size=30').then(function (d) {
      var items = (d && d.items) || [];
      items.sort(cmpMsg);
      if (state.sid === sid && state.msgs.length && items.length) {
        // 增量合并(修「加载更早失效」根因):刷新只更新最新一页,已翻页加载的更早消息不被冲掉
        state.msgs = mergeMessages(state.msgs, items);
        // page-1 的 has_more 只描述 page1 边界;本地已有更早消息时,hasMore 以 loadEarlier 的结果为准
        var oldestFresh = items[0];
        var localOlder = oldestFresh && state.msgs.length &&
          String(state.msgs[0].created_at) < String(oldestFresh.created_at);
        if (!localOlder) state.hasMore = !!(d && d.has_more);
        // 防无限增长:超过 300 条裁掉最旧的(可随时再经「加载更早」取回)
        if (state.msgs.length > 300) {
          state.msgs = state.msgs.slice(state.msgs.length - 300);
          state.hasMore = true;
        }
      } else {
        state.msgs = items; state.hasMore = !!(d && d.has_more);
      }
      renderMessages(opts.quiet);
    }).catch(function (e) {
      if (!opts.quiet) {
        var l = document.getElementById('msg-list');
        if (l) l.innerHTML = '<div class="empty">加载失败:' + escHtml(e.message) + '</div>';
      }
    }).finally(function () { if (slowTimer) clearTimeout(slowTimer); });
  }

  function renderMessages(quiet) {
    var list = document.getElementById('msg-list');
    if (!list) return;
    var msgsEl = document.getElementById('msgs');
    if (msgsEl && !quiet) {
      var gap = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight;
      stickBottom = gap < 80;
    }

    var shown = state.msgs;
    if (state.onlyMine) {
      shown = state.msgs.filter(function (m) {
        if (m.role !== 'user') return false;
        var text = (typeof m.content === 'string') ? m.content
          : (Array.isArray(m.content) ? m.content.filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join(' ') : '');
        return !isInjectedUserMsg(m, text) && stripSystem(text).length > 0;
      });
    }

    // keyed 增量渲染:按消息 id 复用 DOM 节点,新增 append、变更 patch、消失 remove
    // —— 不再整页 innerHTML,消除「整页刷新」感与闪烁
    if (!state._domInit) {
      list.innerHTML = '';
      state.msgNodes = new Map();
      state._domInit = true;
      // 「加载更早」入口固定在最顶
      var earlierDiv = document.createElement('div');
      earlierDiv.className = 'empty'; earlierDiv.style.padding = '10px'; earlierDiv.id = 'earlier-slot';
      list.appendChild(earlierDiv);
    }
    var earlierSlot = document.getElementById('earlier-slot');
    if (!earlierSlot) { state._domInit = false; return renderMessages(quiet); }
    if (earlierSlot) {
      earlierSlot.innerHTML = state.hasMore ? '<button class="btn ghost small" id="load-earlier">加载更早消息</button>' : '';
      var earlierBtn = document.getElementById('load-earlier');
      if (earlierBtn) earlierBtn.onclick = loadEarlier;
    }
    if (state.onlyMine) {
      earlierSlot.innerHTML += '<div class="empty" style="padding:8px">只看我的输入 · 共 ' + shown.length + ' 条(菜单可切回全部)</div>';
    }

    var seen = new Set();
    var cursor = earlierSlot;
    shown.forEach(function (m) {
      var id = m.id || m.user_message_id || ('k' + shown.indexOf(m));
      seen.add(id);
      var sig = msgSig(m);
      var node = state.msgNodes.get(id);
      if (!node || node._sig !== sig) {
        // 新建,或内容已变(kimi server 原地更新 assistant 消息:结论文本后补)→ 重渲染该节点
        var html;
        try { html = messageHtml(m); }
        catch (err) {
          html = '<div class="msg assistant"><div class="bubble"><div class="error-card">⚠ 此条消息渲染失败(已跳过)</div></div></div>';
        }
        if (!html) {
          // 空消息(如 assistant 空占位)不落 DOM 不缓存:内容到达后 sig 变化自然会渲染
          if (node) { node.remove(); state.msgNodes.delete(id); }
          return;
        }
        var tmp = document.createElement('div');
        tmp.innerHTML = html;
        var fresh = tmp.firstChild;
        if (!fresh) return;
        fresh.dataset.mid = id;
        fresh._sig = sig;
        if (node) node.replaceWith(fresh);
        state.msgNodes.set(id, fresh);
        node = fresh;
      }
      // 按序插入(cursor 之后)
      if (node.previousSibling !== cursor || node.parentNode !== list) {
        if (cursor.nextSibling) list.insertBefore(node, cursor.nextSibling);
        else list.appendChild(node);
      }
      cursor = node;
    });
    // 消失的消息移除(仅当当前消息集发生裁剪,如仅看我的输入/会话切换)
    state.msgNodes.forEach(function (node, id) {
      if (!seen.has(id) && node.parentNode === list) {
        node.remove();
        state.msgNodes.delete(id);
      }
    });
    // 空态
    if (!shown.length && !state.pendingMsgs.length) {
      var empty = document.createElement('div');
      empty.className = 'empty'; empty.id = 'msgs-empty';
      empty.textContent = state.onlyMine ? '没有你的输入' : '空会话,开始聊吧';
      list.appendChild(empty);
    } else {
      var oe = document.getElementById('msgs-empty');
      if (oe) oe.remove();
    }
    // 本地未确认消息(每次重建,量小)
    list.querySelectorAll('.msg.pending').forEach(function (n) { n.remove(); });
    state.pendingMsgs.forEach(function (p) {
      try {
        var tmp = document.createElement('div');
        tmp.innerHTML = pendingHtml(p);
        var n = tmp.firstChild || tmp;
        list.appendChild(n);
      } catch (err) {}
    });
    // 失败消息点击重发
    list.querySelectorAll('.msg-status.failed').forEach(function (chip) {
      chip.onclick = function () { retryPending(chip.dataset.pid); };
    });

    if (msgsEl && stickBottom) msgsEl.scrollTop = msgsEl.scrollHeight;
    renderToBottom(msgsEl);
  }

  function loadEarlier() {
    var first = state.msgs[0];
    if (!first || !first.id || state.earlierLoading) return;
    state.earlierLoading = true;
    var slot = document.getElementById('earlier-slot');
    if (slot) slot.innerHTML = '<div class="empty" style="padding:6px">加载更早消息中…</div>';
    // 滚动锚定:记录插入前 scrollHeight,渲染后补偿位移,视口停在原消息上不跳
    var msgsEl = document.getElementById('msgs');
    var prevH = msgsEl ? msgsEl.scrollHeight : 0;
    var prevTop = msgsEl ? msgsEl.scrollTop : 0;
    api('/api/v1/sessions/' + state.sid + '/messages?page_size=100&before_id=' + encodeURIComponent(first.id)).then(function (d) {
      var items = (d && d.items) || [];
      items.sort(cmpMsg);
      state.msgs = mergeMessages(items, state.msgs);
      state.hasMore = !!(d && d.has_more);
      renderMessages(true);
      if (msgsEl) {
        var delta = msgsEl.scrollHeight - prevH;
        if (delta > 0) msgsEl.scrollTop = prevTop + delta;
      }
    }).catch(function (e) { toast(e.message, true); renderMessages(true); })
      .finally(function () { state.earlierLoading = false; });
  }

  function renderToBottom(msgsEl) {
    if (!msgsEl) return;
    msgsEl.onscroll = function () {
      var gap = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight;
      stickBottom = gap < 80;
      // 刷到顶部自动加载更早(与按钮并存;earlierLoading 防重入)
      if (msgsEl.scrollTop < 60 && state.hasMore && !state.earlierLoading && state.msgs.length) loadEarlier();
      var btn = document.getElementById('to-bottom');
      if (gap > 300 && !btn) {
        var b = el('button', 'to-bottom', '↓'); b.id = 'to-bottom';
        b.onclick = function () { msgsEl.scrollTop = msgsEl.scrollHeight; };
        document.querySelector('.composer').appendChild(b);
      } else if (gap <= 300 && btn) btn.remove();
    };
  }

  function messageHtml(m) {
    var role = m.role || 'assistant';
    var content = m.content;
    var blocks = [];
    if (typeof content === 'string') blocks = [{ type: 'text', text: content }];
    else if (Array.isArray(content)) blocks = content;
    else if (content && content.text) blocks = [{ type: 'text', text: content.text }];

    if (role === 'user') {
      var files = blocks.filter(function (b) { return b.type === 'file' || b.type === 'image'; })
        .map(function (b) { return '<span class="file-pill">📎 ' + escHtml(b.name || b.media_type || '附件') + '</span>'; }).join('');
      var rawText = blocks.filter(function (b) { return b.type === 'text'; })
        .map(function (b) { return b.text; }).join('\n');

      // 整条注入(元数据 origin.kind ≠ user,或无元数据但带系统前缀/STEER-PROBE 探针):
      // 全量进「系统注入」折叠卡,不占用户蓝色气泡
      if (isInjectedUserMsg(m, rawText)) {
        return '<div class="msg user">' +
          (files ? '<div class="files">' + files + '</div>' : '') +
          '<details class="inject-card"><summary>💉 ' + escHtml(injectLabel(m)) + '(非我本人输入)</summary>' +
          '<div class="body">' + escHtml((rawText || '(无文本)').slice(0, 3000)) + '</div></details></div>';
      }

      // 系统注入分离:<system-reminder>/<system> 块折叠成「系统注入」卡,我的真实输入单独呈现
      var injections = [];
      var myText = String(rawText)
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, function (m) { injections.push(m); return ' '; })
        .replace(/<system>[\s\S]*?<\/system>/g, function (m) { injections.push(m); return ' '; })
        .replace(/\s+$/g, '').replace(/^\s+/g, '');

      var injHtml = '';
      if (injections.length) {
        var injText = injections.map(function (s) { return stripSystem(s) ? s.replace(/<\/?system(-reminder)?>/g, '') : s; }).join('\n\n');
        injHtml = '<details class="inject-card"><summary>💉 系统注入 × ' + injections.length + '(非我本人输入)</summary>' +
          '<div class="body">' + escHtml(injText.slice(0, 3000)) + '</div></details>';
      }
      if (!myText.trim() && !files) return '<div class="msg user">' + injHtml + '</div>';
      return '<div class="msg user"><div class="bubble">' +
        (files ? '<div class="files">' + files + '</div>' : '') +
        escHtml(myText) +
        '<div class="msg-time">' + fmtClock(m.created_at) + '</div></div>' + injHtml + '</div>';
    }

    // assistant / tool / system
    var body = '';
    blocks.forEach(function (b) {
      if (b.type === 'text') body += window.MD.render(b.text || '');
      else if (b.type === 'thinking') {
        body += '<details class="think-card"><summary>💭 思考过程</summary><div class="body">' +
          escHtml(b.thinking || '') + '</div></details>';
      } else if (b.type === 'tool_use') {
        var input = ''; try { input = JSON.stringify(b.input, null, 2); } catch (e) { input = String(b.input); }
        // 摘要行:终端对齐——工具名 + 关键参数一行(command/file_path/pattern 优先)
        var summary = '';
        if (b.input && typeof b.input === 'object') {
          var key = b.input.command || b.input.file_path || b.input.path || b.input.pattern || b.input.url || b.input.prompt || b.input.description || '';
          summary = String(key).replace(/\s+/g, ' ').slice(0, 60);
        }
        body += '<details class="tool-card"><summary>🔧 <span class="tool-name">' + escHtml(b.tool_name || b.name || 'tool') + '</span>' +
          (summary ? '<span class="tool-sum">' + escHtml(summary) + '</span>' : '') +
          '</summary><div class="body">' + escHtml(input) + '</div></details>';
      } else if (b.type === 'tool_result') {
        var out = b.output;
        if (typeof out !== 'string') { try { out = JSON.stringify(out, null, 2); } catch (e) { out = String(out); } }
        body += '<details class="tool-card"><summary>📄 工具结果' + (b.is_error ? '(错误)' : '') + '</summary>' +
          '<div class="body">' + escHtml((out || '').slice(0, 4000)) + '</div></details>';
      } else if (b.type === 'image' || b.type === 'file') {
        body += '<div class="files"><span class="file-pill">📎 ' + escHtml(b.name || b.media_type || '附件') + '</span></div>';
      }
    });
    if (!body.trim()) return '';
    return '<div class="msg assistant"><div class="bubble">' + body +
      '<div class="msg-time">' + fmtClock(m.created_at) + '</div></div></div>';
  }

  function fmtClock(ts) {
    var d = parseTs(ts);
    if (isNaN(d)) return '';
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  // 本地未确认消息:发送中/已送达/排队中/失败(点重发)
  function pendingHtml(p) {
    var statusMap = {
      sending: '<span class="msg-status"><span class="spin"></span> 发送中…</span>',
      sent: '<span class="msg-status ok">✓ 已送达</span>',
      queued: '<span class="msg-status queued">⏳ 排队中</span>',
      failed: '<span class="msg-status failed" data-pid="' + p.id + '">✕ 发送失败 · 点我重发</span>',
    };
    var text = p.content.filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('\n');
    var files = p.content.filter(function (b) { return b.type === 'file' || b.type === 'image'; })
      .map(function (b) { return '<span class="file-pill">📎 ' + escHtml(b.name || '附件') + '</span>'; }).join('');
    return '<div class="msg user pending"><div class="bubble">' +
      (files ? '<div class="files">' + files + '</div>' : '') +
      escHtml(text) +
      '<div class="msg-time">' + (statusMap[p.status] || '') + '</div></div></div>';
  }

  function retryPending(pid) {
    var p = state.pendingMsgs.find(function (x) { return x.id === pid; });
    if (!p) return;
    p.status = 'sending';
    renderMessages(true);
    postPrompt(p);
  }

  // ---------------- 审批 / 提问卡片 ----------------
  function renderInteractionCards() {
    var box = document.getElementById('interact');
    if (!box) return;
    box.innerHTML = '';
    state.approvals.forEach(function (a) {
      var card = el('div', 'action-card');
      var detail = '';
      try { detail = JSON.stringify(a.input != null ? a.input : a, null, 2).slice(0, 800); } catch (e) {}
      card.innerHTML =
        '<div class="ac-title">⚠ 审批请求:' + escHtml(a.tool_name || 'tool') + '</div>' +
        (detail ? '<div class="ac-body">' + escHtml(detail) + '</div>' : '') +
        '<div class="ac-actions"><button class="btn small" data-d="approved">批准</button>' +
        '<button class="btn small danger" data-d="rejected">拒绝</button></div>';
      card.querySelectorAll('button').forEach(function (btn) {
        btn.onclick = function () {
          api('/api/v1/sessions/' + state.sid + '/approvals/' + a.approval_id, {
            method: 'POST', body: { decision: btn.dataset.d },
          }).then(function () {
            state.approvals = state.approvals.filter(function (x) { return x.approval_id !== a.approval_id; });
            renderInteractionCards();
            toast(btn.dataset.d === 'approved' ? '已批准' : '已拒绝');
          }).catch(function (e) { toast(e.message, true); });
        };
      });
      box.appendChild(card);
    });

    // 提问卡(契约:/questions?status=pending → items[{question_id, questions:[{id,question,header,body,options:[{id,label,description}],multi_select,allow_other}]}])
    // 一个 item = 一次工具调用,最多 4 个子问题;每个子问题独立作答(single/multi/other),一次提交
    state.questions.forEach(function (q) {
      var card = el('div', 'action-card q');
      var subs = q.questions || [];
      var title = (subs[0] && (subs[0].header || subs[0].question)) || '需要你的选择';
      var html = '<div class="ac-title">❓ ' + escHtml(title) + '</div>';
      subs.forEach(function (sq, si) {
        html += '<div class="q-sub" data-qid="' + escHtml(sq.id) + '" data-multi="' + (sq.multi_select ? '1' : '') + '" data-other="' + (sq.allow_other ? '1' : '') + '">';
        if (subs.length > 1 || (sq.header && sq.header !== title)) {
          html += '<div class="q-sub-head">' + escHtml(sq.header || sq.question) + '</div>';
        }
        if (sq.body) html += '<div class="q-sub-body">' + escHtml(sq.body) + '</div>';
        (sq.options || []).forEach(function (o) {
          html += '<button class="opt-btn" data-oid="' + escHtml(o.id) + '">' +
            escHtml(o.label) +
            (o.description ? '<span class="opt-desc">' + escHtml(o.description) + '</span>' : '') +
            '</button>';
        });
        if (sq.allow_other) {
          html += '<input class="q-other" placeholder="其他(自己填写)">';
        }
        html += '</div>';
      });
      html += '<div class="ac-actions"><button class="btn small" id="q-submit">提交回答</button></div>';
      card.innerHTML = html;
      box.appendChild(card);

      // 选项选择逻辑:single 单选互斥,multi 多选;「其他」有内容时忽略选项
      card.querySelectorAll('.q-sub').forEach(function (subEl) {
        var multi = subEl.dataset.multi === '1';
        subEl.querySelectorAll('.opt-btn').forEach(function (btn) {
          btn.onclick = function () {
            if (multi) { btn.classList.toggle('sel'); }
            else {
              subEl.querySelectorAll('.opt-btn').forEach(function (b) { b.classList.remove('sel'); });
              btn.classList.add('sel');
            }
            var other = subEl.querySelector('.q-other');
            if (other) other.value = '';
          };
        });
        var otherInput = subEl.querySelector('.q-other');
        if (otherInput) {
          otherInput.addEventListener('input', function () {
            if (otherInput.value.trim()) {
              subEl.querySelectorAll('.opt-btn').forEach(function (b) { b.classList.remove('sel'); });
            }
          });
        }
      });

      card.querySelector('#q-submit').onclick = function () {
        var answers = {};
        var missing = 0;
        card.querySelectorAll('.q-sub').forEach(function (subEl) {
          var qid = subEl.dataset.qid;
          var multi = subEl.dataset.multi === '1';
          var otherVal = subEl.querySelector('.q-other') ? subEl.querySelector('.q-other').value.trim() : '';
          var sel = [];
          subEl.querySelectorAll('.opt-btn.sel').forEach(function (b) { sel.push(b.dataset.oid); });
          if (otherVal) answers[qid] = { kind: 'other', text: otherVal };
          else if (multi && sel.length) answers[qid] = { kind: 'multi', option_ids: sel };
          else if (!multi && sel.length === 1) answers[qid] = { kind: 'single', option_id: sel[0] };
          else missing++;
        });
        if (missing) return toast('还有 ' + missing + ' 个问题未作答', true);
        api('/api/v1/sessions/' + state.sid + '/questions/' + encodeURIComponent(q.question_id), {
          method: 'POST', body: { answers: answers },
        }).then(function () {
          state.questions = state.questions.filter(function (x) { return x.question_id !== q.question_id; });
          renderInteractionCards();
          scheduleRefresh();
          toast('已提交,会话继续执行');
        }).catch(function (e) { toast('提交失败:' + e.message, true); });
      };
    });

    // 审批/提问变化后联动 composer 锁定态
    renderComposerMode();
  }

  function answerQuestion(qid, answer) {
    api('/api/v1/sessions/' + state.sid + '/questions/' + encodeURIComponent(qid), {
      method: 'POST', body: { answers: { [qid]: answer } },
    }).then(function () {
      state.questions = state.questions.filter(function (x) { return x.question_id !== qid; });
      renderInteractionCards();
      toast('已提交');
    }).catch(function (e) { toast(e.message, true); });
  }

  // ---------------- composer / 上传 / 斜杠 ----------------
  var CLIENT_CMDS = [
    { cmd: '/new', desc: '新建会话' },
    { cmd: '/sessions', desc: '返回会话列表' },
    { cmd: '/model', desc: '切换后续消息模型' },
    { cmd: '/permission', desc: '循环切换权限模式 auto→manual→yolo' },
    { cmd: '/plan', desc: '切换下条消息的 Plan 模式' },
    { cmd: '/clear', desc: '清空本地消息视图' },
    { cmd: '/help', desc: '指令说明' },
  ];

  function setupComposer(sid) {
    var input = document.getElementById('input');
    var sendBtn = document.getElementById('btn-send');
    var fileInput = document.getElementById('file-input');
    var slashIdx = 0;

    input.addEventListener('input', function () {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 132) + 'px';
      updateSendBtn();
      updateSlash();
    });
    input.addEventListener('keydown', function (e) {
      var panel = document.getElementById('slash');
      var open = panel.style.display !== 'none';
      if (open) {
        var items = panel.querySelectorAll('.slash-item');
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          slashIdx = (slashIdx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items.forEach(function (it, i) { it.classList.toggle('sel', i === slashIdx); });
          return;
        }
        if (e.key === 'Tab') { e.preventDefault(); if (items[slashIdx]) items[slashIdx].click(); return; }
        if (e.key === 'Escape') { panel.style.display = 'none'; return; }
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); doSend(); }
    });

    sendBtn.onclick = doSend;
    document.getElementById('btn-attach').onclick = function () { fileInput.click(); };
    fileInput.onchange = function () {
      Array.prototype.forEach.call(fileInput.files, addAttachment);
      fileInput.value = '';
    };

    function updateSlash() {
      var v = input.value;
      var panel = document.getElementById('slash');
      if (!v.startsWith('/')) { panel.style.display = 'none'; return; }
      var q = v.split('\n')[0].toLowerCase();
      var all = CLIENT_CMDS.map(function (c) { return { cmd: c.cmd, desc: c.desc, client: true }; })
        .concat(state.skills.map(function (s) { return { cmd: '/skill:' + s, desc: '会话 skill(作为文本发送)' }; }));
      var items = all.filter(function (c) { return c.cmd.toLowerCase().startsWith(q); });
      if (!items.length) { panel.style.display = 'none'; return; }
      slashIdx = 0;
      panel.innerHTML = '';
      items.forEach(function (c, i) {
        var it = el('button', 'slash-item' + (i === 0 ? ' sel' : ''));
        it.innerHTML = '<span class="cmd">' + escHtml(c.cmd) + '</span><span class="desc">' + escHtml(c.desc) + '</span>';
        it.onclick = function () {
          panel.style.display = 'none';
          if (c.client) { input.value = ''; execClientCmd(c.cmd); }
          else { input.value = c.cmd + ' '; input.focus(); updateSendBtn(); }
        };
        panel.appendChild(it);
      });
      panel.style.display = 'block';
    }

    function doSend() {
      var text = input.value.trim();
      if (!text && !state.attachments.length) return;
      if (text.startsWith('/') && handleClientCmdText(text)) {
        input.value = ''; input.style.height = 'auto'; updateSendBtn();
        document.getElementById('slash').style.display = 'none';
        return;
      }
      sendMessage(text);
      input.value = ''; input.style.height = 'auto'; updateSendBtn();
      document.getElementById('slash').style.display = 'none';
    }
  }

  function updateSendBtn() {
    var sendBtn = document.getElementById('btn-send');
    var input = document.getElementById('input');
    if (!sendBtn || !input) return;
    var has = input.value.trim().length > 0 || state.attachments.some(function (a) { return a.ready; });
    sendBtn.disabled = !has;
  }

  function handleClientCmdText(text) {
    var first = text.split(/\s/)[0];
    var isClient = CLIENT_CMDS.some(function (c) { return c.cmd === first; });
    if (isClient) { execClientCmd(first); return true; }
    return false; // 非客户端指令 → 作为普通文本发给会话(skill 透传)
  }

  function execClientCmd(cmd) {
    if (cmd === '/new') return openNewSessionSheet();
    if (cmd === '/sessions') { location.hash = '#/'; return; }
    if (cmd === '/model') return openModelPicker();
    if (cmd === '/permission') {
      var cur = state.permOverride || 'auto';
      state.permOverride = cur === 'auto' ? 'manual' : cur === 'manual' ? 'yolo' : 'auto';
      toast('后续消息权限模式:' + state.permOverride); return;
    }
    if (cmd === '/plan') {
      state.planOverride = !(state.planOverride === null ? false : state.planOverride);
      toast('Plan 模式(下条消息):' + (state.planOverride ? '开' : '关')); return;
    }
    if (cmd === '/clear') { state.msgs = []; renderMessages(); toast('本地视图已清空(会话内容未删)'); return; }
    if (cmd === '/help') {
      var mask = el('div', 'mask');
      mask.innerHTML = '<div class="sheet"><h2>指令说明</h2>' +
        CLIENT_CMDS.map(function (c) { return '<p style="margin:8px 0"><code class="inline">' + c.cmd + '</code> — ' + c.desc + '</p>'; }).join('') +
        '<p style="color:var(--text2);font-size:13px;margin-top:10px">/skill:xxx 等指令会作为文本直接发给会话,与终端体验一致。</p>' +
        '<div class="sheet-row"><button class="btn" id="h-ok">知道了</button></div></div>';
      document.body.appendChild(mask);
      mask.querySelector('#h-ok').onclick = function () { mask.remove(); };
      mask.onclick = function (e) { if (e.target === mask) mask.remove(); };
    }
  }

  function openModelPicker() {
    api('/api/v1/models').then(function (d) {
      var items = (d && d.items) || (Array.isArray(d) ? d : []);
      var mask = el('div', 'mask');
      var opts = items.map(function (m) {
        var id = typeof m === 'string' ? m : (m.model || m.id || m.alias || m.name);
        if (!id) return '';
        var label = (typeof m === 'object' && m.display_name) ? m.display_name + '(' + id + ')' : id;
        return '<button class="opt-btn" data-id="' + escHtml(id) + '">' + escHtml(label) + '</button>';
      }).join('');
      mask.innerHTML = '<div class="sheet"><h2>切换模型(作用于后续消息)</h2>' +
        (opts || '<p style="color:var(--text2)">未获取到模型列表</p>') +
        '<div class="sheet-row"><button class="btn ghost" id="mp-cancel">取消</button></div></div>';
      document.body.appendChild(mask);
      mask.querySelector('#mp-cancel').onclick = function () { mask.remove(); };
      mask.onclick = function (e) { if (e.target === mask) mask.remove(); };
      mask.querySelectorAll('.opt-btn').forEach(function (b) {
        b.onclick = function () {
          state.modelOverride = b.dataset.id;
          toast('后续消息模型:' + state.modelOverride);
          mask.remove();
        };
      });
    }).catch(function (e) { toast(e.message, true); });
  }

  // ---------------- 附件 ----------------
  function addAttachment(file) {
    var a = {
      kind: file.type.startsWith('image/') && file.size < 20 * 1048576 ? 'image' : 'file',
      name: file.name, media_type: file.type || 'application/octet-stream',
      size: file.size, progress: 0, ready: false,
    };
    state.attachments.push(a);
    renderChips();

    // 一律走 /api/v1/files 上传,引用 file_id 发送(2026-07-21:图片 base64 内联撞
    // kimi prompts 1MB bodyLimit 50001 事故——两张截图必挂)。base64 内联仅保留 <300KB 小图
    if (a.kind === 'image' && file.size < 300 * 1024) {
      var rd = new FileReader();
      rd.onload = function () {
        a.data = String(rd.result).split(',')[1];
        a.ready = true; a.progress = 100; renderChips();
      };
      rd.onerror = function () { a.error = true; renderChips(); };
      rd.readAsDataURL(file);
    } else {
      var fd = new FormData();
      fd.append('file', file);
      fd.append('name', file.name);
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/v1/files');
      xhr.upload.onprogress = function (ev) {
        if (ev.lengthComputable) { a.progress = Math.round(ev.loaded / ev.total * 100); renderChips(); }
      };
      xhr.onload = function () {
        try {
          var j = JSON.parse(xhr.responseText);
          if (xhr.status === 200 && j.code === 0) {
            a.file_id = j.data.file_id || j.data.id;
            a.ready = true; a.progress = 100;
          } else a.error = true;
        } catch (e) { a.error = true; }
        renderChips();
      };
      xhr.onerror = function () { a.error = true; renderChips(); };
      xhr.send(fd);
    }
  }

  function renderChips() {
    var box = document.getElementById('chips');
    if (!box) return;
    box.innerHTML = '';
    state.attachments.forEach(function (a, i) {
      var c = el('span', 'attach-chip');
      c.innerHTML = '<span class="n">' + escHtml(a.name) + ' (' + fmtSize(a.size) + ')</span>' +
        (a.error ? '<span style="color:var(--danger)">失败</span>'
          : a.ready ? '<span style="color:var(--success)">✓</span>'
          : '<span class="p">' + a.progress + '%</span>') +
        '<button class="x" data-i="' + i + '">×</button>';
      box.appendChild(c);
    });
    box.querySelectorAll('.x').forEach(function (b) {
      b.onclick = function () { state.attachments.splice(+b.dataset.i, 1); renderChips(); updateSendBtn(); };
    });
    updateSendBtn();
  }

  // ---------------- 发送 ----------------
  function sendMessage(text) {
    var content = [];
    state.attachments.forEach(function (a) {
      if (!a.ready) return;
      if (a.kind === 'image') {
        // file_id 优先(大图/上传路径);<300KB 小图仍走 base64 内联
        if (a.file_id) content.push({ type: 'image', source: { kind: 'file', file_id: a.file_id } });
        else content.push({ type: 'image', source: { kind: 'base64', media_type: a.media_type, data: a.data } });
      }
      else content.push({ type: 'file', file_id: a.file_id, name: a.name, media_type: a.media_type, size: a.size });
    });
    if (text) content.push({ type: 'text', text: text });
    if (!content.length) return;

    var body = { content: content };
    if (state.modelOverride) body.model = state.modelOverride;
    if (state.permOverride) body.permission_mode = state.permOverride;
    if (state.planOverride !== null) body.plan_mode = state.planOverride;
    if (state.thinkingOverride) body.thinking = state.thinkingOverride;

    var p = {
      id: 'p-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      content: content.map(function (b) {
        return b.type === 'text' ? b : { type: b.type, name: b.name, media_type: b.media_type };
      }),
      status: 'sending',
      body: body,
    };
    state.pendingMsgs.push(p);
    state.attachments = []; renderChips();
    stickBottom = true; renderMessages(true);
    postPrompt(p);
  }

  // busy 时 = 排队(POST /prompts,服务端排队执行);空闲 = 直接发
  function postPrompt(p) {
    var path = '/api/v1/sessions/' + state.sid + '/prompts';
    api(path, { method: 'POST', body: p.body }).then(function () {
      p.status = 'sent';
      renderMessages(true);
      // 服务端已落库;权威队列由 queuebar 展示,回执标记短暂展示后清掉
      setTimeout(function () {
        state.pendingMsgs = state.pendingMsgs.filter(function (x) { return x.id !== p.id; });
        scheduleRefresh();
      }, 1200);
      pollStatusOnce();
    }).catch(function () {
      p.status = 'failed';
      renderMessages(true);
      pollStatusOnce();
    });
  }

  // 代码块复制按钮(事件委托)
  document.addEventListener('click', function (e) {
    if (!e.target.classList || !e.target.classList.contains('copy-btn')) return;
    var code = e.target.closest('pre.code').querySelector('code').textContent;
    (navigator.clipboard ? navigator.clipboard.writeText(code) : Promise.reject())
      .then(function () { e.target.textContent = '已复制'; setTimeout(function () { e.target.textContent = '复制'; }, 1200); })
      .catch(function () { toast('复制失败', true); });
  });

  // 点击菜单外部时收起所有弹出菜单
  document.addEventListener('click', function (e) {
    document.querySelectorAll('.menu-pop').forEach(function (pop) {
      if (pop.style.display === 'none') return;
      if (!e.target.closest || !e.target.closest('.menu')) pop.style.display = 'none';
    });
  });

  // ---------------- 启动 ----------------
  window.addEventListener('hashchange', router);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && state.sid) { loadMessages(state.sid, { quiet: true }); refreshInteractions(); pollStatusOnce(); }
  });

  // 首次进入:探测登录态
  api('/api/v1/meta').then(function () {
    state.authed = true;
    router();
  }).catch(function () {
    renderLogin();
  });

  // 测试钩子(tests/regressions 纯逻辑用例经 vm 沙箱取用;不影响运行)
  window.__kr = {
    messageHtml: messageHtml, msgSig: msgSig, mergeMessages: mergeMessages, cmpMsg: cmpMsg,
    isInjectedUserMsg: isInjectedUserMsg, msgOriginKind: msgOriginKind, injectLabel: injectLabel,
  };
})();
