import path from "node:path";
import type { Issue, RuntimeProfile } from "./core/types.js";
import { ProjectDb } from "./core/db.js";
import { scanProject } from "./engines/scanner.js";
import { writeReports } from "./core/reporter.js";
import { installRuntime, restoreRuntime, validateRuntimeInstall } from "./runtime/install.js";
import { launchGame, waitForExit } from "./runtime/launcher.js";
import { processRuntimeRequests, watchRuntime, RuntimeRequestReader } from "./runtime/watch.js";
import { pretranslateRuntime } from "./pretranslate/pretranslate.js";

export function scanCommand(sourceRoot: string, options: { targetLang?: string; out?: string; db?: string }): { dbPath: string; profile: RuntimeProfile } {
  const result = scanProject(sourceRoot, options);
  const db = new ProjectDb(result.dbPath);
  try {
    db.setProfile(result.profile);
    db.replaceIssues([]);
  } finally {
    db.close();
  }
  return result;
}

export function installRuntimeCommand(dbPath: string, out?: string): { outputRoot: string; issues: number; fatal: number; errors: number } {
  const db = new ProjectDb(dbPath);
  try {
    const profile = withOutput(db.getProfile(), out);
    if (out) db.setProfile(profile);
    const result = installRuntime(profile);
    db.addIssues(result.issues);
    return summarizeIssues(result.outputRoot, result.issues);
  } finally {
    db.close();
  }
}

export function restoreRuntimeCommand(dbPath: string): { outputRoot: string; restored: number; deleted: number; issues: number; fatal: number; errors: number } {
  const db = new ProjectDb(dbPath);
  try {
    const result = restoreRuntime(db.getProfile());
    db.addIssues(result.issues);
    return {
      outputRoot: result.outputRoot,
      restored: result.restored,
      deleted: result.deleted,
      issues: result.issues.length,
      fatal: result.issues.filter(item => item.severity === "fatal").length,
      errors: result.issues.filter(item => item.severity === "error").length
    };
  } finally {
    db.close();
  }
}

export async function watchCommand(dbPath: string, provider: string, options: { once?: boolean; pollMs?: number; batchSize?: number; concurrency?: number; skipTranslated?: boolean } = {}): Promise<{ processed: number; translated: number; skippedCached: number; issues: number; fatal: number; errors: number }> {
  const db = new ProjectDb(dbPath);
  try {
    const profile = db.getProfile();
    const result = await watchRuntime(profile, provider, options);
    db.addIssues(result.issues);
    db.setJson("runtime_watch", { provider, ...result, updatedAt: new Date().toISOString() });
    return {
      processed: result.processed,
      translated: result.translated,
      skippedCached: result.skippedCached,
      issues: result.issues.length,
      fatal: result.issues.filter(item => item.severity === "fatal").length,
      errors: result.issues.filter(item => item.severity === "error").length
    };
  } finally {
    db.close();
  }
}

export async function pretranslateCommand(dbPath: string, provider: string, options: { mode?: "safe"; batchSize?: number; concurrency?: number; overwrite?: boolean; progress?: boolean } = {}): Promise<{ scanned: number; candidates: number; translated: number; skippedCached: number; skippedUnsafe: number; issues: number; fatal: number; errors: number }> {
  const db = new ProjectDb(dbPath);
  try {
    const profile = db.getProfile();
    const { progress, ...runtimeOptions } = options;
    const result = await pretranslateRuntime(profile, provider, {
      ...runtimeOptions,
      onProgress: progress ? event => {
        console.error(`[预翻译] ${event.message} 进度 ${event.batchesCompleted}/${event.batchesTotal}，运行中 ${event.inFlight}，扫描 ${event.scanned}，候选 ${event.candidates}，待翻译 ${event.queued}，已写入 ${event.translated}，跳过 ${event.skippedCached + event.skippedUnsafe}，问题 ${event.issues}`);
      } : undefined
    });
    db.replaceIssues([
      ...db.allIssues().filter(item => !item.type.startsWith("pretranslate_")),
      ...result.issues
    ]);
    db.setJson("runtime_pretranslate", {
      provider,
      scanned: result.scanned,
      candidates: result.candidates,
      translated: result.translated,
      skippedCached: result.skippedCached,
      skippedUnsafe: result.skippedUnsafe,
      issues: result.issues.length,
      fatal: result.issues.filter(item => item.severity === "fatal").length,
      errors: result.issues.filter(item => item.severity === "error").length,
      updatedAt: new Date().toISOString()
    });
    return {
      scanned: result.scanned,
      candidates: result.candidates,
      translated: result.translated,
      skippedCached: result.skippedCached,
      skippedUnsafe: result.skippedUnsafe,
      issues: result.issues.length,
      fatal: result.issues.filter(item => item.severity === "fatal").length,
      errors: result.issues.filter(item => item.severity === "error").length
    };
  } finally {
    db.close();
  }
}

