import fs from "node:fs";
import path from "node:path";

export function copyTreeSync(source: string, target: string, options: { exclude?: (fullPath: string) => boolean } = {}): void {
  if (options.exclude?.(source)) return;
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      copyTreeSync(path.join(source, entry), path.join(target, entry), options);
    }
  } else if (stat.isFile()) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
}

export function prepareGeneratedDir(dir: string, markerName = ".rpgmtrans-generated"): void {
  const marker = path.join(dir, markerName);
  if (fs.existsSync(dir)) {
    if (!fs.existsSync(marker) && fs.readdirSync(dir).length > 0) {
      throw new Error(`Refusing to overwrite non-generated directory: ${dir}`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(marker, `generated=${new Date().toISOString()}\n`, "utf8");
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export function listFiles(root: string, pattern?: RegExp): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (!pattern || pattern.test(entry.name)) out.push(full);
    }
  }
  return out.sort();
}
