// src/updater.js — 应用内自动更新检查（GitHub Releases）
// electron-updater 是 CJS 包且 autoUpdater 为 getter 导出，ESM 命名导入
// 会抛 "does not provide an export named 'autoUpdater'"，必须用 require 解构。
import { app, dialog, BrowserWindow } from "electron";
import { createRequire } from "node:module";
import path from "node:path";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";

const require = createRequire(import.meta.url);
const { autoUpdater } = require("electron-updater");

// ---------- 配置 ----------
const GITHUB_OWNER = "asdsad-pixe";
const GITHUB_REPO = "dsh-desktop";

// 更新源指向本项目的 GitHub Releases。
autoUpdater.setFeedURL({ provider: "github", owner: GITHUB_OWNER, repo: GITHUB_REPO });
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

// ---------- 状态 ----------
let isChecking = false;
let downloadWin = null;
let parentRef = null;

// ---------- 小工具 ----------

/** 「进行中」小窗（带可更新文案）。 */
function createProgressWindow(message) {
  const safe = message.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
  const win = new BrowserWindow({
    width: 420,
    height: 130,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: "#0f1115",
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  const html = [
    '<!doctype html><html><head><meta charset="utf-8"><style>',
    "html,body{margin:0;height:100%;background:#0f1115;color:#e6e8ee;font-family:'Segoe UI',system-ui,sans-serif}",
    ".wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;height:100%}",
    ".spin{width:24px;height:24px;border:3px solid rgba(127,127,127,.3);border-top-color:#7aa2ff;border-radius:50%;animation:r 1s linear infinite}",
    ".msg{font-size:13px;color:#b8bcc8;text-align:center;padding:0 20px}",
    "@keyframes r{to{transform:rotate(360deg)}}",
    "</style></head><body>",
    '<div class="wrap"><div class="spin"></div><div class="msg">' + safe + "</div></div>",
    "</body></html>",
  ].join("");
  void win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  win.once("ready-to-show", () => win.show());
  return win;
}

/** 更新进度小窗的文案（页面无预载监听器，用 executeJavaScript 直接改文本）。 */
function setProgressMessage(text) {
  if (downloadWin && !downloadWin.isDestroyed()) {
    downloadWin.webContents
      .executeJavaScript(`(document.querySelector(".msg")||{}).textContent = ${JSON.stringify(text)}`)
      .catch(() => {});
  }
}

function closeProgressWindow() {
  if (downloadWin && !downloadWin.isDestroyed()) downloadWin.close();
  downloadWin = null;
}

/** 下载文件（跟随 3xx 重定向，报告进度）。 */
function downloadFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("too many redirects"));
    const client = url.startsWith("https") ? https : http;
    const file = createWriteStream(dest);
    client
      .get(url, { headers: { "User-Agent": "dsh-desktop-updater" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          const next = new URL(res.headers.location, url).toString();
          downloadFile(next, dest, redirects + 1).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          reject(new Error("HTTP " + res.statusCode + " — " + url));
          return;
        }
        const total = parseInt(res.headers["content-length"] || "0", 10);
        let downloaded = 0;
        res.on("data", (chunk) => {
          downloaded += chunk.length;
          const pct = total > 0 ? Math.round((downloaded / total) * 100) : 0;
          setProgressMessage(pct > 0 ? `正在下载更新… ${pct}%` : "正在下载更新…");
        });
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
        file.on("error", reject);
      })
      .on("error", (err) => { file.close(); reject(err); });
  });
}

// ---------- 主入口 ----------

/**
 * 检查应用更新（菜单「帮助 → 检查更新…」）。
 * 优先走 electron-updater（需要 Release 里有 latest.yml）；
 * 失败时降级为 GitHub API 直接比对 tag 并下载 Setup 安装包。
 * @param {import("electron").BrowserWindow|null} parentWindow
 */
export async function checkForUpdates(parentWindow) {
  if (isChecking) return;
  isChecking = true;
  parentRef = parentWindow ?? null;
  try {
    let result = null;
    try {
      result = await autoUpdater.checkForUpdates();
    } catch {
      result = null; // Release 没有 latest.yml 等情况 → 走 API 降级
    }

    const newVersion = result?.updateInfo?.version || null;
    if (newVersion && newVersion !== app.getVersion()) {
      const ok = await askUpdate(newVersion, "electron-updater");
      if (ok) await downloadViaAutoUpdater();
      return;
    }
    if (newVersion && newVersion === app.getVersion()) {
      await showUpToDate();
      return;
    }
    // autoUpdater 拿不到信息 → GitHub API 降级
    await checkViaGitHubAPI();
  } finally {
    isChecking = false;
  }
}

