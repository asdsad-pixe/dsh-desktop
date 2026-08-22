#!/usr/bin/env node
// bump-desktop-version.mjs — 递增桌面版版本号
// 用法: node scripts/bump-desktop-version.mjs patch|minor|major
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(root, "..");
const PACKAGE_JSON = path.join(PROJECT, "package.json");

const bumpType = process.argv[2]; // patch | minor | major
if (!["patch", "minor", "major"].includes(bumpType)) {
  console.error("用法: node scripts/bump-desktop-version.mjs patch|minor|major");
  process.exit(1);
}

function run(cmd) {
  try {
    return execSync(cmd, { cwd: PROJECT, encoding: "utf8", stdio: "pipe" }).trim();
  } catch (err) {
    console.error(`命令失败: ${cmd}`);
    console.error(err.stderr || err.message);
    process.exit(1);
  }
}

// 读取当前版本
const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8"));
const [major, minor, patch] = pkg.version.split(".").map(Number);

let newVersion;
switch (bumpType) {
  case "major": newVersion = `${major + 1}.0.0`; break;
  case "minor": newVersion = `${major}.${minor + 1}.0`; break;
  case "patch": newVersion = `${major}.${minor}.${patch + 1}`; break;
}

console.log(`版本更新: ${pkg.version} → ${newVersion}`);

// 更新 package.json
pkg.version = newVersion;
writeFileSync(PACKAGE_JSON, JSON.stringify(pkg, null, 2) + "\n", "utf8");

// 提交
run("git add package.json");
run(`git commit -m "chore: bump desktop version to ${newVersion}"`);

console.log(`✅ 版本已更新为 ${newVersion}`);
console.log(`   提交: git commit (chore: bump desktop version to ${newVersion})`);
