import path from "node:path";
import { fileURLToPath } from "node:url";

const thisFile = fileURLToPath(import.meta.url);
export const srcRoot = path.resolve(path.dirname(thisFile), "..");
export const projectRoot = path.resolve(srcRoot, "..");
export const defaultWorkRoot = process.env.RPGMTRANS_WORK_ROOT || path.join(projectRoot, "work");
export const rgssBridgePath = path.join(projectRoot, "scripts", "rgss_bridge.rb");
export const rgssRuntimeScriptPath = path.join(projectRoot, "scripts", "runtime_rgss.rb");

export function normalizePath(input: string): string {
  return path.resolve(input).replace(/\\/g, "/");
}

export function toDisplayPath(input: string): string {
  return input.replace(/\\/g, "/");
}
