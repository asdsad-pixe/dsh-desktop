#!/usr/bin/env node
// merge-release.mjs — 合并 upgrade 分支到 main 并打 tag
// 用法: node scripts/merge-release.mjs
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";

const root = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(root, "..");
const PACKAGE_JSON = path.join(PROJECT, "package.json");

function run(cmd) {
  try {
    return execSync(cmd, { cwd: PROJECT, encoding: "utf8", stdio: "pipe" }).trim();
  } catch (err) {
    console.error(`命令失败: ${cmd}`);
    console.error(err.stderr || err.message);
    process.exit(1);
  }
}

// ---------- 1. 检查当前分支是 upgrade/* ----------
const branch = run("git branch --show-current");
if (!branch.startsWith("upgrade/dsh-")) {
  console.error(`当前不在 upgrade 分支（当前: ${branch}）`);
  console.error("请先运行: node scripts/upgrade-kernel.mjs <version>");
  process.exit(1);
}

// ---------- 2. 检查工作区干净 ----------
const status = run("git status --porcelain");
if (status) {
  console.error("工作区不干净，请先提交更改");
  process.exit(1);
}

// ---------- 3. 检查 dist 目录有产物 ----------
const distDir = path.join(PROJECT, "dist");
if (!existsSync(distDir)) {
  console.error("dist/ 目录不存在，请先运行: npm run dist");
  process.exit(1);
}
const distFiles = run('dir /b "dist\\*.exe" 2>nul');
if (!distFiles) {
  console.error("dist/ 中没有 .exe 安装包，请先运行: npm run dist");
  process.exit(1);
}

// ---------- 4. 读取版本号 ----------
const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8"));
const desktopVersion = pkg.version;
console.log(`桌面版本: ${desktopVersion}`);
console.log(`当前分支: ${branch}`);

// ---------- 5. 合并到 main ----------
console.log("切换到 main...");
run("git checkout main");
console.log(`合并 ${branch}...`);
run(`git merge --no-ff ${branch} -m "Merge ${branch} — kernel upgrade to ${branch.replace("upgrade/dsh-", "")}"`);

// ---------- 6. 打 tag ----------
const tag = `v${desktopVersion}`;
console.log(`打 tag: ${tag}...`);
run(`git tag -f ${tag}`);

// ---------- 7. 推送 ----------
console.log("推送到 origin...");
run("git push origin main --tags");

// ---------- 8. 删除本地 upgrade 分支 ----------
console.log(`删除本地分支 ${branch}...`);
run(`git branch -d ${branch}`);

console.log();
console.log(`✅ 发布完成！`);
console.log(`   分支: main (已推送)`);
console.log(`   标签: ${tag}`);
console.log(`   GitHub Actions 将自动构建发布。`);
console.log(`   下一步: node scripts/merge-release.mjs 上传安装包到 Release`);
