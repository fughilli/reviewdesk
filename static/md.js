// Minimal, safe Markdown -> HTML. All source text is HTML-escaped before any
// markup is added; links are restricted to http(s)/mailto/relative URLs.
(function () {
  "use strict";
  const esc = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  function safeUrl(u) {
    u = u.trim();
    const scheme = u.match(/^([a-z][a-z0-9+.-]*):/i);
    if (!scheme || /^(https?|mailto)$/i.test(scheme[1])) return u;
    return null;
  }

  // ---- references (mirrors server.py scan_refs(); keep the two in step) ----
  // MD.configure(c) with /api/config: {pr_url_base, repo, commits, commit_url_base,
  // issue_url, issue_prefixes}. Every reference kind is off until configured.
  // MD.ctx = {items: {id: {title, status}}, commits: {token: sha}, also: {"pr:123": [ids]}}
  // from the item being rendered (server ref_ctx); absent = link without hover info.
  const cfg = { pr_url_base: "", repo: "", commits: false, commit_url_base: "", issue_url: "", issue_prefixes: [] };
  let ctx = null;
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const NEVER = "(?!)";
  let refRe = null;
  function buildRefRe() {
    const prefixes = (cfg.issue_prefixes || []).map(reEsc).join("|") || NEVER;
    refRe = new RegExp(
      "(\\b(?:[Dd]esk\\s+[Ii]tem|[Dd]esk|[Ii]tem)\\s+#(\\d{1,6})\\b)" +           //  1, 2  desk #76 / item #76
      "|(" + (cfg.repo ? "\\b" + reEsc(cfg.repo) : NEVER) + "#(\\d{1,6})\\b)" +     //  3, 4  org/repo#123
      "|(\\bD-?(\\d{1,6})\\b)" +                                                    //  5, 6  D-76 / D76
      "|(\\b(" + prefixes + ")-(\\d{1,6})\\b)" +                                   //  7-9   ABC-12
      "|(" + (cfg.pr_url_base ? "" : NEVER) + "(?:^|[^\\w&#/]))(#(\\d{1,6})\\b)" + // 10-12  #123
      "|(" + (cfg.commits ? "" : NEVER) + "\\b(?=[0-9a-f]*\\d)[0-9a-f]{7,40}\\b)", "g"); // 13 commit sha
  }
  buildRefRe();
  const ext = (href, text, title) => '<a class="ref ref-x" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer" title="' + esc(title) + '">' + esc(text) + "</a>";
  const internal = (href, text, title) => '<a class="ref ref-x" href="' + esc(href) + '" data-nav title="' + esc(title) + '">' + esc(text) + "</a>";
  function also(type, key, label) {
    const ids = ctx && ctx.also && ctx.also[type + ":" + key];
    if (!ids || !ids.length) return "";
    return '<a class="also" href="/ref/' + type + "/" + encodeURIComponent(key) + '" data-nav title="' +
      esc(label + " is also on " + ids.map((i) => "D-" + i).join(", ")) + '">+' + ids.length + "</a>";
  }
  function deskRef(n, orig) {
    const info = ctx && ctx.items ? ctx.items[n] : undefined;
    if (ctx && ctx.items && !info) return null; // unknown item: leave the text alone
    const t = info ? "D-" + n + " · " + info.title + " (" + info.status.replace("_", " ") + ")" : "D-" + n;
    return '<a class="ref ref-d' + (info && info.status === "closed" ? " closed" : "") + '" href="/item/' + n + '" data-nav title="' + esc(t) + '">D-' + n + "</a>";
  }
  function prRef(n) {
    return ext(cfg.pr_url_base + n, "#" + n, "#" + n) + also("pr", String(n), "#" + n);
  }
  function issueUrl(id) {
    if (!cfg.issue_url) return "";
    return cfg.issue_url.includes("{id}") ? cfg.issue_url.split("{id}").join(id) : cfg.issue_url + id;
  }
  function refs(src, hold) {
    return src.replace(refRe, (m, dp, dpn, rp, rpn, d, dn, iss, ik, inum, pre, pr, pn, sha) => {
      if (dp || d) {
        const n = +(dpn || dn);
        const h = deskRef(n, m);
        return h === null ? m : hold(h);
      }
      if (rp) return hold(prRef(+rpn));
      if (pr) return pre + hold(prRef(+pn));
      if (iss) {
        const id = ik.toUpperCase() + "-" + +inum;
        const u = issueUrl(id);
        return hold((u ? ext(u, id, id) : internal("/ref/issue/" + id, id, id)) + also("issue", id, id));
      }
      if (sha) {
        const full = ctx && ctx.commits && ctx.commits[sha];
        if (!full) return m;
        const label = sha.length > 12 ? sha.slice(0, 9) : sha;
        return hold((cfg.commit_url_base ? ext(cfg.commit_url_base + full, label, "commit " + full)
          : internal("/ref/commit/" + full, label, "commit " + full)) + also("commit", full, sha.slice(0, 9)));
      }
      return m;
    });
  }
  function urlAlso(url) {
    if (!cfg.pr_url_base) return "";
    let m = url.match(new RegExp("^" + reEsc(cfg.pr_url_base) + "(\\d+)", "i"));
    if (!m && cfg.repo) m = url.match(new RegExp("^https?://github\\.com/" + reEsc(cfg.repo) + "/(?:pull|issues)/(\\d+)", "i"));
    return m ? also("pr", String(+m[1]), "#" + +m[1]) : "";
  }

  function inline(src) {
    const slots = [];
    const hold = (html) => "\u0000" + (slots.push(html) - 1) + "\u0000";
    // code spans first (contents verbatim)
    src = src.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, __, c) => hold("<code>" + esc(c.trim() === "" ? c : c.replace(/^ (.*) $/, "$1")) + "</code>"));
    // images -> rendered as links (never auto-load arbitrary remote images)
    src = src.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, alt, url) => {
      const u = safeUrl(url);
      if (!u) return m;
      if (/^\/files\//.test(u)) return hold('<img class="md-img" src="' + esc(u) + '" alt="' + esc(alt) + '">');
      return hold('<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(alt || u) + "</a>");
    });
    // links
    src = src.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, text, url) => {
      const u = safeUrl(url);
      if (!u) return m;
      if (/^\/(item|ref)\//.test(u)) return hold('<a href="' + esc(u) + '" data-nav>' + inlineNoLinks(text) + "</a>");
      return hold('<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + inlineNoLinks(text) + "</a>" + urlAlso(u));
    });
    // bare URLs
    src = src.replace(/(^|[\s(])(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g, (_, pre, url) =>
      pre + hold('<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(url) + "</a>" + urlAlso(url)));
    // desk items, PRs, issues, commits
    src = refs(src, hold);
    let out = inlineNoLinks(src);
    return out.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[+i]);
  }

  function inlineNoLinks(s) {
    s = esc(s);
    s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__(?=\S)([\s\S]*?\S)__/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?!\*)/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^_\w])_(?=\S)([^_]*?\S)_(?![_\w])/g, "$1<em>$2</em>");
    s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
    s = s.replace(/ {2,}\n|\\\n/g, "<br>");
    return s;
  }

  const reFence = /^ {0,3}(```+|~~~+)\s*([\w+.-]*)\s*$/;
  const reHead = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const reHr = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
  const reList = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const reQuote = /^ {0,3}>\s?(.*)$/;
  const reTableSep = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

  function splitRow(line) {
    line = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    const cells = [];
    let cur = "", inCode = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === "`") inCode = !inCode;
      if (ch === "\\" && line[i + 1] === "|") { cur += "|"; i++; continue; }
      if (ch === "|" && !inCode) { cells.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    cells.push(cur.trim());
    return cells;
  }

  function render(src) {
    const lines = String(src || "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
    return blocks(lines);
  }

  function blocks(lines) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*$/.test(line)) { i++; continue; }
      let m;
      if ((m = line.match(reFence))) {
        const fence = m[1], lang = m[2];
        const buf = [];
        i++;
        while (i < lines.length && !(lines[i].trim().startsWith(fence[0].repeat(fence.length)) && lines[i].trim().replace(/[`~]/g, "") === "")) buf.push(lines[i++]);
        i++;
        out.push('<pre><code' + (lang ? ' class="lang-' + esc(lang) + '"' : "") + ">" + esc(buf.join("\n")) + "</code></pre>");
        continue;
      }
      if ((m = line.match(reHead))) {
        const n = m[1].length;
        out.push("<h" + n + ">" + inline(m[2]) + "</h" + n + ">");
        i++;
        continue;
      }
      if (reHr.test(line)) { out.push("<hr>"); i++; continue; }
      if (reQuote.test(line)) {
        const buf = [];
        while (i < lines.length && (m = lines[i].match(reQuote))) { buf.push(m[1]); i++; }
        out.push("<blockquote>" + blocks(buf) + "</blockquote>");
        continue;
      }
      if (line.includes("|") && i + 1 < lines.length && reTableSep.test(lines[i + 1]) && lines[i + 1].includes("-")) {
        const head = splitRow(line);
        const aligns = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? "center" : /-+:$/.test(c) ? "right" : /^:-+/.test(c) ? "left" : ""));
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && !/^\s*$/.test(lines[i])) rows.push(splitRow(lines[i++]));
        const al = (j) => (aligns[j] ? ' style="text-align:' + aligns[j] + '"' : "");
        let t = '<div class="table-wrap"><table><thead><tr>' + head.map((c, j) => "<th" + al(j) + ">" + inline(c) + "</th>").join("") + "</tr></thead><tbody>";
        for (const r of rows) t += "<tr>" + head.map((_, j) => "<td" + al(j) + ">" + inline(r[j] || "") + "</td>").join("") + "</tr>";
        out.push(t + "</tbody></table></div>");
        continue;
      }
      if ((m = line.match(reList))) {
        const r = list(lines, i);
        out.push(r.html);
        i = r.next;
        continue;
      }
      if (/^ {4,}\S/.test(line)) {
        const buf = [];
        while (i < lines.length && (/^ {4,}/.test(lines[i]) || /^\s*$/.test(lines[i]))) buf.push(lines[i++].slice(4));
        while (buf.length && !buf[buf.length - 1].trim()) buf.pop();
        out.push("<pre><code>" + esc(buf.join("\n")) + "</code></pre>");
        continue;
      }
      const buf = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !reFence.test(lines[i]) && !reHead.test(lines[i]) &&
        !reQuote.test(lines[i]) && !(buf.length && reList.test(lines[i]) && !/^\s{4,}/.test(lines[i])) && !reHr.test(lines[i])) buf.push(lines[i++]);
      out.push("<p>" + inline(buf.join("\n")) + "</p>");
    }
    return out.join("\n");
  }

  function list(lines, start) {
    const first = lines[start].match(reList);
    const indent = first[1].length;
    const ordered = /\d/.test(first[2]);
    const items = [];
    let i = start;
    while (i < lines.length) {
      const m = lines[i].match(reList);
      if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered) {
        if (m && m[1].length < indent) break;
        if (!m && !/^\s*$/.test(lines[i]) && items.length && /^\s+/.test(lines[i]) && lines[i].search(/\S/) > indent) {
          items[items.length - 1].push(lines[i].slice(Math.min(lines[i].search(/\S/), indent + 2)));
          i++;
          continue;
        }
        if (m && m[1].length > indent && items.length) {
          items[items.length - 1].push(lines[i].slice(indent + 2 > m[1].length ? m[1].length : indent + 2));
          i++;
          continue;
        }
        if (/^\s*$/.test(lines[i]) && i + 1 < lines.length && (lines[i + 1].match(reList) || /^\s{2,}\S/.test(lines[i + 1]))) {
          const nm = lines[i + 1].match(reList);
          if (nm && nm[1].length < indent) break;
          i++;
          continue;
        }
        break;
      }
      items.push([m[3]]);
      i++;
    }
    const tag = ordered ? "ol" : "ul";
    const startAttr = ordered && parseInt(first[2], 10) !== 1 ? ' start="' + parseInt(first[2], 10) + '"' : "";
    const lis = items.map((it) => {
      let head = it[0];
      let cls = "";
      const tm = head.match(/^\[([ xX])\]\s+(.*)$/);
      if (tm) {
        cls = ' class="task"';
        head = (tm[1] === " " ? "☐ " : "☑ ") + tm[2];
      }
      const rest = it.slice(1);
      const nested = rest.length ? blocks(rest) : "";
      return "<li" + cls + ">" + inline(head) + nested + "</li>";
    });
    return { html: "<" + tag + startAttr + ">" + lis.join("") + "</" + tag + ">", next: i };
  }

  window.MD = {
    render, esc,
    inline: (s) => inline(String(s || "")),
    configure(c) { Object.assign(cfg, c || {}); buildRefRe(); },
    setContext(c) { ctx = c || null; },
  };
})();
