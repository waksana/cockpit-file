# 下载、构建与安装

**cockpit-file 0.1.4** 需要固定 **Cockpit 0.2.0** 源码或兼容的后续运行包；
不能对已发布的 Cockpit v0.1.0 直接执行模块命令。

本次输入区配套调整已通过 [waksana/cockpit#7](https://github.com/waksana/cockpit/pull/7) 合入，
当前固定提交记录在 [`tooling/host-sdk.json`](../tooling/host-sdk.json)。
0.1.3 的相对产物路径支持依赖已合入的 [waksana/cockpit#15](https://github.com/waksana/cockpit/pull/15)
传递原生 `workspacePath`。旧宿主省略该上下文时，`files/...` 不猜测第二个目录是否存在。
不能直接配合缺少 rendersDraftAttachments 声明支持的旧宿主；
已发布版本使用对应 tag 的文档和构建基线。

普通安装从 [GitHub Releases](https://github.com/waksana/cockpit-file/releases)
下载同一版本的 `cockpit-file-X.Y.Z.tgz` 和 `.tgz.sha256`，
执行 `sha256sum -c cockpit-file-X.Y.Z.tgz.sha256` 后按下方安装步骤启用。
Source code ZIP/tar 不是模块安装包。只有源码开发需要执行 SDK 准备和构建步骤。

安装前了解[复制标签页与删除的已知限制](release-notes.md#known-limitation)：
本地删除资格不等于全局无引用，不要在一个标签页移除另一副本仍要发送或读取的附件。

## 1. 条件

- 与宿主一致的 Node **24.20.0**；本模块存储实现要求 Linux 与 `/proc/self/fd`。
- 源码构建使用 pnpm **10.34.5**；模块运行时无需 pnpm。
- 模块代码与宿主同进程，必须可信；原生数据和认证由宿主/Copilot 管理。
- 本次只支持本地 `.tgz` 安装，远程签名 URL 安装尚未实现。

## 2. 导出宿主 SDK 并构建模块

构建固定使用 `tooling/host-sdk.json` 中的宿主提交，不跟随 moving main。
在本仓库根准备独立源码目录（已经有该提交的干净 checkout 时可以跳过 clone）：

```sh
HOST_SHA="$(node --input-type=module -e "import { loadSdkPin } from './scripts/build-identity.mjs'; console.log((await loadSdkPin(process.cwd())).commit)")" &&
git clone --no-checkout --depth 1 https://github.com/waksana/cockpit.git .host-sdk-source &&
git -C .host-sdk-source fetch --no-tags --depth 1 origin "$HOST_SHA" &&
git -C .host-sdk-source switch --detach FETCH_HEAD &&
node scripts/sdk.mjs prepare .host-sdk-source
```

准备脚本核对宿主提交和版本，再调用其类型导出器，生成 `.cockpit-sdk` 及来源记录。
已有 SDK 仅在字节一致时复用；不一致会明确失败，不能混用类型。
也可 `pnpm sdk:prepare /absolute/clean/pinned/host-source` 使用已有的干净固定源码。
不要复制运行实例的 node_modules、原生 home 或凭据。

在 `cockpit-file` 仓库根执行：

```sh
pnpm install --frozen-lockfile --ignore-scripts &&
pnpm test &&
pnpm typecheck &&
pnpm build &&
pnpm package
```

默认输出：

```text
module-output/cockpit-file-0.1.4.tgz
module-output/cockpit-file-0.1.4.tgz.sha256
```

输出目录必须不存在，也可以 `pnpm package /absolute/new/output` 指定新目录。
打包要求干净的已提交源码；修改后先提交再重新 build，不能复用旧构建凭据。
包包含 manifest、编译后的 dist、LICENSE 和 `module-build.json` 来源清单；React 由宿主注入，
后端运行代码只使用 Node 标准库。`.cockpit-sdk` 和开发依赖不随模块包交付。
正式 `.tgz` Release 的流程见[CI 与版本发行](releases.md)。

## 3. 安装与启用

先校验下载/生成的包摘要，然后在 **Cockpit 包根**执行：

```sh
node --import ./apps/server/node_modules/tsx/dist/loader.mjs \
  apps/server/src/module-cli.ts install \
  /absolute/path/cockpit-file-0.1.4.tgz --trust-local-code --enable
```

该确认表示信任本地代码，不是密码、签名验证或安全沙箱。
安装器不会执行 package scripts，不自动运行 npm/pnpm，也不会启动或重启服务。

首次启动宿主：

```sh
node --import ./apps/server/node_modules/tsx/dist/loader.mjs apps/server/src/index.ts
```

如果服务已经运行，需要在用户授权后让旧实例正常退出，再启动新实例。
安装/启用不会热加载；不要覆盖运行中的代码，也不要为安装清空会话或迁移原生数据。
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
node --import ./apps/server/node_modules/tsx/dist/loader.mjs \
  apps/server/src/module-cli.ts list --server http://127.0.0.1:8771
```

区分 installed、selected 和运行中的 active 状态；服务不可达会明确报告。
停用只影响下一次启动：

```sh
node --import ./apps/server/node_modules/tsx/dist/loader.mjs \
  apps/server/src/module-cli.ts disable cockpit-file
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

遇到卡片失败，先区分旧消息未维护、源路径不存在、读取失败、大小上限和实际资源损坏。
卡片“重试”只重新检查已有资源，不重新发送 prompt 或补抓旧文件。
上传重试使用原操作身份；未确认结果不要换身份盲目重复创建。
诊断使用模块错误/宿主日志，不上传私人文件、令牌或真实对话全文。
