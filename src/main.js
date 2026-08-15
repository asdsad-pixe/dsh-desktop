// DeepSeek Harness 桌面版 —— Electron 外壳（独立模式）
// 职责：以完全独立的方式运行 DeepSeek Harness：
//   - 默认使用应用自己的 DSH_HOME（应用数据目录下的 dsh-home），与网页版
//     （浏览器里的 3080 实例）不共享会话/配置/凭据，互不干扰；
//   - 总是自启一个独立的 dsh web 服务（随机空闲端口），不复用外部实例；
//   - 双击 exe 即用，全程不需要任何终端。
// 崩溃防御：dsh 的 HMR 配置监听器在 DSH_HOME 目录不存在时会向上回退到
// 用户主目录，尝试监听 NTUSER.DAT 等被 Windows 锁定的文件并抛 EBUSY 崩溃；
// 因此启动前必须确保 DSH_HOME 目录已存在（见 prepareHome）。
import { app, BrowserWindow, dialog, shell, ipcMain, Menu } from "electron";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, copyFileSync, existsSync, createWriteStream, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import http from "node:http";

const require = createRequire(import.meta.url);

/** dsh CLI 入口（随应用一起安装的依赖）。 */
const DSH_BIN = require.resolve("@deepseek-ai/dsh/lib/bin.js");
/** 探测用端口；仅在 DSH_APP_REUSE=1 时使用。 */
const PROBE_PORT = Number(process.env.DSH_APP_PORT ?? 3080);
/**
 * 设为 1 时复用外部已有实例（例如网页版 3080）而不自启独立服务。
 * 默认独立：总自启自己的服务，关闭窗口只杀掉自己拉起的进程。
 */
const REUSE = process.env.DSH_APP_REUSE === "1";
/**
 * 桌面版自己的 DSH_HOME：位于 Electron 应用数据目录下
 * （Windows 为 %APPDATA%\DeepSeek Harness\dsh-home）。
 * 注意：不读取外部 DSH_HOME 环境变量——那是网页版/终端环境的约定，
 * 桌面版必须始终使用自己的目录才能真正独立；如确需自定义位置，
 * 请设置 DSH_DESKTOP_HOME（本应用专用的覆盖变量）。
 */
const APP_HOME = process.env.DSH_DESKTOP_HOME || path.join(app.getPath("userData"), "dsh-home");
/** 等待 dsh 服务启动的最长时间。 */
const BOOT_TIMEOUT_MS = 120_000;
/** dsh web 打印的 URL 行，例如 `dsh web: http://127.0.0.1:38123`。 */
const URL_LINE = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/;
/** 网页版共享 home（C:\Users\<user>\.dsh），仅用于首次启动时复制 API 凭据。 */
const SHARED_HOME = path.join(app.getPath("home"), ".dsh");

let mainWindow = null;
/** 由本应用拉起的服务进程（窗口关闭时需要杀掉它）。 */
let owned = null; // { child, url }
/** 本应用实际使用的 DSH_HOME（whenReady 后确定）。 */
let home = null;

const iconPath = path.join(app.getAppPath(), "assets", "icon.png");

/**
 * 桌面版默认的 home 级补丁层（$DSH_HOME/cordis.patch.yml）。
 * 背景：dsh 的 win32 原生目录对话框依赖 koffi 3.1.5，而该版本在此 Windows
 * 环境上 koffi.view/decode 的指针内存读写失效——选择目录时 worker 进程
 * 原生崩溃（readUtf16 处 0xC0000005）。
 *
 * 方案：固定挂载「native」目录选择交互对，但把真正的取目录动作拦在渲染层——
 * 客户端走原生流程会向 `/api/host.pickDirectory` 发请求，preload 已拦截该
 * 请求并改走 Electron 原生目录对话框（见下方 ipcMain "dsh:pick-directory"），
 * 请求根本到不了 dsh 服务，koffi 永远不会被触发。这样既恢复了「此电脑 →
 * 选择任意盘」的原生体验，又彻底绕开会崩溃的 koffi 原生对话框。
 *
 * 仅在该文件不存在、或内容仍是旧版「browse」补丁时写入（尊重用户自定义）。
 */