async function showUpToDate() {
  await dialog.showMessageBox(parentRef ?? undefined, {
    type: "info",
    title: "已是最新版本",
    message: "当前版本 " + app.getVersion() + " 已是最新。",
  });
}

/** 询问用户是否更新；返回 true 表示立即更新。 */
async function askUpdate(newVersion, via) {
  const { response } = await dialog.showMessageBox(parentRef ?? undefined, {
    type: "info",
    title: "发现新版本",
    message: "新版本 " + newVersion + " 可用",
    detail: "当前版本: " + app.getVersion() + "\n新版本: " + newVersion + "\n\n是否立即下载并安装？",
    buttons: ["立即更新", "稍后再说"],
    defaultId: 0,
    cancelId: 1,
  });
  return response === 0;
}

/** GitHub API 降级方案：直接比对 Release tag，下载 Setup 安装包静默重装。 */
async function checkViaGitHubAPI() {
  let release;
  try {
    const res = await fetch(
      "https://api.github.com/repos/" + GITHUB_OWNER + "/" + GITHUB_REPO + "/releases/latest",
      { headers: { "User-Agent": "dsh-desktop-updater" } }
    );
    if (!res.ok) throw new Error("GitHub API HTTP " + res.status);
    release = await res.json();
  } catch (err) {
    await dialog.showMessageBox(parentRef ?? undefined, {
      type: "warning",
      title: "检查更新失败",
      message: "无法连接到更新服务器。",
      detail: String(err),
    });
    return;
  }

  const latestVersion = (release.tag_name || "").replace(/^v/, "");
  if (!latestVersion) return;

  if (latestVersion === app.getVersion()) {
    await showUpToDate();
    return;
  }

  const setupAsset = (release.assets || []).find(
    (a) => typeof a.name === "string" && a.name.includes("Setup") && a.name.endsWith(".exe")
  );
  if (!setupAsset) {
    await dialog.showMessageBox(parentRef ?? undefined, {
      type: "warning",
      title: "未找到安装包",
      message: "新版本 " + latestVersion + " 已发布，但未找到 Windows 安装包。",
      detail: "请前往 GitHub 手动下载：\n" + release.html_url,
    });
    return;
  }

  if (await askUpdate(latestVersion, "github-api")) {
    await downloadAndRunInstaller(setupAsset, latestVersion);
  }
}

/** 下载 Release 里的 Setup.exe 到临时目录，确认后静默重装并退出。 */
async function downloadAndRunInstaller(asset, version) {
  const tmpDir = path.join(app.getPath("temp"), "dsh-desktop-update");
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
  const installerPath = path.join(tmpDir, asset.name);
  downloadWin = createProgressWindow("正在下载 " + version + " …");
  try {
    await downloadFile(asset.browser_download_url, installerPath);
    closeProgressWindow();
    const { response } = await dialog.showMessageBox(parentRef ?? undefined, {
      type: "info",
      title: "下载完成",
      message: "新版本 " + version + " 已下载完成。",
      detail: "是否立即关闭应用并运行安装程序？",
      buttons: ["立即安装", "稍后安装"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      spawn(installerPath, ["/S"], { detached: true, stdio: "ignore" }).unref();
      app.quit();
    }
  } catch (err) {
    closeProgressWindow();
    dialog.showErrorBox("下载失败", String(err));
  }
}

/** electron-updater 标准下载 + 安装路径（Release 含 latest.yml 时生效）。 */
async function downloadViaAutoUpdater() {
  downloadWin = createProgressWindow("正在下载更新…");
  autoUpdater.on("download-progress", (progress) => {
    setProgressMessage("正在下载更新… " + Math.round(progress.percent) + "%");
  });
  autoUpdater.once("update-downloaded", async () => {
    closeProgressWindow();
    const { response } = await dialog.showMessageBox(parentRef ?? undefined, {
      type: "info",
      title: "更新就绪",
      message: "下载完成，是否立即重启并安装？",
      buttons: ["立即重启", "下次启动时安装"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.once("error", async () => {
    closeProgressWindow();
    // autoUpdater 下载失败 → 降级为直装 Setup 包
    await checkViaGitHubAPI();
  });
  try {
    await autoUpdater.downloadUpdate();
  } catch {
    closeProgressWindow();
    await checkViaGitHubAPI();
  }
}
