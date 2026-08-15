// 桌面外壳 preload（运行于 contextIsolation: false，以便拦截页面的 fetch）。
// 职责：
//   1. 拦截 dsh 页面的 host.pickDirectory 请求，改走 Electron 原生目录对话框
//      （dsh 自带的 win32 原生对话框依赖 koffi 3.1.5，在此 Windows 环境上
//      指针内存读写失效会崩溃；Electron 的 dialog.showOpenDialog 完全绕开它，
//      且恢复「此电脑 → 选择任意盘」的原生体验）。
//   2. 拦截 host.openPath 请求（会话里点击文件、产物文件面板的「打开」），
//      改走主进程 shell.openPath：让 Agent 修改/生成的文件直接用系统默认
//      编辑器打开查看编辑，绕开 dsh 服务端 spawn powershell 的慢路径。
//   3. 暴露只读的桌面外壳标记 window.dshDesktop。
const { ipcRenderer } = require("electron");

const nativeFetch = window.fetch.bind(window);

/** 解析 fetch 调用里的 client-request body；不是目标 RPC 时返回 null。 */
function parseClientRequest(url, init, method) {
  if (url.pathname !== `/api/${method}` || (init?.method ?? "GET") !== "POST") return null;
  try {
    const bodyText = typeof init?.body === "string"
      ? init.body
      : (init?.body !== undefined && init?.body !== null ? String(init.body) : "");
    const body = JSON.parse(bodyText);
    if (body.type !== "client-request" || body.method !== method) return null;
    return body;
  } catch {
    return null;
  }
}

/** 构造 server-response 回包。 */
function rpcResponse(rpcId, result) {
  return new Response(JSON.stringify({ type: "server-response", rpcId, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

window.fetch = async function (input, init) {
  try {
    const url = input instanceof URL
      ? input
      : (typeof input === "string"
        ? new URL(input, window.location.origin)
        : new URL(input.url, window.location.origin));

    const pickRequest = parseClientRequest(url, init, "host.pickDirectory");
    if (pickRequest !== null) {
      const path = await ipcRenderer.invoke("dsh:pick-directory");
      return rpcResponse(pickRequest.rpcId ?? "", { ok: true, value: { path: path ?? null } });
    }

    const openRequest = parseClientRequest(url, init, "host.openPath");
    if (openRequest !== null) {
      const target = openRequest.payload?.path;
      if (typeof target === "string" && target !== "") {
        const result = await ipcRenderer.invoke("dsh:open-file", target);
        return rpcResponse(openRequest.rpcId ?? "", result.ok
          ? { ok: true, value: { opened: true } }
          : { ok: false, error: { code: "internal", message: result.message ?? "open failed", details: {} } });
      }
    }
  } catch (error) {
    // 桥接失败回退到真实 fetch（仍可能触发服务端路径，但不破坏调用链）。
    console.error("[dsh-desktop] host bridge failed:", error);
  }
  return nativeFetch(input, init);
};

window.dshDesktop = {
  isDesktop: true,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
};

// ---------- 插件清单「打开配置」按钮 ----------
// dsh 的插件清单（设置 → 插件）是只读展示，没有打开配置文件的入口。
// 这里在运行时给每个展开的插件卡片注入一个「打开配置」按钮，点击后用系统
// 默认程序打开 cordis.patch.yml（所有插件的用户配置都集中在这个文件里）。
// 该注入不改 dsh 源码，只作用于桌面版页面 DOM。
function injectOpenConfigButtons() {
  const cards = document.querySelectorAll("[data-plugin-entry]");
  for (const card of cards) {
    // 展开时卡片内会出现带 id 的详情区（div[id]）。
    const details = card.querySelector("div[id]");
    if (details === null) continue;
    if (details.querySelector(".dsh-desktop-open-config") !== null) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "dsh-desktop-open-config";
    button.textContent = "打开配置";
    button.style.cssText = [
      "margin-top:10px",
      "padding:5px 14px",
      "border:1px solid rgba(127,127,127,.4)",
      "border-radius:6px",
      "background:transparent",
      "color:inherit",
      "cursor:pointer",
      "font-size:12px",
      "line-height:1.4",
    ].join(";");
    button.addEventListener("click", async () => {
      try {
        const home = await ipcRenderer.invoke("dsh:get-home");
        if (home) await ipcRenderer.invoke("dsh:open-path", `${home}\\cordis.patch.yml`);
      } catch (error) {
        console.error("[dsh-desktop] open-config failed:", error);
      }
    });
    details.appendChild(button);
  }
}
// React 会按需重建卡片 DOM，因此持续观察并（重新）注入按钮。
// 注意：preload 在文档解析前运行，document.documentElement 此时还是 null，
// 所以观察 document 本身（始终存在）而不是 documentElement。
const observer = new MutationObserver(() => injectOpenConfigButtons());
observer.observe(document, { childList: true, subtree: true });
window.addEventListener("DOMContentLoaded", injectOpenConfigButtons);

