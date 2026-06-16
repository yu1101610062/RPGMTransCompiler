import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const project = path.join(root, "desktop", "RPGMTransLauncher", "RPGMTransLauncher.csproj");
const buildDir = path.join(root, "desktop", "RPGMTransLauncher", "bin", "Release", "net8.0-windows10.0.19041.0", "win-x64");
const publishDir = path.join(root, "desktop", "RPGMTransLauncher", "bin", "Release", "net8.0-windows10.0.19041.0", "win-x64", "publish");

run("npm", ["run", "build"], root);
rm(publishDir);
run("dotnet", [
  "publish",
  project,
  "-c",
  "Release",
  "-r",
  "win-x64",
  "--self-contained",
  "true",
  "-o",
  publishDir
], root);

copyWinUIResources();
syncRuntimeFiles();
installProductionDependencies();
copyNodeRuntime();

console.log(`Published RPGMTransLauncher to ${publishDir}`);

function copyWinUIResources() {
  for (const name of fs.readdirSync(buildDir)) {
    if (!/\.(xbf|pri)$/i.test(name)) continue;
    copyFileIfExists(path.join(buildDir, name), path.join(publishDir, name));
  }
}

function syncRuntimeFiles() {
  fs.mkdirSync(publishDir, { recursive: true });
  for (const name of ["dist", "scripts", "node_modules", "node"]) {
    rm(path.join(publishDir, name));
  }
  copyDir(path.join(root, "dist"), path.join(publishDir, "dist"));
  copyDir(path.join(root, "scripts"), path.join(publishDir, "scripts"));
  for (const name of ["package.json", "package-lock.json", "LICENSE", "README.md"]) {
    copyFileIfExists(path.join(root, name), path.join(publishDir, name));
  }
}

function installProductionDependencies() {
  run("npm", ["ci", "--omit=dev", "--ignore-scripts"], publishDir);
}

function copyNodeRuntime() {
  const nodeDir = path.join(publishDir, "node");
  fs.mkdirSync(nodeDir, { recursive: true });
  const target = path.join(nodeDir, process.platform === "win32" ? "node.exe" : "node");
  fs.copyFileSync(process.execPath, target);

  const sourceDir = path.dirname(process.execPath);
  for (const name of fs.readdirSync(sourceDir)) {
    if (!/\.(dll|dat)$/i.test(name)) continue;
    const source = path.join(sourceDir, name);
    const stat = fs.statSync(source);
    if (!stat.isFile()) continue;
    fs.copyFileSync(source, path.join(nodeDir, name));
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function copyDir(source, target) {
  fs.cpSync(source, target, { recursive: true });
}

function copyFileIfExists(source, target) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function rm(target) {
  fs.rmSync(target, { recursive: true, force: true });
}
