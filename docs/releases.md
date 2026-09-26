# CI 与版本发行

本仓库的 Release 是可供 Cockpit 本地安装的模块包，不是 npm 包或源码 ZIP。

每个 `vX.Y.Z` Release 发布两项：

```text
cockpit-file-X.Y.Z.tgz
cockpit-file-X.Y.Z.tgz.sha256
```

`.tgz` 包含 `cockpit.module.json`、编译后的 `dist/`、LICENSE 和
`module-build.json`. It records the module source SHA, SDK package name/version,
registry URL, resolved tarball and SHA-512 integrity, Node/platform and file inventory;
不包含用户数据。校验文件检测完整性，不是独立发布者签名。

## 检查链

PR、main push 和 Release 共用 `CI / Required checks`：

```text
固定文件仓库 SHA
 -> authenticated GitHub Packages frozen-lockfile install (no host checkout)
 -> typecheck + tests
 -> build + 构建凭据
 -> 从同一干净提交打包
 -> 检查归档、摘要、来源和 SDK
 -> checkout the exact tooling/host-integration.json host
 -> 用固定宿主实际安装并运行模块集成用例
 -> 保存该次原始 artifact
```

检查使用只读权限、合成文件和会话事件，不需要生产凭据，不启动真实模型。
Actions 固定完整提交 SHA；开发 artifact 保留 7 天，正式 Release 资产独立保留。
SDK version/integrity and host compatibility are separate inputs. CI uses the repository
`GITHUB_TOKEN` with `packages: read` and must prove real package access; local developer
credentials are not a substitute. The host pin is only for integration tests, never SDK
generation or module builds. Release verification installs frozen dependencies to parse
the same lockfile but does not rebuild the downloaded artifact.

The current source assigns File 0.2.6 to the compatible capture-error fix. Preserve
the original successful main CI archive for any separately authorized joint
deployment; do not publish changed bytes under the existing 0.2.5 identity.
Version preparation and merge are not publication or deployment.

## 发行步骤

1. 通过 PR 同时修改 package.json、cockpit.module.json 的版本及本次 release-notes.md。
2. 合入 main，确认该提交的 Required checks 成功。
3. 创建指向该完整 SHA 的 `vX.Y.Z` tag 并推送。
4. Release workflow 在该 tag 上复用同一检查，下载同次已验证 artifact。
5. 发布前再次核对 tag/version/来源/SDK/Node/文件摘要，以及远端 tag 仍指向同一提交。
6. 把原始 `.tgz` 和 checksum 暂存到 draft，重新下载并复验远端资产；仅在两项资产
   完整且身份一致后，将 draft 一次性转成正式、非 prerelease 的 Latest Release。
   publish job 不重新构建。

版本 tag 不允许更新或删除。已发布资产不自动覆盖；源代码修复应使用新版本。
本次配置不自动创建首个 tag 或 Release，也不合并 Cockpit 本体的 PR。

After a joint deployment with the host, tag and release the accepted commit per Cockpit's [release after a joint deployment](https://github.com/waksana/cockpit/blob/main/docs/releasing.md#release-after-acceptance) policy.

## 本地构建与来源

普通 dirty-tree build 可以开发，但不能作为发行包来源。
`pnpm build` 记录 `.module-build.json`；`pnpm package` 要求源码干净且已提交，
build receipt 与当前源码、SDK 和 dist 文件一致。提交后必须重新构建。
不要手写 build receipt 绕过门禁。

## 发布失败与重跑

网络错误或取消后，先查询 GitHub 上的 tag、Release/draft 和资产状态。
已有 Release 的重跑不会自动覆盖；不要移动 tag、盲删 Release 或使用 clobber。
确认不一致时停下并查明原因，不能把“调用报错”当成“远端肯定没有发布”。
此流程不承诺自动处理所有部分失败，也不执行部署、重启或用户数据迁移。

<a id="atomic-release-publication"></a>
正式、非 draft、非 prerelease 且资产完整的 Release 才是发布就绪信号。workflow
在远端资产回读和复验前保持 draft；部分上传或失败的 draft 留作诊断，不得被自动
删除或覆盖。创建、上传、转正式或最终回读出现失败/未知结果时，先读取远端真实状态，
不得盲目重跑变更请求。
