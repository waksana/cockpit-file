# 下载、构建与安装

## 集成状态

Current source prepares File **0.2.6** for reference-scoped missing capture failures.
The manifest declares default `instructions`; hosts that predate this field (including 0.3.0) reject the module.
The build dependency is the published **`@waksana/cockpit-module-sdk@0.2.0`** from
`https://npm.pkg.github.com`, pinned exactly in `package.json` and `pnpm-lock.yaml`.
The integration host is mainline commit `7d69b6f348e17f098bc5562fdbec317e8e2e4ba6`,
recorded separately in [`tooling/host-integration.json`](../tooling/host-integration.json).
It is not required to build or package the module. SDK and host versions are independent.
Package/manifest metadata agree at the fresh patch identity 0.2.6. This preparation
does not publish, install, deploy or restart anything; changed package bytes must
not replace the historical 0.2.5 identity.

构建输出 `dist/web/index.js` / `styles.css`，位于已有公开 asset 根。
模块只打包自身逻辑和布局样式，公共组件和主题由宿主提供；既有草稿编码不变。

前端入口要求 Web API v2、公共 UI v1、
`context.uiSurfaceVersion === 1` 与 `context.createPortal`，激活前缺少任一能力均拒绝。
模块包和后端 API 仍为 v1，后端行为没有随本次 Web 迁移改变。
前端 context/返回声明必须是 API v2；不能仅凭宿主版本号或后端 API v1 推断支持。
公共规则见宿主[模块 UI 指南](https://github.com/waksana/cockpit/blob/main/docs/module-ui-guide.md)。
Frontend types come from the published SDK `/frontend` entry, backend contracts from
`/backend`, and shared wire types from the root. Runtime-only constants use `/runtime`;
this module currently needs no runtime SDK import.
旧 Web 插口不保留兼容层，宿主与两个迁移模块须配套升级后冷启动；
不能先运行新宿主却期待旧模块前端继续兼容。CI 不执行安装、部署或重启。
已发行 0.1.6 的使用方法和兼容条件见其 tag 文档，不把本开发分支当成已发布资产。

After [v0.2.6 Release](https://github.com/waksana/cockpit-file/releases/tag/v0.2.6)
is published, download `cockpit-file-0.2.6.tgz` and
`cockpit-file-0.2.6.tgz.sha256`, then run
`sha256sum -c cockpit-file-0.2.6.tgz.sha256` before installation.
Before publication, an explicitly authorized joint deployment uses the unchanged
successful CI archive for the exact merged main commit. An older package is not
a substitute for this version, and a CI archive is not a published Release.
Source code ZIP/tar is not an installable module archive. Only source development needs the registry install and build steps below.

安装前了解[复制标签页与删除的已知限制](release-notes.md#known-limitation)：
本地删除资格不等于全局无引用，不要在一个标签页移除另一副本仍要发送或读取的附件。

## 1. 条件

- 与宿主一致的 Node **24.20.0**；本模块存储实现要求 Linux 与 `/proc/self/fd`。
  其他平台启动时明确报 `UNSUPPORTED_PLATFORM`；Windows 请按宿主 [WSL2 指南](https://github.com/waksana/cockpit/blob/main/docs/install.md#windows-wsl2) 在 WSL2 中运行。
- 源码构建使用 pnpm **10.34.5**；模块运行时无需 pnpm。
- 模块代码与宿主同进程，必须可信；原生数据和认证由宿主/Copilot 管理。
- 本次只支持本地 `.tgz` 安装，远程签名 URL 安装尚未实现。

## 2. Authenticate and build from the registry

### Worktree setup

A new checkout or worktree does not inherit ignored local files. When its
dependencies are needed and not already prepared, follow the authenticated,
frozen installation below in that worktree. Plain documentation edits do not
require installing dependencies. Keep each worktree's `node_modules` and
dependency graph independent; do not copy or symlink the whole directory from
another worktree or a running installation.

pnpm automatically reuses package files from its content-addressable store,
using hard links or clones on compatible filesystems rather than sharing the
mutable dependency directory. `pnpm store path` shows the selected store.
Cache misses may still download packages, and crossing filesystems may require
copies. Keep the existing store configuration and lockfile; no forced `--offline`
mode or global virtual store is needed. See [pnpm's store explanation](https://pnpm.io/10.x/faq).

### Registry authentication

The repository `.npmrc` sets only the `@waksana` registry. Configure authentication in
your user npm configuration (never commit it), using an environment placeholder:

```ini
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Provide `NODE_AUTH_TOKEN` through the environment. GitHub Packages requires authentication
even for public npm packages; a developer classic PAT needs `read:packages` and package access.
Never print tokens, pass them as command arguments, or copy a running installation's
dependencies, native home or credentials. CI uses `actions/setup-node` with
`registry-url: https://npm.pkg.github.com`, `NODE_AUTH_TOKEN: ${{ github.token }}` and
`packages: read`. The package must grant this consumer repository read access; a local PAT
install does not prove Actions access. Do not fall back to npmjs or a local tarball.

在 `cockpit-file` 仓库根执行：

```sh
pnpm install --frozen-lockfile --ignore-scripts &&
pnpm test &&
pnpm typecheck &&
pnpm build &&
pnpm package
```

默认输出为 `module-output/cockpit-file-<version>.tgz` 及其 `.sha256`（不表示已发布）。
Local builds are validation artifacts; an authorized joint deployment uses the
unchanged successful main CI archive for the exact accepted commit.

输出目录必须不存在，也可以 `pnpm package /absolute/new/output` 指定新目录。
打包要求干净的已提交源码；修改后先提交再重新 build，不能复用旧构建凭据。
包包含 manifest、编译后的 dist、LICENSE 和 `module-build.json` 来源清单；
`dist/licenses/lucide.txt` 保留固定 Lucide 1.46.0 的完整 ISC 及 Feather/MIT 来源声明，
运行时代码只包含实际使用的图标 SVG 节点，不包含整库/字体/CDN/React 依赖。
React 与 portal 渲染器由宿主注入，
Backend runtime code uses only Node standard libraries. SDK declarations, host code,
Zod, native implementations and development dependencies do not ship in the archive.
The build receipt records the SDK name, exact version, registry tarball URL and
SHA-512 integrity from the frozen lockfile and checks the installed package version.
TypeScript 5.9.3 uses NodeNext with full declaration checking; Node types 25 and React
types 19 match the SDK's supported ranges. Registry peer resolution may install React
in the development tree; that is not a runtime import or permission to bundle it.
正式 `.tgz` Release 的流程见[CI 与版本发行](releases.md)。

CI builds and verifies the archive **before** checking out the pinned integration host.
Only the real-host integration test needs host source: install that host's frozen
dependencies and run `apps/server/src/module-file.integration.test.ts` with
`COCKPIT_FILE_MODULE_ARCHIVE` pointing to the verified archive. Use isolated `HOME`,
`COPILOT_HOME`, `COCKPIT_HOME`, synthetic sessions and dynamically allocated loopback
ports, never a running production service or real native session.

## 3. 安装与启用

先校验下载/生成的包摘要，然后在 **Cockpit 包根**执行：

```sh
node --enable-source-maps apps/server/dist/module-cli.js install \
  /absolute/path/cockpit-file-<version>.tgz --trust-local-code --enable
```

该确认表示信任本地代码，不是密码、签名验证或安全沙箱。
安装器不会执行 package scripts，不自动运行 npm/pnpm，也不会启动或重启服务。

首次启动宿主：

```sh
node --enable-source-maps apps/server/dist/index.js
```

如果服务已经运行，需要在用户授权后让旧实例正常退出，再启动新实例。
安装/启用不会热加载；不要覆盖运行中的代码，也不要为安装清空会话或迁移原生数据。
也可只预安装并选中新版本，保留当前实例直到用户另行授权的正常退出。
此时 installed/selected 是新版本，active 仍是旧版本；不是已经上线。
安装前后使用同一真实 `COCKPIT_HOME` 查询并保留配置、包摘要与实例身份记录。
To revert only a next-start selection, run
`node --enable-source-maps apps/server/dist/module-cli.js enable cockpit-file --version <previous-version> --digest <previous-digest>`.
Preserve current configuration and other module selections; do not overwrite
the entire configuration with a historical copy.
本模块使用本体已有的 Copilot 认证，不增加文件模块账号或登录流程。

## 4. 数据根与配置

Cockpit 0.2.0 的 `COCKPIT_HOME` 默认是 `~/.cockpit`，只控制本体和模块内容。
自定义时传入非空绝对路径，安装 CLI 和服务必须使用同一宿主根。
Copilot 原生会话和认证使用自己的默认目录及配置，不受 `COCKPIT_HOME` 控制，
不需要为启用文件模块迁移、复制或链接原生目录。

```text
.cockpit/
  modules/config.json                 模块选择与参数
  modules/installed/cockpit-file/...   不可变模块代码
  modules/data/cockpit-file/
    files/<fileId>/
      identity.json
      state.json
      ready/
        body[.extension]
        metadata.json
    staging/
```

内部 JSON 格式不是用户编辑接口，不手工修改 ready/identity/state 文件。
配置只修改 `modules/config.json` 中已由 CLI 创建的
`selected["cockpit-file"].config`，保留 version/digest/enabled。
示例配置值：

```json
{
  "maxBytes": 104857600,
  "maxConcurrent": 4,
  "maxPending": 64,
  "maxActiveMessages": 32,
  "maxCandidateChars": 8192,
  "maxReferences": 256
}
```

| 参数 | 默认 | 允许范围 / 用途 |
| --- | --- | --- |
| maxBytes | 100 MiB | 1 byte–1 GiB，每次上传/复制的字节上限 |
| maxConcurrent | 4 | 1–128，实际存储操作并发 |
| maxPending | 64 | 1–4096，等待执行的模块文件操作 |
| maxActiveMessages | 32 | 1–1024，同时持有增量识别状态的消息 |
| maxCandidateChars | 8192 | 16–1048576，单个 Markdown 候选的字符上限 |
| maxReferences | 256 | 1–65536，每消息引用识别上限 |

这些上限不是越大越好；组合提高会增加内存和 I/O 压力。未知参数或无效值拒绝加载。
配置在下次宿主启动生效。卡片五秒预算不是上传或完整下载的全局超时。

**按已确认的使用范围，自动捕获可读取该服务用户能读取的所有本地普通文件。**
包括解析后的本地符号链接目标；不会抓取 HTTP/HTTPS URL 或读取目录。
这不是沙箱，请只使用可信 Agent/会话，并确保宿主远程入口已认证。
资源 GET 不会根据客户端传来的路径触发复制。

## 5. 查询、停用与更新

在 Cockpit 包根查询：

```sh
node --enable-source-maps apps/server/dist/module-cli.js \
  list --server http://127.0.0.1:8771
```

区分 installed、selected 和运行中的 active 状态；服务不可达会明确报告。
停用只影响下一次启动：

```sh
node --enable-source-maps apps/server/dist/module-cli.js disable cockpit-file
```

更新先生成新的模块版本包再安装；同版本不同摘要拒绝覆盖。
文件原件和绑定不随更新/停用删除，不回填模块未运行期间的旧消息。
首版无文件库删除管理、自动垃圾回收或数据迁移命令。

## 6. 接口与失败排查

模块 API base 由宿主提供，形式为 `/_modules/cockpit-file/<digest>/api`：

| 接口 | 用途 |
| --- | --- |
| POST /upload?name=…&operationId=… | application/octet-stream 上传；可带 x-file-mime 提示，实际类型由字节判断 |
| DELETE /uploads/:operationId | 明确丢弃独立上传；成功/重复成功 204，后续同操作上传 410，文件读取 404 |
| GET/HEAD /files/<fileId>/<bodyName> | 托管原件；bodyName 必须与实际原件一致 |
| GET/HEAD /messages/<encodedReference> | 按原生 session/message/引用绑定查找快照 |

变更请求必须携带宿主提供的 `x-cockpit-module-digest`；前端公共 request 自动添加。
媒体 GET/HEAD 依靠 URL 内的版本，可不带自定义 header。
`?download=1` 强制作为附件下载。部分内容请求支持标准单段 Range。

界面只对本页发起、尚未交给原生发送的上传在移除时尝试删除；发送过或从草稿恢复的附件保留原件。
这不是自动引用计数或文件库回收。删除不阻塞界面，失败会明确反馈；
未知外部操作占用返回 409，不自动接管，不能把浏览器缓存仍能显示当作服务器删除失败。

HEAD ready 返回 200 和类型/长度；已知工作进行中返回 202；
没有记录返回 404，前端在可能的事件先后差异下最多等待五秒。
捕获明确失败返回 422，完整性问题等存储错误返回相应错误，不永久假装 loading。

For a persisted missing-source failure, HEAD also returns
`X-File-Error-Code: SOURCE_NOT_FOUND`; the affected card explains that no snapshot
was saved, without reporting a module-wide runtime failure. Old failure records
remain terminal and are not migrated or recaptured. Other failures still use their
existing reporting paths. See [capture errors and module health](observation-and-loading.md#5-missing-sources-and-module-health)
for the distinction between a new failed capture and an old host error replayed
when the UI opens. Source changes do not alter the running installation or clear
its existing in-memory error.

遇到卡片失败，先区分旧消息未维护、源路径不存在、读取失败、大小上限和实际资源损坏。
卡片“重试”只重新检查已有资源，不重新发送 prompt 或补抓旧文件。
上传重试使用原操作身份；未确认结果不要换身份盲目重复创建。
诊断使用模块错误/宿主日志，不上传私人文件、令牌或真实对话全文。
