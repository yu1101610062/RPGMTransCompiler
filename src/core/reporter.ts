import fs from "node:fs";
import path from "node:path";
import type { Issue, RuntimeProfile } from "./types.js";
import type { ProjectDb } from "./db.js";
import { writeJson } from "./fs.js";
import { readRuntimeCache, runtimeCachePath, runtimeManifestPath, runtimeRoot } from "../runtime/protocol.js";

export function writeReports(db: ProjectDb, reportRoot: string): void {
  fs.mkdirSync(reportRoot, { recursive: true });
  const profile = db.getProfile();
  const issues = db.allIssues();
  const summary = runtimeSummary(profile, issues);
  const runtimeWatch = db.getJson<unknown>("runtime_watch");
  const runtimeRun = db.getJson<unknown>("runtime_run");
  const runtimeValidation = db.getJson<unknown>("runtime_validation");
  const runtimePretranslate = db.getJson<unknown>("runtime_pretranslate");

  writeJson(path.join(reportRoot, "scan_report.json"), profile);
  writeJson(path.join(reportRoot, "runtime_report.json"), {
    summary,
    runtimeWatch,
    runtimeRun,
    runtimeValidation,
    runtimePretranslate
  });
  writeJson(path.join(reportRoot, "cache_report.json"), {
    cacheFile: runtimeCachePath(profile.outputRoot),
    entries: [...readRuntimeCache(runtimeCachePath(profile.outputRoot)).values()]
  });
  writeJson(path.join(reportRoot, "exception_report.json"), {
    generatedAt: new Date().toISOString(),
    summary,
    blocking: issues.filter(issue => issue.severity === "fatal" || issue.severity === "error"),
    warnings: issues.filter(issue => issue.severity === "warning"),
    info: issues.filter(issue => issue.severity === "info")
  });
  fs.writeFileSync(path.join(reportRoot, "final_summary.html"), html(summary, issues), "utf8");
}

export function runtimeSummary(profile: RuntimeProfile, issues: Issue[]): Record<string, unknown> {
  const root = runtimeRoot(profile.outputRoot);
  const requestDir = path.join(root, "requests");
  const cacheFile = runtimeCachePath(profile.outputRoot);
  const requestFiles = fs.existsSync(requestDir) ? fs.readdirSync(requestDir).filter(name => name.endsWith(".rtlog")) : [];
  const requestLines = requestFiles.reduce((sum, file) => sum + countRequestLines(path.join(requestDir, file)), 0);
  const cacheEntries = readRuntimeCache(cacheFile);
  const pretranslate = readPretranslateSummary(profile.outputRoot);
  return {
    projectId: profile.projectId,
    sourceRoot: profile.sourceRoot,
    outputRoot: profile.outputRoot,
    engine: profile.engine.name,
    targetLang: profile.targetLang,
    runtimeRoot: root,
    manifestExists: fs.existsSync(runtimeManifestPath(profile.outputRoot)),
    requestFiles: requestFiles.length,
    requestLines,
    cachedTranslations: cacheEntries.size,
    pretranslateScanned: pretranslate.scanned,
    pretranslateTranslated: pretranslate.translated,
    pretranslateSkipped: pretranslate.skippedCached + pretranslate.skippedUnsafe,
    pretranslateIssues: pretranslate.issues,
    fatalIssues: issues.filter(issue => issue.severity === "fatal").length,
    errors: issues.filter(issue => issue.severity === "error").length,
    warnings: issues.filter(issue => issue.severity === "warning").length
  };
}

function readPretranslateSummary(outputRoot: string): { scanned: number; translated: number; skippedCached: number; skippedUnsafe: number; issues: number } {
  const file = path.join(runtimeRoot(outputRoot), "cache", "pretranslate.json");
  if (!fs.existsSync(file)) return { scanned: 0, translated: 0, skippedCached: 0, skippedUnsafe: 0, issues: 0 };
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    return {
      scanned: Number(value.scanned || 0),
      translated: Number(value.translated || 0),
      skippedCached: Number(value.skippedCached || 0),
      skippedUnsafe: Number(value.skippedUnsafe || 0),
      issues: Number(value.issues || 0)
    };
  } catch {
    return { scanned: 0, translated: 0, skippedCached: 0, skippedUnsafe: 0, issues: 0 };
  }
}

function countRequestLines(file: string): number {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(line => line.trim() && !line.startsWith("#")).length;
}

function html(summary: Record<string, unknown>, issues: Issue[]): string {
  const labels: Record<string, string> = {
    projectId: "项目 ID",
    sourceRoot: "源目录",
    outputRoot: "注入目录",
    engine: "引擎",
    targetLang: "目标语言",
    runtimeRoot: "运行时目录",
    manifestExists: "Manifest 存在",
    requestFiles: "请求日志文件",
    requestLines: "已记录文本",
    cachedTranslations: "缓存译文",
    pretranslateScanned: "预翻译扫描",
    pretranslateTranslated: "预翻译写入",
    pretranslateSkipped: "预翻译跳过",
    pretranslateIssues: "预翻译问题",
    fatalIssues: "致命问题",
    errors: "错误",
    warnings: "警告"
  };
  const rows = Object.entries(summary)
    .map(([key, value]) => `<tr><th>${escapeHtml(labels[key] || key)}</th><td>${escapeHtml(String(value))}</td></tr>`)
    .join("\n");
  const issueRows = issues.slice(0, 300).map(item => `
    <tr>
      <td>${escapeHtml(item.severity)}</td>
      <td>${escapeHtml(item.type)}</td>
      <td>${escapeHtml(item.message)}</td>
    </tr>
  `).join("\n");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>RPGMTransCompiler 运行时报告</title>
  <style>
    body { font-family: "Segoe UI", "Microsoft YaHei", Arial, sans-serif; margin: 24px; color: #1f2933; }
    table { border-collapse: collapse; width: 100%; margin: 16px 0 32px; }
    th, td { border: 1px solid #d5dbe3; padding: 8px 10px; text-align: left; vertical-align: top; }
    th { background: #eef2f7; width: 220px; }
  </style>
</head>
<body>
  <h1>RPGMTransCompiler 运行时报告</h1>
  <table>${rows}</table>
  <h2>问题</h2>
  <table><tr><th>级别</th><th>类型</th><th>信息</th></tr>${issueRows}</table>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char]!);
}