export function validateRuntimeCommand(dbPath: string): { issues: number; fatal: number; errors: number } {
  const db = new ProjectDb(dbPath);
  try {
    const issues = validateRuntimeInstall(db.getProfile());
    const runtimeTypes = new Set([
      "runtime_manifest_missing",
      "runtime_file_missing",
      "mvmz_js_root_missing",
      "mvmz_runtime_plugin_missing",
      "mvmz_plugins_js_not_registered",
      "mvmz_plugins_js_invalid",
      "rgss_scripts_missing",
      "runtime_engine_unsupported",
      "renpy_game_dir_missing",
      "renpy_runtime_script_missing",
      "tyrano_runtime_script_missing",
      "tyrano_runtime_not_registered"
    ]);
    const preserved = db.allIssues().filter(item => !runtimeTypes.has(item.type));
    db.replaceIssues([...preserved, ...issues]);
    db.setJson("runtime_validation", { issues, updatedAt: new Date().toISOString() });
    return {
      issues: issues.length,
      fatal: issues.filter(item => item.severity === "fatal").length,
      errors: issues.filter(item => item.severity === "error").length
    };
  } finally {
    db.close();
  }
}

export function reportCommand(dbPath: string, out?: string): { reportRoot: string } {
  const db = new ProjectDb(dbPath);
  try {
    const reportRoot = out || path.join(db.getProfile().workRoot, "reports");
    writeReports(db, reportRoot);
    return { reportRoot };
  } finally {
    db.close();
  }
}

export async function runCommand(sourceRoot: string, options: { targetLang?: string; out?: string; provider: string; db?: string; once?: boolean; noLaunch?: boolean }): Promise<{ dbPath: string; outputRoot: string; launched: boolean; translated: number; issues: number }> {
  const scan = scanCommand(sourceRoot, options);
  installRuntimeCommand(scan.dbPath, options.out);
  validateRuntimeCommand(scan.dbPath);

  const db = new ProjectDb(scan.dbPath);
  const profile = db.getProfile();
  const reader = new RuntimeRequestReader(profile.outputRoot);
  let translated = 0;
  const issues: Issue[] = [];
  try {
    if (options.noLaunch) {
      const result = await processRuntimeRequests(profile, options.provider, reader);
      translated += result.translated;
      issues.push(...result.issues);
      db.addIssues(result.issues);
      db.setJson("runtime_run", { launched: false, translated, issues, updatedAt: new Date().toISOString() });
      return { dbPath: scan.dbPath, outputRoot: profile.outputRoot, launched: false, translated, issues: issues.length };
    }

    const launch = launchGame(profile);
    db.addIssues(launch.issues);
    issues.push(...launch.issues);
    if (!launch.process) {
      const result = await processRuntimeRequests(profile, options.provider, reader);
      translated += result.translated;
      issues.push(...result.issues);
      db.addIssues(result.issues);
      db.setJson("runtime_run", { launched: false, translated, issues, updatedAt: new Date().toISOString() });
      return { dbPath: scan.dbPath, outputRoot: profile.outputRoot, launched: false, translated, issues: issues.length };
    }

    let exited = false;
    const exitPromise = waitForExit(launch.process).then(() => {
      exited = true;
    });
    while (!exited) {
      const result = await processRuntimeRequests(profile, options.provider, reader);
      translated += result.translated;
      if (result.issues.length) {
        issues.push(...result.issues);
        db.addIssues(result.issues);
      }
      if (options.once) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    await Promise.race([exitPromise, Promise.resolve()]);
    const final = await processRuntimeRequests(profile, options.provider, reader);
    translated += final.translated;
    issues.push(...final.issues);
    db.addIssues(final.issues);
    db.setJson("runtime_run", { launched: true, executable: launch.executable, translated, issues, updatedAt: new Date().toISOString() });
    return { dbPath: scan.dbPath, outputRoot: profile.outputRoot, launched: true, translated, issues: issues.length };
  } finally {
    db.close();
  }
}

function withOutput(profile: RuntimeProfile, out?: string): RuntimeProfile {
  if (!out) return profile;
  return { ...profile, outputRoot: path.resolve(out).replace(/\\/g, "/") };
}

function summarizeIssues(outputRoot: string, issues: Issue[]): { outputRoot: string; issues: number; fatal: number; errors: number } {
  return {
    outputRoot,
    issues: issues.length,
    fatal: issues.filter(item => item.severity === "fatal").length,
    errors: issues.filter(item => item.severity === "error").length
  };
}
