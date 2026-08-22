#!/usr/bin/env node
// upgrade-kernel.mjs — 执行内核升级：拉取新源码 → 替换 → 改 package.json → 提交
// 用法: node scripts/upgrade-kernel.mjs <target-version>
// 例:   node scripts/upgrade-kernel.mjs 0.1.2-rc.1
import { readFileSync, writeFileSync, existsSync, rmSync, cpSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(root, "..");
const HARNESS_DIR = path.join(PROJECT, "deepseek-harness");
const PACKAGE_JSON = path.join(PROJECT, "package.json");

const targetVersion = process.argv[2];
if (!targetVersion) {
  console.error("用法: node scripts/upgrade-kernel.mjs <target-version>");
  console.error("例:   node scripts/upgrade-kernel.mjs 0.1.2-rc.1");
  process.exit(1);
}

function run(cmd) {
  try {
    return execSync(cmd, { cwd: PROJECT, encoding: "utf8", stdio: "pipe" }).trim();
  } catch (err) {
    console.error("命令失败: " + cmd);
    console.error(err.stderr || err.message);
    process.exit(1);
  }
}

// ---------- 1. 检查工作区干净 ----------
const status = run("git status --porcelain");
if (status) {
  console.error("工作区不干净，请先提交或暂存：");
  console.error(status);
  process.exit(1);
}
console.log("✅ 工作区干净");

// ---------- 2. 确认在 main 分支 ----------
const currentBranch = run("git branch --show-current");
if (currentBranch !== "main") {
  console.log("当前不在 main（当前: " + currentBranch + "），先切换到 main");
  run("git checkout main");
}
console.log("✅ 在 main 分支");

// ---------- 3. 版本信息 ----------
const cleanVersion = targetVersion.replace(/^v/, "");
const tag = "dsh-v" + cleanVersion;
const branchName = "upgrade/dsh-" + cleanVersion;
console.log("目标版本: " + cleanVersion);
console.log("上游 tag: " + tag);
console.log("分支名:   " + branchName);

// ---------- 4. 建分支 ----------
const existingBranches = run("git branch --list " + branchName);
if (existingBranches) {
  console.error("分支 " + branchName + " 已存在，请先处理：");
  console.error("   git branch -D " + branchName);
  process.exit(1);
}
run("git checkout -b " + branchName);
console.log("✅ 创建分支 " + branchName);

// ---------- 5. 拉取上游源码 ----------
const TMP = path.join(PROJECT, ".upgrade-tmp");
if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });

console.log("拉取上游 " + tag + " ...");
try {
  run('git clone --depth 1 --branch ' + tag + ' https://github.com/deepseek-ai/deepseek-harness.git "' + TMP + '"');
} catch {
  console.log("tag " + tag + " 不存在，尝试 master 分支...");
  try {
    run('git clone --depth 1 --branch master https://github.com/deepseek-ai/deepseek-harness.git "' + TMP + '"');
  } catch (e2) {
    console.error("无法拉取上游源码");
    process.exit(1);
  }
}

// ---------- 6. 替换内嵌源码 ----------
if (existsSync(HARNESS_DIR)) rmSync(HARNESS_DIR, { recursive: true, force: true });
cpSync(TMP, HARNESS_DIR, { recursive: true });
rmSync(path.join(HARNESS_DIR, ".git"), { recursive: true, force: true });
rmSync(TMP, { recursive: true, force: true });
console.log("✅ 源码已替换");

// ---------- 7. 读取上游版本并更新 package.json ----------
const upstreamPkg = JSON.parse(readFileSync(path.join(HARNESS_DIR, "package.json"), "utf8"));
const upstreamVersion = upstreamPkg.version;
console.log("上游实际版本: " + upstreamVersion);

// 更新 package.json 依赖版本
const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8"));
const oldVersion = pkg.dependencies["@deepseek-ai/dsh"].replace(/^\^/, "");
const newRange = "^" + upstreamVersion;

console.log("依赖更新: " + oldVersion + " → " + upstreamVersion);
for (const key of Object.keys(pkg.dependencies)) {
  if (key.startsWith("@deepseek-ai/dsh")) {
    pkg.dependencies[key] = newRange;
  }
}

// 更新 allowScripts
for (const key of Object.keys(pkg.allowScripts || {})) {
  if (key.startsWith("@deepseek-ai/dsh-subprocess-local@")) {
    delete pkg.allowScripts[key];
    pkg.allowScripts["@deepseek-ai/dsh-subprocess-local@" + upstreamVersion] = true;
  }
}

writeFileSync(PACKAGE_JSON, JSON.stringify(pkg, null, 2) + "\n", "utf8");
console.log("✅ package.json 已更新");

// ---------- 8. 提交 ----------
run("git add -A");
run('git commit -m "chore: upgrade kernel to ' + upstreamVersion + '"');
console.log("✅ 已提交");

// ---------- 9. 完成提示 ----------
console.log();
console.log("✅ 升级完成！分支: " + branchName);
console.log("   - 内嵌源码已替换为 " + upstreamVersion);
console.log("   - package.json 依赖已更新");
console.log("   - 已提交到 git");
console.log();
console.log("下一步:");
console.log("  1. npm install              # 重新安装依赖");
console.log("  2. npm run dist             # 打包");
console.log("  3. 手动测试");
console.log("  4. node scripts/merge-release.mjs  # 合并发布");