const DIRECTORY_PICKER_PATCH = `# DeepSeek Harness 桌面版补丁层（由桌面应用自动生成）。
# 背景：dsh 自带的 win32 原生目录对话框依赖 koffi 3.1.5，而该版本在此 Windows
# 环境上 koffi.view/decode 的指针内存读写失效——选择目录时 worker 进程
# 原生崩溃（readUtf16 处 0xC0000005）。
# 方案：固定挂载「native」目录选择交互对；真正的取目录动作由桌面版 preload
# 拦截（/api/host.pickDirectory 改走 Electron 原生目录对话框），请求不到达
# dsh 服务，koffi 永远不会被触发。
- id: directory-picker
  disabled: true
- insert:
    - id: directory-picker-native
      name: '@deepseek-ai/dsh-host-directory-picker-native'
    - id: directory-picker-native-ui
      name: '@deepseek-ai/dsh-client-ui-directory-picker-native'
`;

/** 旧版补丁：强制 browse（页面内目录浏览）。内容与旧桌面版写入的完全一致时升级。 */
const LEGACY_BROWSE_PATCH = `# DeepSeek Harness 桌面版补丁层（由桌面应用自动生成）。
# 背景：dsh 自带的 win32 原生目录对话框依赖 koffi 3.1.5，而该版本在此 Windows
# 环境上 koffi.view/decode 的指针内存读写失效（选择目录时 worker 原生崩溃）。
# 因此固定使用页面内目录浏览（browse）交互，完全绕开原生对话框。
# 若日后 koffi 修复，删除本文件即可恢复原生对话框（auto 交互）。
- id: directory-picker
  disabled: true
- insert:
    - id: directory-picker-browse
      name: '@deepseek-ai/dsh-host-directory-picker-browse'
    - id: directory-picker-browse-ui
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
`;

// ---------- 独立数据目录 ----------
function prepareHome() {
  // 固定使用应用自己的独立 home（DSH_DESKTOP_HOME 可显式覆盖）。
  // 启动前确保目录存在：dsh 的配置监听器在 home 目录不存在时
  // 会向上回退到用户主目录，撞上 NTUSER.DAT 等被系统锁定的文件，
  // 未捕获的 EBUSY 会直接杀死 dsh 服务进程（见崩溃防御注释）。
  const effective = APP_HOME;
  mkdirSync(effective, { recursive: true });
  // 首次启动：把网页版共享 home 里的 API 凭据复制过来，开箱即用；
  // 之后两个 home 各自独立，互不影响。
  const target = path.join(effective, ".credentials.yaml");
  const source = path.join(SHARED_HOME, ".credentials.yaml");
  if (!existsSync(target) && existsSync(source)) {
    try {
      copyFileSync(source, target);
    } catch { /* 复制失败不阻塞启动；用户可在应用内重新填写凭据 */ }
  }
  // 目录选择器修复补丁：见 DIRECTORY_PICKER_PATCH 注释。
  // 首次启动写入；已是旧版 browse 补丁（内容完全一致）时就地升级；
  // 用户自定义过的文件保持不动。
  const patchFile = path.join(effective, "cordis.patch.yml");
  try {
    if (!existsSync(patchFile)) {
      writeFileSync(patchFile, DIRECTORY_PICKER_PATCH, "utf8");
    } else if (readFileSync(patchFile, "utf8").trim() === LEGACY_BROWSE_PATCH.trim()) {
      writeFileSync(patchFile, DIRECTORY_PICKER_PATCH, "utf8");
    }
  } catch { /* 写入失败不阻塞启动；preload 桥接仍由 ipcMain 保障 */ }
  return effective;
}

// ---------- 探测本地已有实例（仅 REUSE 模式使用） ----------
function fetchProbe(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve(res.statusCode === 200 && body.includes("DeepSeek Harness"));
      });
    });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
  });
}

async function isExistingDsh() {
  try { return await fetchProbe(PROBE_PORT); } catch { return false; }
}

