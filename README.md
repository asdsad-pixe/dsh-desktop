# DeepSeek Harness 桌面版

把 DeepSeek Harness 打包成一个**独立桌面软件**：应用启动时在后台自动拉起 `dsh web`
本地服务（模型仍走 DeepSeek 云端 API），并用原生窗口展示界面。**双击即用，
不需要任何终端，与网页版（浏览器里的 3080 实例）完全独立**。

## 快速开始

### 打包好的成品

运行 `npm run dist` 后，`dist/` 目录下有：

- `DeepSeek Harness Setup 1.1.0.exe` —— 安装版（推荐，生成桌面/开始菜单快捷方式）
- `DeepSeek-Harness-1.1.0-portable.exe` —— 便携单文件版（双击即用，不写注册表）
- `DeepSeek-Harness-1.1.0-green.zip` —— 绿色免安装版（解压后直接运行里面的
  `DeepSeek Harness.exe`，同样不写注册表）

双击运行即可。第一次启动会自动在后台启动独立的 dsh 服务（自动分配空闲端口），
随后弹出应用窗口。

> 备注：便携单文件版在部分环境下可能被安全软件或受限环境拦截其自解压启动。
> 如果便携版双击后无窗口弹出，请改用安装版或绿色版。

### 开发模式运行

```powershell
npm install
npm start
```

## 独立模式（v1.1.0 起）

桌面版默认与网页版完全隔离，二者可同时运行、互不干扰：

1. **独立数据目录**：桌面版使用自己的 DSH_HOME ——
   `%APPDATA%\DeepSeek Harness\dsh-home`。会话历史、个性化配置、API 凭据
   都放在这里，不读写网页版的 `C:\Users\<user>\.dsh`。
   - 首次启动时，如果网页版共享 home 里已有 API 凭据
     （`C:\Users\<user>\.dsh\.credentials.yaml`），会自动复制一份到独立目录，
     开箱即用；之后两个环境各自独立。
2. **独立服务进程**：桌面版总是自启一个独立的 dsh web 服务（随机空闲端口），
   不复用网页版的 3080 实例；关闭桌面窗口只杀掉自己的服务，不动网页版。
3. **崩溃防御**：启动前会确保 DSH_HOME 目录已存在，避免 dsh 的配置监听器
   回退到用户主目录、撞上 NTUSER.DAT 等被系统锁定的文件而崩溃（v1.0.0
   实测中发现的 EBUSY 崩溃）。
4. **原生目录对话框**：添加工作区/选择目录时直接弹出 Windows 原生「选择目录」
   对话框（可切到任意盘、完整导航）。补丁层把目录选择固定为 native 交互对，
   渲染层 preload 拦截 `host.pickDirectory` 请求并桥接到 Electron 原生对话框，
   请求不会到达 dsh 服务，从而绕开 dsh 自带的 koffi 原生对话框（其在本机
   Windows 上会崩溃）。旧版安装（强制 browse 页面内浏览）首次启动时自动升级补丁。
5. **菜单「文件」**：提供「打开配置文件 (cordis.patch.yml)」「打开设置文件
   (settings.yaml)」「打开数据目录」「打开日志目录」四个入口，用系统默认
   程序打开，便于直接查看/编辑配置。
6. **文件查看/编辑**：会话里点击 Agent 修改/生成的文件（产物文件面板、消息
   中的文件提及）直接用系统默认编辑器打开。桌面版 preload 拦截
   `host.openPath` 请求桥接到 Electron `shell.openPath`，不走 dsh 服务端
   spawn powershell 的慢路径。
7. **插件安装/移除**：菜单「插件」→「安装插件…/移除插件…」，调用
   `dsh plugin --profile web add|remove`（含 bundle 层栈自动对账）。桌面版
   捆绑 pnpm CLI（`pnpm` 依赖包），不要求用户机器装有 pnpm；安装成功后可选
   一键重启 dsh 服务使插件生效。菜单「插件 → 重启 dsh 服务」也可手动重启。

