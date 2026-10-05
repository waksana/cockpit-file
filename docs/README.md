# Cockpit File 文档

**Current source supports both native and generic owner drafts through one File enhancement chain.**
Managed Markdown and static HTML files support isolated
[single-file document previews](document-preview.md), including opening in a new tab.
The module ships [default instructions](../src/instructions.md) asking agents to give files as Markdown links/images.
Source versions stay `0.0.0-dev`; changed bytes never replace an existing installed identity.
组件与浏览器离开保护见[前端接入契约](frontend-contract.md)。既有持久化草稿编码不变。

The frontend uses API v3, publicComponents v1, draftOwner v1, draftSubmission v2
and UI/shared-surfaces v1. Publication does not mean deployment.
The published SDK is pinned in `package.json` / `pnpm-lock.yaml`; the separate exact
integration host is in `tooling/host-integration.json` and the [installation guide](installation.md).
Neither SDK semver nor a successful build proves host capability or deployment.
可下载包以该 tag 的 Release workflow 成功发布的资产为准，发行不自动安装。
Package/backend API remains v1. Public prompt middleware now manages ordinary
local attachments; see [prompt ingestion](backend-design.md#prompt-ingestion).
远程安装、全局文件库和旧历史补抓不在当前实现中。
先看[构建与安装](installation.md)，再按主题了解当前契约。

## 1. 首版目标

让用户在 Cockpit 聊天中发送文件，让 Agent 照常用 Markdown 引用产物，
由文件模块保存文件并显示可预览、可下载的卡片。

首版不要求 Agent 学习额外的发送文件命令，也不重写 Copilot 消息格式。

### 用户发送

```text
选择 / 拖入 / 粘贴文件
  -> 当前草稿阻止发送，显示上传状态
  -> 文件模块流式接收并可靠保存
  -> 返回托管 URL 和原生附件描述
  -> 前端把 attachments 加入原草稿
  -> 全部就绪后，由本体一次发送 text + attachments
  -> 原生消息保存附件；前端将托管 path 映射成 URL，显示卡片
```

上传不自动发消息，发送和晚 ACK 由本体处理。文字和附件草稿仍属于浏览器，
文件字节存放在服务器模块数据目录，不塞进 sessionStorage。

### Agent 交付

```text
Agent 用原生工具生成文件，正常回复 Markdown
  -> 本体把已收到的新实时 SDK 通知交给模块
  -> 模块流式识别正文中的文件链接，首次发现即尝试复制
  -> 保存本条消息的不可变文件快照和引用绑定
  -> 前端独立识别 Markdown，按同一消息/引用算法生成 URL
  -> 卡片读取文件；准备中 loading，最多自动等待五秒
```

本体不修改原生正文，模块不建立聊天副本。前端渲染只读取资源，不触发捕获。

## 2. 已确认的决策

| 项目 | 首版决定 |
| --- | --- |
| 模块承载 | 受信任后端在主进程 import；首版冷加载，前后端同包，宿主统一端口 |
| 用户能力 | 聊天上传、拖拽/粘贴、附件草稿、文件卡片、支持类型的预览和下载 |
| 文件库 | 全局总览、汉堡菜单管理页、列表搜索和管理删除接口延后 |
| 原生附件 | 使用 SDK 已支持的 attachments，优先返回并发送服务器可读 file 路径 |
| 草稿字段 | 模块注册仅适用于 prompt 的附件 schema，拥有校验/actions/原生投影/ACK；本体基础草稿不内建附件 |
| Agent 协作 | 普通 Markdown 文件链接/图片，不强制调用上传 MCP 或输出私有标记 |
| 观察范围 | 只处理模块实际启用后的新实时输出；不为此增加历史轮询、加载或保活 |
| 历史 | 只读取已有快照，绝不补捕获；未捕获的旧文件引用失败，不做兼容 |
| delta | 原生 delta 是新增文本；采用每消息流式状态机，best effort 尽早发现引用 |
| 版本 | 同消息同引用首次成功快照固定；新消息引用同路径重新捕获 |
| 去重 | 同上传操作/同消息引用的幂等必须保留；首版不做跨文件内容哈希去重 |
| 摘要 | SHA-256 可随保存流计算作完整性信息，不用来合并不同文件记录 |
| 展示与等待 | 来源决定附件行/行内引用；HEAD 检查与用户显式打开的媒体预览分别有五秒预算，细节见[前端契约](frontend-contract.md) |
| 渲染协议 | 原生消息和共享 URL 算法即可，不增加宿主展示资源图或卡片 SSE |
| Lifecycle | Public shutdown v1 stops preparation and drains active work; normal processing persists every boundary |
| 来源范围 | 按用户确认，允许捕获服务用户可读的本地普通文件；HTTP 读取不能据任意路径创建捕获 |
| Size and preview | Configurable 100 MiB file default; native image/audio/video plus [bounded Markdown/static HTML](document-preview.md); other formats download without transcoding |
| 元数据 | 每文件 JSON 与原件原子提交，不使用数据库或内容去重对象池 |

## 3. 责任归属

| 参与者 | 拥有的责任 | 不承担的责任 |
| --- | --- | --- |
| Copilot | 原生 session、消息/历史、队列、工具执行、模型输入与上下文 | 浏览器文件库、卡片和托管下载 |
| Cockpit 本体 | state/实际组件/Markdown 注册、通用草稿与原生发送、原生身份与只读通知、资源释放 | 文件选择调度、文件类型规则、复制入库、文件版本表 |
| 文件模块 | 文件输入/选择器服务、文件字节与元数据、流式识别、引用绑定、URL 映射、上传和读取、文件组件 | 第二份聊天历史、隐式发送、原生配置开关镜像 |

目录归属不是安全沙箱。同进程模块和同用户原生工具具有实际进程/文件能力，
不能宣传为恶意模块隔离或所有 Agent 都无法更改托管文件的保证。

## 4. 按主题阅读

| 文档 | 唯一负责的主题 |
| --- | --- |
| [本地构建与安装](installation.md) | 实际构建、模块包、启用、配置、停用与发行兼容 |
| [前端接入契约](frontend-contract.md) | state 扩展、组件 middleware、Markdown 渲染、草稿与共享 UI |
| [首版后端设计](backend-design.md) | 本体后端插口、文件模块业务、最小 HTTP 能力和原生事件接线 |
| [文件引用与地址](file-references.md) | 原生附件、助手 Markdown、消息身份、path/URL 映射和文件版本 |
| [存储与生命周期](storage-and-lifecycle.md) | 无内容去重的存储、幂等提交、异常恢复、保留与关闭边界 |
| [消息观察与加载](observation-and-loading.md) | 现有通知链路、流式状态机、复杂度、五秒等待和重新请求 |
| [端到端验收](acceptance.md) | 前后端与宿主配合的验收矩阵，不是已经通过的测试报告 |
| [Roadmap](roadmap.md) | 明确延后的能力，不作为首版完成条件 |
| [CI 与版本发行](releases.md) | PR 门禁、SDK pin、固定来源构建及 `.tgz` Release |
| [本次发行说明](release-notes.md) | 当前版本的发布输入，已发布说明由 GitHub Releases 承载 |

维护时只在对应主题中修改细节；这里保留范围和索引，不复制所有 schema。

## 5. 当前源码依据

Builds use the exact published `@waksana/cockpit-module-sdk@0.17.0`, without generated
host declarations or a host checkout. It supplies Web API v3 state, component middleware
and Markdown contracts; package/backend API v1 and runtime capability checks remain.
原生 SDK 1.0.13、bundled runtime 1.0.83 / protocol 3 不因本次 Web 迁移改变。
详细代码接点写在前后端主题文档中；这里不以旧文件系统或旧 CI 作为本次实现完成证据。

相关宿主文档：
[模块设计](https://github.com/waksana/cockpit/blob/main/docs/module-contract-draft.md)、
[产品边界](https://github.com/waksana/cockpit/blob/main/docs/product-requirements.md)。
The public ABI is defined by the SDK's common, `/backend`, `/frontend` and `/runtime`
entries, owned by Cockpit `packages/module-api`; this repository does not copy declarations.
未合入/发布的源码不能当成已经上线的服务或可下载 Release。

## 6. 当前具体选择与限制

| 项目 | 当前实现 |
| --- | --- |
| Registration | Backend activate v1; Web activate v3 registers state services/draft schema, public component middleware and Markdown renderers |
| 新输出 | 已加载会话的新 ephemeral start/delta 建立扫描状态；无新流的旧完整事件不捕获 |
| 引用 | 行内 Markdown link/image；相对路径、绝对路径、本地 file URL；未知 cwd 的相对引用失败 |
| 限制 | 有界扫描/引用数/工作队列/上传大小；数值和配置入口见安装文档 |
| 预览 | 按字节识别的图片/视频/音频；SVG 使用受限图片模式，HTML/PDF 不内嵌 |
| 读取 | HEAD 有界探测，202/404 在总五秒内重试；ready 后不自动下载媒体，点击预览才读取原 URL |
| 存储 | files/<id>/ready/body[.extension] 与 JSON；URL 保留 body 文件名，实现纯函数互逆 |
| 平台 | Node 24.20.0，Linux；依赖 /proc/self/fd 固定读取句柄，没有不安全的其他平台 fallback；其他平台报 `UNSUPPORTED_PLATFORM`，Windows 用 [WSL2](https://github.com/waksana/cockpit/blob/main/docs/install.md#windows-wsl2) |
| Markdown 边界 | 流式 best effort，不是完整 CommonMark；引用式定义等复杂形式目前不自动捕获 |

## 7. 开发与后续

使用仓库已有 `test`、`typecheck`、`build`、`package` 命令。
场景和数据必须合成；不要向真实会话发实验消息，不读取真实用户文件作为测试输入。
打包不包含开发依赖、SDK 类型副本或测试；安装不执行脚本或临时下载运行依赖。

后续功能只按 [Roadmap](roadmap.md) 推进，不在首版中悄悄恢复文件库或历史补抓。
