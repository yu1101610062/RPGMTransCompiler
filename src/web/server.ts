import http from "node:http";
import { URL } from "node:url";
import { ProjectDb } from "../core/db.js";
import { runtimeSummary } from "../core/reporter.js";
import { readRuntimeCache, runtimeCachePath } from "../runtime/protocol.js";

export function startWebServer(dbPath: string, port: number): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    try {
      if (url.pathname === "/") return sendHtml(res, page());
      if (url.pathname === "/api/summary") {
        const db = new ProjectDb(dbPath);
        try {
          return sendJson(res, runtimeSummary(db.getProfile(), db.allIssues()));
        } finally {
          db.close();
        }
      }
      if (url.pathname === "/api/cache") {
        const db = new ProjectDb(dbPath);
        try {
          const profile = db.getProfile();
          return sendJson(res, [...readRuntimeCache(runtimeCachePath(profile.outputRoot)).values()].slice(0, 5000));
        } finally {
          db.close();
        }
      }
      if (url.pathname === "/api/issues") {
        const db = new ProjectDb(dbPath);
        try {
          return sendJson(res, db.allIssues());
        } finally {
          db.close();
        }
      }
      res.statusCode = 404;
      res.end("not found");
    } catch (error) {
      res.statusCode = 500;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end((error as Error).stack || String(error));
    }
  });
  server.listen(port, "127.0.0.1");
  return server;
}

function sendJson(res: http.ServerResponse, value: unknown): void {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(value, null, 2));
}

function sendHtml(res: http.ServerResponse, value: string): void {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(value);
}

function page(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>RPGMTransCompiler 运行时审阅台</title>
  <style>
    body { margin: 0; font-family: "Segoe UI", "Microsoft YaHei", Arial, sans-serif; color: #202936; background: #f7f8fa; }
    header { display: flex; gap: 16px; align-items: center; padding: 14px 18px; background: #1f2933; color: white; }
    header h1 { font-size: 18px; margin: 0; }
    main { padding: 18px; }
    nav { display: flex; gap: 8px; margin-bottom: 16px; }
    button { border: 1px solid #a7b1be; background: white; padding: 7px 10px; border-radius: 6px; cursor: pointer; }
    button.active { background: #2f6fed; color: white; border-color: #2f6fed; }
    table { border-collapse: collapse; width: 100%; background: white; }
    th, td { border-bottom: 1px solid #e1e6ed; padding: 8px; text-align: left; vertical-align: top; font-size: 13px; }
    th { background: #eef2f7; position: sticky; top: 0; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; margin-bottom: 18px; }
    .metric { background: white; border: 1px solid #e1e6ed; border-radius: 8px; padding: 12px; }
    .metric strong { display: block; font-size: 22px; margin-top: 4px; }
    code { white-space: pre-wrap; }
  </style>
</head>
<body>
  <header><h1>RPGMTransCompiler 运行时审阅台</h1><span id="project"></span></header>
  <main>
    <nav>
      <button data-view="CACHE" class="active">译文缓存</button>
      <button data-view="ISSUES">问题</button>
    </nav>
    <section id="metrics" class="grid"></section>
    <section id="content"></section>
  </main>
  <script>
    let current = "CACHE";
    const metricLabels = {
      requestFiles: "请求日志文件",
      requestLines: "已记录文本",
      cachedTranslations: "缓存译文",
      fatalIssues: "致命问题",
      errors: "错误",
      warnings: "警告"
    };
    document.querySelectorAll("button").forEach(button => button.addEventListener("click", () => {
      document.querySelectorAll("button").forEach(item => item.classList.remove("active"));
      button.classList.add("active");
      current = button.dataset.view;
      load();
    }));
    async function load() {
      const summary = await fetch("/api/summary").then(r => r.json());
      document.querySelector("#project").textContent = "引擎 " + summary.engine + " / 目标语言 " + summary.targetLang;
      document.querySelector("#metrics").innerHTML = ["requestFiles","requestLines","cachedTranslations","fatalIssues","errors","warnings"].map(k => '<div class="metric">' + metricLabels[k] + '<strong>' + summary[k] + '</strong></div>').join("");
      if (current === "ISSUES") {
        const issues = await fetch("/api/issues").then(r => r.json());
        document.querySelector("#content").innerHTML = table(["severity","type","message"], issues);
      } else {
        const cache = await fetch("/api/cache").then(r => r.json());
        document.querySelector("#content").innerHTML = table(["engine","source","target","provider","updatedAt"], cache);
      }
    }
    function table(cols, rows) {
      return '<table><thead><tr>' + cols.map(c => '<th>' + label(c) + '</th>').join("") + '</tr></thead><tbody>' +
        rows.map(row => '<tr>' + cols.map(c => '<td><code>' + escapeHtml(String(row[c] ?? "")) + '</code></td>').join("") + '</tr>').join("") +
        '</tbody></table>';
    }
    function label(c) {
      return ({ severity: "级别", type: "类型", message: "信息", engine: "引擎", source: "原文", target: "译文", provider: "来源", updatedAt: "更新时间" })[c] || c;
    }
    function escapeHtml(s) {
      return s.replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    }
    load();
    setInterval(load, 2000);
  </script>
</body>
</html>`;
}
