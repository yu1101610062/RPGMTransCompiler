import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { Issue, RuntimeProfile } from "../core/types.js";

export interface LaunchResult {
  launched: boolean;
  process?: ChildProcess;
  executable?: string;
  issues: Issue[];
}

export function launchGame(profile: RuntimeProfile): LaunchResult {
  const executable = findExecutable(profile.outputRoot);
  if (!executable) {
    return {
      launched: false,
      issues: [issue("runtime_executable_missing", "warning", `No launchable desktop executable was found in ${profile.outputRoot}.`)]
    };
  }
  const child = spawn(executable, [], {
    cwd: profile.outputRoot,
    stdio: "ignore",
    windowsHide: false
  });
  child.unref();
  return { launched: true, process: child, executable, issues: [] };
}

export function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise(resolve => {
    child.on("exit", code => resolve(code));
    child.on("error", () => resolve(null));
  });
}

function findExecutable(root: string): string | undefined {
  const preferred = ["Game.exe", "RPG_RT.exe", "nw.exe"];
  for (const name of preferred) {
    const file = path.join(root, name);
    if (fs.existsSync(file)) return file;
  }
  if (process.platform === "win32") {
    const exe = fs.readdirSync(root).find(name => /\.exe$/i.test(name));
    if (exe) return path.join(root, exe);
  }
  return undefined;
}

function issue(type: string, severity: Issue["severity"], message: string): Issue {
  return {
    issueId: `${type}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type,
    severity,
    message,
    createdAt: new Date().toISOString()
  };
}
