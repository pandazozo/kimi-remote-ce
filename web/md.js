/* md.js — 极简安全 markdown 渲染(无依赖)
 * 原则:先整体 HTML 转义,再做块级/行内替换;链接只允许 http/https;不渲染 img/原始 HTML。
 * 暴露 window.MD.render(src) -> HTML string
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function safeUrl(u) {
    u = String(u).trim();
    return /^https?:\/\//i.test(u) ? u : '#';
  }

  function inline(s) {
    // 行内码(先提走,避免内部再被格式化);占位符用控制字符,绝不可能与正文碰撞
    var codes = [];
    s = s.replace(/`([^`\n]+)`/g, function (m, c) {
      codes.push(c);
      return '' + (codes.length - 1) + '';
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
         .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
         .replace(/~~([^~]+)~~/g, '<del>$1</del>')
         .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, t, u) {
           return '<a href="' + esc(safeUrl(u)) + '" target="_blank" rel="noopener noreferrer">' + t + '</a>';
         });
    s = s.replace(/(\d+)/g, function (m, i) {
      return '<code class="inline">' + codes[+i] + '</code>';
    });
    return s;
  }

  function renderTable(lines) {
    // lines[0] 表头, lines[1] 分隔, 其余为数据行
    function cells(l) {
      return l.replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); });
    }
    var head = cells(lines[0]);
    var html = '<div class="table-wrap"><table><thead><tr>' +
      head.map(function (c) { return '<th>' + inline(c) + '</th>'; }).join('') +
      '</tr></thead><tbody>';
    for (var i = 2; i < lines.length; i++) {
      html += '<tr>' + cells(lines[i]).map(function (c) { return '<td>' + inline(c) + '</td>'; }).join('') + '</tr>';
    }
    return html + '</tbody></table></div>';
  }

  window.MD = {
    render: function (src) {
      if (!src) return '';
      var text = esc(String(src));

      // 1. 提取代码块为占位符
      var blocks = [];
      text = text.replace(/```(\w*)\n([\s\S]*?)```/g, function (m, lang, code) {
        blocks.push({ lang: lang || '', code: code.replace(/\n$/, '') });
        return '\n\nKR_CODE_' + (blocks.length - 1) + '\n\n';
      });

      // 2. 按空行分段处理块级元素
      var chunks = text.split(/\n{2,}/);
      var out = [];
      chunks.forEach(function (chunk) {
        var c = chunk.trim();
        if (!c) return;

        var m;
        if ((m = c.match(/^KR_CODE_(\d+)$/))) {
          var b = blocks[+m[1]];
          out.push('<pre class="code" data-lang="' + b.lang + '"><div class="code-head"><span>' +
            (b.lang || 'code') + '</span><button type="button" class="copy-btn">复制</button></div><code>' +
            b.code + '</code></pre>');
          return;
        }
        if ((m = c.match(/^(#{1,4})\s+(.*)$/))) {
          var lv = m[1].length;
          out.push('<h' + lv + '>' + inline(m[2]) + '</h' + lv + '>');
          return;
        }
        if (/^(-{3,}|\*{3,})$/.test(c)) { out.push('<hr>'); return; }

        var lines = c.split('\n');
        // 表格:首行 |...|,次行 |---|
        if (lines.length >= 3 && /^\|.*\|$/.test(lines[0].trim()) && /^\|[\s:|-]+\|$/.test(lines[1].trim())) {
          out.push(renderTable(lines));
          return;
        }
        // 引用块
        if (lines.every(function (l) { return /^&gt;/.test(l.trim()); })) {
          out.push('<blockquote>' + lines.map(function (l) { return inline(l.trim().replace(/^&gt;\s?/, '')); }).join('<br>') + '</blockquote>');
          return;
        }
        // 无序列表
        if (lines.every(function (l) { return /^\s*[-*]\s+/.test(l); })) {
          out.push('<ul>' + lines.map(function (l) { return '<li>' + inline(l.replace(/^\s*[-*]\s+/, '')) + '</li>'; }).join('') + '</ul>');
          return;
        }
        // 有序列表
        if (lines.every(function (l) { return /^\s*\d+\.\s+/.test(l); })) {
          out.push('<ol>' + lines.map(function (l) { return '<li>' + inline(l.replace(/^\s*\d+\.\s+/, '')) + '</li>'; }).join('') + '</ol>');
          return;
        }
        // 普通段落(保留单换行)
        out.push('<p>' + inline(lines.join('\n')).replace(/\n/g, '<br>') + '</p>');
      });
      return out.join('');
    }
  };
})();
