#!/usr/bin/env node
// check-upstream.mjs — 检查上游 deepseek-harness 是否有新版本
// 用法: node scripts/check-upstream.mjs [--json]
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_PKG = path.join(root, "..", "deepseek-harness", "package.json");
const DESKTOP_PKG = path.join(root, "..", "package.json");
const JSON_MODE = process.argv.includes("--json");

// ---------- semver 比较（仅处理 rc/prerelease 格式） ----------
function parseSemver(v) {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+?))?(?:\+.+)?$/);
  if (!m) return null;
  return {
    major: +m[1], minor: +m[2], patch: +m[3],
    pre: m[4] || null, // e.g. "rc.2"
  };
}

function compare(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // prerelease: "rc.N" → N 越大越新
  const pa = a.pre ? parseInt(a.pre.split(".").pop()) : Infinity;
  const pb = b.pre ? parseInt(b.pre.split(".").pop()) : Infinity;
  return pa - pb;
}

// ---------- 获取本地版本 ----------
const localPkg = JSON.parse(readFileSync(HARNESS_PKG, "utf8"));
const localVersion = localPkg.version; // e.g. "0.1.1-rc.2"

const desktopPkg = JSON.parse(readFileSync(DESKTOP_PKG, "utf8"));
const desktopVersion = desktopPkg.version;

// ---------- 查询上游 GitHub Releases ----------
async function fetchGitHubReleases() {
  try {
    const res = await fetch(
      "https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=10",
      { headers: { "User-Agent": "dsh-desktop-checker" } }
    );
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    return await res.json();
  } catch (err) {
    return { error: String(err) };
  }
}

// ---------- 查询 npm registry ----------
async function fetchNpmTags() {
  try {
    const res = await fetch("https://registry.npmjs.org/@deepseek-ai/dsh");
    if (!res.ok) throw new Error(`npm registry ${res.status}`);
    const data = await res.json();
    return {
      latest: data["dist-tags"]?.latest || null,
      next: data["dist-tags"]?.next || null,
      allVersions: Object.keys(data.versions || {}).filter(v => v.includes("rc")),
    };
  } catch (err) {
    return { error: String(err) };
  }
}

// ---------- 主逻辑 ----------
async function main() {
  const localParsed = parseSemver(localVersion);
  if (!localParsed) {
    console.error(`无法解析本地版本: ${localVersion}`);
    process.exit(1);
  }

  const [releases, npmInfo] = await Promise.all([fetchGitHubReleases(), fetchNpmTags()]);

  // 找上游最新版本
  let upstreamVersion = null;
  let upstreamDate = null;
  let upstreamBody = null;

  if (Array.isArray(releases) && releases.length > 0) {
    for (const r of releases) {
      const tag = r.tag_name || "";
      // tags 通常是 dsh-v0.1.1-rc.2 或 v0.1.1-rc.2
      const v = tag.replace(/^dsh-?v?/, "");
      const parsed = parseSemver(v);
      if (parsed && compare(parsed, localParsed) > 0) {
        upstreamVersion = v;
        upstreamDate = r.published_at || r.created_at;
        upstreamBody = r.body?.slice(0, 200) || "";
        break; // releases 按时间倒序，第一个比本地新的就是最新
      }
    }
    // 如果没有找到更新的，取第一个作为最新
    if (!upstreamVersion && releases.length > 0) {
      const tag = releases[0].tag_name || "";
      upstreamVersion = tag.replace(/^dsh-?v?/, "");
      upstreamDate = releases[0].published_at || releases[0].created_at;
    }
  }

  const npmLatest = npmInfo.latest || "unknown";
  const npmNext = npmInfo.next || "unknown";

  // ---------- 输出 ----------
  if (JSON_MODE) {
    console.log(JSON.stringify({
      desktop: { version: desktopVersion },
      harness: { version: localVersion },
      upstream: { version: upstreamVersion, date: upstreamDate, body: upstreamBody },
      npm: { latest: npmLatest, next: npmNext },
      hasUpdate: upstreamVersion ? compare(localParsed, parseSemver(upstreamVersion)) < 0 : false,
    }, null, 2));
    return;
  }

  console.log(`桌面版:          ${desktopVersion}`);
  console.log(`内嵌源码:        ${localVersion}`);
  console.log(`npm latest:      ${npmLatest}`);
  console.log(`npm next:        ${npmNext}`);
  console.log(`上游最新:        ${upstreamVersion || "获取失败"}${upstreamDate ? ` (${upstreamDate.slice(0, 10)})` : ""}`);
  console.log();

  if (upstreamVersion) {
    const upstreamParsed = parseSemver(upstreamVersion);
    if (compare(localParsed, upstreamParsed) < 0) {
      console.log(`⚡ 有新版本! ${localVersion} → ${upstreamVersion}`);
      if (upstreamBody) console.log(`变更摘要: ${upstreamBody}`);
      console.log();
      console.log(`升级命令: node scripts/upgrade-kernel.mjs ${upstreamVersion}`);
    } else {
      console.log(`✅ 已是最新版本`);
    }
  } else {
    console.log("⚠️  无法获取上游版本信息（网络或 API 问题）");
  }
}

main();
