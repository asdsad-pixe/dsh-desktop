// sync-local-source.mjs — 把本地 deepseek-harness 源码构建产物同步进桌面版 node_modules
// 用法: node sync-local-source.mjs [--dry-run]
import { readFileSync, existsSync, mkdirSync, rmSync, cpSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = (await import("node:module")).createRequire(import.meta.url);
const root = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(root, "deepseek-harness");
const APP_NM = path.join(root, "node_modules", "@deepseek-ai");
const DRY = process.argv.includes("--dry-run");

/** 扫描 packages/<domain>/<pkg> 与 apps/<pkg>，建立 @deepseek-ai/<name> -> 目录 索引 */
function buildIndex() {
  const index = new Map();
  const scan = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const pj = path.join(dir, e.name, "package.json");
      if (!existsSync(pj)) continue;
      let name;
      try { name = JSON.parse(readFileSync(pj, "utf8")).name; } catch { continue; }
      if (typeof name === "string" && name.startsWith("@deepseek-ai/")) index.set(name, path.join(dir, e.name));
    }
  };
  scan(path.join(SRC, "apps"));
  scan(path.join(SRC, "vendor"));
  const pkgs = path.join(SRC, "packages");
  for (const domain of readdirSync(pkgs, { withFileTypes: true })) {
    if (domain.isDirectory()) scan(path.join(pkgs, domain.name));
  }
  return index;
}

/** 拷贝一个包的构建产物到目标目录 */
function syncPackage(name, srcDir, targetDir) {
  let pj;
  try { pj = JSON.parse(readFileSync(path.join(srcDir, "package.json"), "utf8")); } catch { return "package.json 读取失败"; }
  const files = Array.isArray(pj.files) ? pj.files : [];
  // files 里通常是 glob（如 lib/*.js），这里对每个条目取其目录前缀复制整个条目目录
  const entries = new Set();
  for (const f of files) {
    if (f.includes("*")) {
      const dir = f.slice(0, f.indexOf("/"));
      if (dir) entries.add(dir);
    } else {
      entries.add(f);
    }
  }
  // 兜底：lib/ 与 dist/ 存在则一并带上
  for (const extra of ["lib", "dist", "config"]) {
    if (existsSync(path.join(srcDir, extra))) entries.add(extra);
  }
  if (DRY) {
    return `dry: files=[${[...entries].join(",")}]`;
  }
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
  cpSync(path.join(srcDir, "package.json"), path.join(targetDir, "package.json"));
  for (const e of entries) {
    const s = path.join(srcDir, e);
    if (!existsSync(s)) continue;
    cpSync(s, path.join(targetDir, e), { recursive: true });
  }
  return `synced (${entries.size} entries)`;
}

const index = buildIndex();
console.log(`source index: ${index.size} @deepseek-ai packages`);
const appPkgs = readdirSync(APP_NM, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
let synced = 0, skipped = 0;
for (const name of appPkgs) {
  const full = "@deepseek-ai/" + name;
  const srcDir = index.get(full);
  if (!srcDir) { console.log(`  SKIP  ${name}  (not in local source)`); skipped++; continue; }
  const result = syncPackage(full, srcDir, path.join(APP_NM, name));
  console.log(`  ${result.startsWith("synced") ? "SYNC " : "DRY  "} ${name}  <- ${path.relative(SRC, srcDir)}  ${result}`);
  synced++;
}
console.log(`done: ${synced} synced, ${skipped} skipped`);
