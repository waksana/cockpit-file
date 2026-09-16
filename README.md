# Cockpit File

**在 Cockpit 中上传、分享和查看文件。**

Cockpit File 是 [Cockpit](https://github.com/waksana/cockpit) 的文件模块。
目标是在聊天中提供一致的文件体验，让 Agent 正常工作，让用户直接获得可查看、可下载的文件。

## 首版范围

- **聊天附件**：选择、拖入或粘贴文件，准备好后随文字一起发送。
- **文件卡片**：在聊天中查看图片、预览支持的媒体或下载原件。
- **消息中的文件版本**：同一路径的文件修改后再次交付，旧消息仍保留原来保存的版本。

全局文件库和汉堡菜单中的管理页面列入 [Roadmap](docs/roadmap.md)，不在首版实现。

Agent 可以照常使用 Markdown 引用文件，不需要学习额外的发送文件命令。
本模块不替代 Copilot 的会话与历史管理，也不是服务器项目文件编辑器。
只维护模块启用后新上传和新回复中捕获的文件，不扫描或补存旧聊天文件。

## 当前状态

**当前开发版本为 0.1.4，已发布版本为 0.1.3。**
需要支持 Module API v1 的 Cockpit 0.2.0；已发布的 Cockpit v0.1.0 不支持此模块。
需要已合入的 [waksana/cockpit#7](https://github.com/waksana/cockpit/pull/7) 输入区配套调整；
准确的构建基线见[安装指南](docs/installation.md)。
0.1.3 的原生产物目录接入需要已合入的 [waksana/cockpit#15](https://github.com/waksana/cockpit/pull/15)；
不提示 Agent 修改输出，也不由模块猜测 Copilot 数据根。

从 [Releases](https://github.com/waksana/cockpit-file/releases) 下载 `.tgz` 模块安装包和校验文件，
按[下载与安装](docs/installation.md)使用，或从[完整文档](docs/README.md)了解流程、分工和限制。
复制标签页后的附件共享与删除存在[已知限制](docs/release-notes.md#known-limitation)，尚未实现全局引用保护。

## 参与讨论

欢迎通过 [Issues](https://github.com/waksana/cockpit-file/issues)讨论使用体验和实现方案。
示例请使用合成文件，不提交真实聊天记录、账号凭据或私人文件。
参与修改请阅读[贡献指南](CONTRIBUTING.md)；安全问题通过[私密渠道](SECURITY.md)报告。

本项目使用 [GPL-3.0-only](LICENSE)。