// ---------- 拉起自己的 dsh web 服务 ----------
function startOwnServer() {
  return new Promise((resolve, reject) => {
    const logDir = path.join(app.getPath("userData"), "logs");
    mkdirSync(logDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logPath = path.join(logDir, `dsh-web-${stamp}.log`);
    const stream = createWriteStream(logPath, { flags: "a" });

    // --expose-internals 是 cordis-plugin-hmr 的要求（loader.internal 需要访问
    // Node 内部模块；打包应用里 node-addon-require-builtin 回退不可用）。
    const child = spawn(process.execPath, ["--expose-internals", DSH_BIN, "web", "--port", "0"], {
      env: { ...process.env, DSH_HOME: home, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let url = null;
    let finished = false;
    const finish = (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(bootTimer);
      if (err) reject(err);
      else resolve(url);
    };

    child.stdout.on("data", (d) => {
      stdout += d.toString();
      stream.write(d);
      const m = URL_LINE.exec(stdout);
      if (m && url === null) {
        url = m[1];
        owned = { child, url };
        finish(null);
      }
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      stream.write(d);
    });
    child.on("error", (e) => finish(e));
    child.on("exit", (code) => {
      if (url === null) {
        finish(new Error(
          `dsh 服务在启动完成前退出 (code ${code})\n日志: ${logPath}\nstderr:\n${stderr.slice(-4000)}`
        ));
      }
    });

    const bootTimer = setTimeout(() => {
      finish(new Error(`dsh 服务启动超时（${BOOT_TIMEOUT_MS / 1000}s）\n日志: ${logPath}`));
    }, BOOT_TIMEOUT_MS);
  });
}

// ---------- 关闭自己拉起的服务 ----------
function stopOwnServer() {
  if (!owned) return;
  const child = owned.child;
  owned = null;
  try {
    // Windows 上先 TerminateProcess；再补一记 taskkill /T 清理可能残留的
    // conhost/conpty 等子进程。
    child.kill();
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore", windowsHide: true,
    });
  } catch { /* 进程可能已退出 */ }
}

// ---------- 原生目录对话框桥接 ----------
// preload 拦截到 host.pickDirectory 后调用此处，弹 Electron 原生目录对话框，
// 完全绕开 dsh 的 koffi 原生对话框（其在本机 Windows 上会崩溃）。
ipcMain.handle("dsh:pick-directory", async () => {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const result = await dialog.showOpenDialog(win, {
    title: "选择目录",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// preload 侧「打开配置」按钮等用到的通用桥接。
ipcMain.handle("dsh:get-home", () => home);
ipcMain.handle("dsh:open-path", (_event, target) => {
  openInShell(target);
  return true;
});

// 页面里点击文件（产物文件、会话中的文件提及）经 host.openPath 桥接到这里：
// 用系统默认程序打开，让 Agent 修改/生成的文件可以直接查看、编辑。
ipcMain.handle("dsh:open-file", async (_event, target) => {
  if (typeof target !== "string" || target === "") {
    return { ok: false, message: "empty path" };
  }
  if (!existsSync(target)) {
    return { ok: false, message: `文件不存在: ${target}` };
  }
  try {
    const error = await shell.openPath(target);
    if (!error) return { ok: true };
    // openPath 失败（如该类型没有关联程序）：退化为资源管理器定位。
    shell.showItemInFolder(target);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: String(err) };
  }
});

/**
 * 用系统默认程序打开一个本地文件/目录。
 * shell.openPath 失败时不会抛错，而是 resolve 一段错误文本（例如 .yml
 * 没有关联默认程序）；此时降级为在资源管理器中定位该文件，保证点击总有响应。
 */
function openInShell(target) {
  if (!target) return;
  shell.openPath(target).then((error) => {
    if (error) shell.showItemInFolder(target);
  }).catch(() => { /* 目标不存在等情况：showItemInFolder 同样无能为力，静默 */ });
}

// ---------- 插件管理（dsh plugin --profile web） ----------
// dsh 的插件机制：profile（web）目录里 pnpm 安装的依赖包，凡声明 dsh.bundle
// 的会进入 dsh.profile.bundles 层栈，由「dsh plugin」命令负责安装与层栈对账。
// 用户机器不一定装有 pnpm，桌面版捆绑 pnpm（pnpm 依赖包），并在 PATH 里放一个
// 指向捆绑 CLI 的 pnpm.cmd shim，让真正的 dsh CLI 完成安装与对账（含 bundle 激活）。
const WEB_PROFILE = "web";

function ensurePnpmShim() {
  const binDir = path.join(app.getPath("userData"), "bin");
  mkdirSync(binDir, { recursive: true });
  // shim 正文必须是纯 ASCII：.cmd 按系统 OEM 代码页解析，内嵌中文路径会乱码。
  // 因此 exe 与 pnpm CLI 的真实路径通过环境变量传入（见 runDshPlugin 的 env）。
  const shim = [
    "@echo off",
    "set \"ELECTRON_RUN_AS_NODE=1\"",
    "\"%DSH_PNPM_NODE%\" \"%DSH_PNPM_CLI%\" %*",
    "",
  ].join("\r\n");
  writeFileSync(path.join(binDir, "pnpm.cmd"), shim);
  return binDir;
}

/** 运行一次 `dsh plugin --profile web <pnpmArgs>`，聚合 stdout/stderr。 */
function runDshPlugin(pnpmArgs) {
  return new Promise((resolve) => {
    const shimDir = ensurePnpmShim();
    const sep = process.platform === "win32" ? ";" : ":";
    const env = {
      ...process.env,
      DSH_HOME: home,
      ELECTRON_RUN_AS_NODE: "1",
      // pnpm.cmd shim 从这两个变量取真实路径（避免在 .cmd 里写中文路径）。
      DSH_PNPM_NODE: process.execPath,
      DSH_PNPM_CLI: require.resolve("pnpm/bin/pnpm.mjs"),
    };
    // Windows 的 PATH 键大小写不固定（常见为 Path）：按原键名前置 shim 目录。
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    env[pathKey] = shimDir + sep + (env[pathKey] ?? "");
    const child = spawn(
      process.execPath,
      ["--expose-internals", DSH_BIN, "plugin", "--profile", WEB_PROFILE, ...pnpmArgs],
      {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let output = "";
    child.stdout.on("data", (d) => { output += d.toString(); });
    child.stderr.on("data", (d) => { output += d.toString(); });
    child.on("error", (e) => resolve({ code: -1, output: output + "\n" + String(e) }));
    child.on("exit", (code) => resolve({ code: code ?? 1, output }));
  });
}

// ---------- 小对话框（输入框 / 进行中状态） ----------
const promptResolvers = new Map();

ipcMain.on("dsh:prompt-submit", (event, value) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  const settle = promptResolvers.get(win.id);
  promptResolvers.delete(win.id);
  if (settle) settle(typeof value === "string" && value.trim() !== "" ? value.trim() : null);
  win.close();
});

/** 弹出一个输入框（Promise 解析为用户输入；取消/关闭解析为 null）。 */
function promptText(title, label, placeholder = "") {
  return new Promise((resolve) => {
    const parent = mainWindow !== null && !mainWindow.isDestroyed() ? mainWindow : undefined;
    const win = new BrowserWindow({
      parent,
      modal: parent !== undefined,
      width: 580,
      height: 210,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title,
      show: false,
      icon: iconPath,
      backgroundColor: "#0f1115",
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    promptResolvers.set(win.id, resolve);
    win.on("closed", () => {
      const settle = promptResolvers.get(win.id);
      promptResolvers.delete(win.id);
      if (settle) settle(null);
    });
    win.once("ready-to-show", () => win.show());
    void win.loadFile(path.join(app.getAppPath(), "src", "prompt.html"), { query: { title, label, placeholder } });
  });
}

/** 只显示一段文案的「进行中」小窗，返回窗口本身（调用方负责 close）。 */
function createStatusWindow(message) {
  const win = new BrowserWindow({
    width: 460,
    height: 140,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: "#0f1115",
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  const safe = message.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:#0f1115;color:#e6e8ee;font-family:"Segoe UI",system-ui,sans-serif}
    .wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;height:100%}
    .spin{width:26px;height:26px;border:3px solid rgba(127,127,127,.3);border-top-color:#7aa2ff;border-radius:50%;animation:r 1s linear infinite}
    .msg{font-size:13px;padding:0 24px;text-align:center;color:#b8bcc8;word-break:break-all}
    @keyframes r{to{transform:rotate(360deg)}}
  </style></head><body><div class="wrap"><div class="spin"></div><div class="msg">${safe}</div></div></body></html>`;
  void win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  win.once("ready-to-show", () => win.show());
  return win;
}

// ---------- 插件安装/移除流程 ----------
async function restartServer() {
  stopOwnServer();
  let url = null;
  try {
    url = await startOwnServer();
  } catch (err) {
    dialog.showErrorBox("dsh 服务重启失败", String(err?.message ?? err));
    return;
  }
  if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.loadURL(url);
}

async function reportPluginResult(verb, spec, result) {
  if (result.code === 0) {
    const parent = mainWindow !== null && !mainWindow.isDestroyed() ? mainWindow : undefined;
    const { response } = await dialog.showMessageBox(parent, {
      type: "info",
      title: `插件${verb}成功`,
      message: `插件 ${spec} 已${verb}。`,
      detail: "需要重启 dsh 服务后生效，现在重启吗？",
      buttons: ["立即重启", "稍后"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) await restartServer();
  } else {
    dialog.showErrorBox(`插件${verb}失败`, result.output.slice(-4000) || `exit code ${result.code}`);
  }
}

async function installPluginFlow() {
  const spec = await promptText("安装插件", "插件 npm 包名或说明符", "@scope/name、name@1.2.3、git+https://...");
  if (spec === null) return;
  const status = createStatusWindow(`正在安装插件 ${spec}，可能需要一点时间…`);
  const result = await runDshPlugin(["add", spec]);
  if (!status.isDestroyed()) status.close();
  await reportPluginResult("安装", spec, result);
}

async function removePluginFlow() {
  const name = await promptText("移除插件", "要移除的插件包名");
  if (name === null) return;
  const status = createStatusWindow(`正在移除插件 ${name}…`);
  const result = await runDshPlugin(["remove", name]);
  if (!status.isDestroyed()) status.close();
  await reportPluginResult("移除", name, result);
}

// ---------- 菜单 ----------
function setupMenu() {
  const logDir = path.join(app.getPath("userData"), "logs");
  const menu = Menu.buildFromTemplate([
    {
      label: "文件",
      submenu: [
        {
          label: "打开配置文件 (cordis.patch.yml)",
          click: () => openInShell(path.join(home, "cordis.patch.yml")),
        },
        {
          label: "打开设置文件 (settings.yaml)",
          click: () => openInShell(path.join(home, "settings.yaml")),
        },
        {
          label: "打开数据目录",
          click: () => openInShell(home),
        },
        {
          label: "打开日志目录",
          click: () => openInShell(logDir),
        },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "插件",
      submenu: [
        { label: "安装插件…", click: () => void installPluginFlow() },
        { label: "移除插件…", click: () => void removePluginFlow() },
        { type: "separator" },
        { label: "重启 dsh 服务", click: () => void restartServer() },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

// ---------- 窗口 ----------
function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: "DeepSeek Harness",
    icon: iconPath,
    autoHideMenuBar: true,
    backgroundColor: "#0f1115",
    webPreferences: {
      preload: path.join(app.getAppPath(), "src", "preload.cjs"),
      // preload 需要拦截页面的 fetch（把 host.pickDirectory 桥接到 Electron
      // 原生目录对话框），因此关闭上下文隔离与沙箱；nodeIntegration 保持
      // 关闭，页面仍无法访问 Node。页面内容来自本地 dsh 服务，风险可控。
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL(url);

  // 站内链接留在窗口里，站外链接交给系统浏览器。
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?($|\/)/.test(target)) {
      return { action: "allow" };
    }
    shell.openExternal(target);
    return { action: "deny" };
  });

  // 服务中途挂掉时（例如被系统杀进程），尝试自己重新拉一个。
  let respawned = false;
  mainWindow.webContents.on("did-fail-load", (_e, code, _desc, _url, isMainFrame) => {
    if (!isMainFrame || owned || respawned) return;
    respawned = true;
    (async () => {
      let next = null;
      if (REUSE && (await isExistingDsh())) {
        next = `http://127.0.0.1:${PROBE_PORT}`;
      } else {
        try { next = await startOwnServer(); } catch (err) { next = null; }
      }
      if (next && mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(next);
    })();
  });

  mainWindow.on("closed", () => { mainWindow = null; });
}

// ---------- 生命周期 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on("before-quit", () => stopOwnServer());

  app.whenReady().then(async () => {
    home = prepareHome();
    setupMenu();
    let url = null;
    if (REUSE && (await isExistingDsh())) {
      url = `http://127.0.0.1:${PROBE_PORT}`;
    } else {
      try {
        url = await startOwnServer();
      } catch (err) {
        dialog.showErrorBox("DeepSeek Harness 无法启动本地服务", String(err?.message ?? err));
        app.quit();
        return;
      }
    }
    createWindow(url);
  });

  app.on("window-all-closed", () => {
    stopOwnServer();
    app.quit();
  });
}
