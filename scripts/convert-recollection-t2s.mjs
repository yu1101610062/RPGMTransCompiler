#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import OpenCC from "../work/opencc-runtime/node_modules/opencc-js/dist/esm/full.js";

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".json",
  ".jsonl",
  ".tsv",
  ".csv",
  ".ini",
  ".log",
]);

function usage() {
  console.log(`Usage:
  node scripts/convert-recollection-t2s.mjs <recollection_role_export> [--from t|tw|hk|twp] [--dry-run] [--no-rename]

Converts Traditional Chinese to Simplified Chinese in text files and, by default,
also converts directory/file names. Binary assets such as PNG files are not rewritten.`);
}

function parseArgs(argv) {
  const args = {
    target: "",
    from: "t",
    dryRun: false,
    rename: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--from") {
      const value = argv[++i];
      if (!value || !["tw", "hk", "t", "twp"].includes(value)) {
        throw new Error("--from must be one of: tw, hk, t, twp");
      }
      args.from = value;
      continue;
    }
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--no-rename") {
      args.rename = false;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (args.target) {
      throw new Error(`Unexpected extra path: ${arg}`);
    }
    args.target = arg;
  }

  if (!args.target) {
    usage();
    throw new Error("Missing recollection_role_export path");
  }
  return args;
}

function walk(root) {
  const entries = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, dirent.name);
      const stat = fs.lstatSync(fullPath);
      entries.push({ path: fullPath, isDirectory: dirent.isDirectory(), stat });
      if (dirent.isDirectory()) {
        stack.push(fullPath);
      }
    }
  }
  return entries;
}

function isTextFile(filePath) {
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function uniquePath(filePath) {
  if (!fs.existsSync(filePath)) {
    return filePath;
  }

  const parent = path.dirname(filePath);
  const ext = path.extname(filePath);
  const stem = path.basename(filePath, ext);
  for (let i = 1; i < 1000; i += 1) {
    const candidate = path.join(parent, `${stem}__dup${i}${ext}`);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Cannot find conflict-free path for ${filePath}`);
}

function applyProjectSimplifications(text) {
  return text
    .replaceAll("妳", "你")
    .replaceAll("祢", "你");
}

function depthOf(filePath, root) {
  const rel = path.relative(root, filePath);
  return rel ? rel.split(path.sep).length : 0;
}

function convertFileContents(entries, converter, dryRun) {
  let scanned = 0;
  let changed = 0;
  const errors = [];

  for (const entry of entries) {
    if (entry.isDirectory || !isTextFile(entry.path)) {
      continue;
    }
    scanned += 1;
    try {
      const before = fs.readFileSync(entry.path, "utf8");
      const after = converter(before);
      if (after !== before) {
        changed += 1;
        if (!dryRun) {
          fs.writeFileSync(entry.path, after, "utf8");
        }
      }
    } catch (error) {
      errors.push({ path: entry.path, error: String(error?.message ?? error) });
    }
  }

  return { scanned, changed, errors };
}

function renamePaths(root, converter, dryRun) {
  const entries = walk(root)
    .filter((entry) => path.basename(entry.path) !== "data.dts.text")
    .sort((a, b) => depthOf(b.path, root) - depthOf(a.path, root));

  let changed = 0;
  const renames = [];

  for (const entry of entries) {
    const oldName = path.basename(entry.path);
    const newName = converter(oldName);
    if (newName === oldName) {
      continue;
    }

    const parent = path.dirname(entry.path);
    const requested = path.join(parent, newName);
    const target = uniquePath(requested);
    changed += 1;
    renames.push({ from: entry.path, to: target });

    if (!dryRun) {
      fs.renameSync(entry.path, target);
    }
  }

  return { changed, renames };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.target);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Target is not a directory: ${root}`);
  }
  if (path.basename(root) !== "recollection_role_export") {
    throw new Error(`Expected recollection_role_export directory, got: ${root}`);
  }

  const openccConverter = OpenCC.Converter({ from: args.from, to: "cn" });
  const converter = (text) => applyProjectSimplifications(openccConverter(text));
  const entriesBeforeRename = walk(root);
  const contents = convertFileContents(entriesBeforeRename, converter, args.dryRun);
  const rename = args.rename ? renamePaths(root, converter, args.dryRun) : { changed: 0, renames: [] };

  const result = {
    target: root,
    from: args.from,
    to: "cn",
    dryRun: args.dryRun,
    textFilesScanned: contents.scanned,
    textFilesChanged: contents.changed,
    pathNamesChanged: rename.changed,
    readErrors: contents.errors,
  };

  console.log(JSON.stringify(result, null, 2));
  if (contents.errors.length > 0) {
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(error?.stack ?? String(error));
  process.exit(1);
}
