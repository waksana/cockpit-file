# Cockpit File

**在 Cockpit 中上传、分享和查看文件。**

Cockpit File 是 [Cockpit](https://github.com/waksana/cockpit) 的文件模块。
目标是在聊天中提供一致的文件体验，让 Agent 正常工作，让用户直接获得可查看、可下载的文件。

## 首版范围

- **聊天附件**：选择、拖入或粘贴文件，准备好后随文字一起发送。
- **文件展示**：附件使用紧凑单行，Markdown 引用随正文折行，点击查看媒体或下载原件。
- **消息中的文件版本**：同一路径的文件修改后再次交付，旧消息仍保留原来保存的版本。

全局文件库和汉堡菜单中的管理页面列入 [Roadmap](docs/roadmap.md)，不在首版实现。

Agent 可以照常使用 Markdown 引用文件，不需要学习额外的发送文件命令。
本模块不替代 Copilot 的会话与历史管理，也不是服务器项目文件编辑器。
只维护模块启用后新上传和新回复中捕获的文件，不扫描或补存旧聊天文件。

## 当前状态

**当前准备版本为 0.1.9，要求独立 `uiSurfaceVersion: 1` 的配套宿主源码。**
精确支持 SHA 与新增公共样式见[安装指南](docs/installation.md)，不能仅凭 UI v1 或版本号推断。
尚未声明发布；已发布 0.1.7 安装包仍以原 tag 的 Release 资产为准。
Web 层采用注册 state 服务、
组件 middleware 和独立 Markdown link/image 渲染器；后端行为不变。
附件属于文件模块注册的草稿 schema，完整草稿文件列表也由模块提供。
基础草稿没有附件字段；扩展不可用时不参与发送，也不由本体补文件兜底 UI。
原生问答使用独立草稿，普通 prompt 草稿及其文件保留，问题结束后恢复。
需要配套宿主的 Web API v2、公共 UI v1 与 `context.createPortal`；
旧 Web 插口不保留兼容层，不能只看宿主包版本号或后端 API v1 推断兼容。
准确构建基线见 [`tooling/host-sdk.json`](tooling/host-sdk.json) 和[安装指南](docs/installation.md)。
公共样式、图标和兼容规则以宿主
[模块 UI 开发指南](https://github.com/waksana/cockpit/blob/main/docs/module-ui-guide.md) 为唯一权威。
宿主与模块需要配套发行和冷启动；合并源码或发布资产不代表安装、部署或重启授权。
已发行 0.1.6 的兼容条件与行为以其 tag 文档为准，不能用旧包代替这次 Web 接入迁移。
原生产物目录仍来自宿主已有的 SDK 上下文，不提示 Agent 修改输出，也不猜测 Copilot 数据根。

从 [Releases](https://github.com/waksana/cockpit-file/releases) 下载 `.tgz` 模块安装包和校验文件，
按[下载与安装](docs/installation.md)使用，或从[完整文档](docs/README.md)了解流程、分工和限制。
复制标签页后的附件共享与删除存在[已知限制](docs/release-notes.md#known-limitation)，尚未实现全局引用保护。

## 参与讨论

欢迎通过 [Issues](https://github.com/waksana/cockpit-file/issues)讨论使用体验和实现方案。
示例请使用合成文件，不提交真实聊天记录、账号凭据或私人文件。
参与修改请阅读[贡献指南](CONTRIBUTING.md)；安全问题通过[私密渠道](SECURITY.md)报告。

本项目使用 [GPL-3.0-only](LICENSE)。