### 可选项（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_DESKTOP_HOME` | `%APPDATA%\DeepSeek Harness\dsh-home` | 指定一个自定义数据目录（同样会被自动创建）。桌面版**不会**读取外部 `DSH_HOME`，保证与网页版隔离 |
| `DSH_APP_REUSE` | 未设置（独立） | 设为 `1` 时改为复用外部实例：先探测 `127.0.0.1:3080`，有 Harness 实例就复用它，没有才自启 |
| `DSH_APP_PORT` | `3080` | 仅配合 `DSH_APP_REUSE=1` 使用，修改探测端口 |

## 数据与配置在哪

桌面版默认全部数据都在自己的独立目录：

```
%APPDATA%\DeepSeek Harness\
├── dsh-home\            # DSH_HOME：会话、凭据、配置
│   ├── sessions\        # 会话历史
│   ├── .credentials.yaml# API 凭据（首次启动自动从网页版共享 home 复制）
│   └── settings.yaml    # 个性化配置
└── logs\                # dsh 服务日志
```

想换一套环境（例如专门给另一个项目用），设置 `DSH_DESKTOP_HOME` 环境变量再启动即可。

## 日志

应用自己拉起的 dsh 服务日志写在：

```
%APPDATA%\DeepSeek Harness\logs\dsh-web-<时间戳>.log
```

启动失败时，错误弹窗里也会给出日志文件路径。

## 当前内核版本

当前桌面版内置的是 **npm 最新版 `@deepseek-ai/dsh@0.1.0-rc.6`**（及全部
`@deepseek-ai/*` 配套包），不是本地源码构建。升级内核直接用下面的
「更新 DSH 内核」流程即可。

## 使用本地源码构建（内嵌 deepseek-harness 源码）

本仓库已内嵌内核源码（`deepseek-harness/` 目录）。桌面版可改用其构建产物
（例如改动源码后自测），流程：

```powershell
# 1. 在内嵌源码里安装依赖并构建（首次）
cd deepseek-harness
pnpm install          # 需要 pnpm 11.7.0（node --version ≥ 22.19）
pnpm run build        # 编译全部包 + 前端 dist

# 2. 把构建产物同步进桌面版（覆盖 npm 版 node_modules）
cd ..
npm run sync:local    # 即 node sync-local-source.mjs，@deepseek-ai/* 包来自内嵌源码

# 3. 重新打包
npm run dist
```

> 注意：
> - `sync-local-source.mjs` 只拷贝每个包的 `files` 清单产物（lib/dist/config），不会带入
>   pnpm 的符号链接；`@deepseek-ai/cordis`、`cosmokit`、`schemastery` 等框架包来自
>   仓库 `vendor/` 目录。
> - 执行过 `npm install` 之后需要重跑一次 `node sync-local-source.mjs`（npm 会覆盖
>   被同步的包）。

## 更新 DSH 内核（npm 版）

```powershell
npm update @deepseek-ai/dsh
npm run dist
```

## 已知限制

- 需要联网（模型走 DeepSeek 云端 API；首次打包构建需要下载 Electron）。
- 只支持 Windows x64。
- 独立模式与网页版数据不互通；如需共享同一套会话，请设置
  `DSH_DESKTOP_HOME=C:\Users\<user>\.dsh`（不建议与网页版同时运行）。
- **目录选择走 Electron 原生对话框**：dsh 自带的 win32 原生文件夹对话框依赖
  koffi 3.1.5，而该版本在此 Windows 环境上存在指针内存读写失效的 bug（选择
  目录时 worker 原生崩溃）。桌面版补丁层把目录选择固定为 native 交互对
  （`dsh-home\cordis.patch.yml`），preload 拦截 `host.pickDirectory` 请求桥接到
  Electron 原生对话框，请求不到达 dsh 服务，koffi 不会被触发。如需改回页面内
  目录浏览（browse）兜底，手动编辑该补丁文件即可（内容已自定义后不再被覆盖）。
