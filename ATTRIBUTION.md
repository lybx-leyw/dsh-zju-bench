# 第三方来源

本文件记录本仓库参考或移植的**第三方**项目与素材，是这类说明的唯一索引。作者自有项目（`zhiyun-pro`、`zju-mcp` 等）之间的搬迁属于同一作者，不在此列。

参考任何外部项目之前先确认对方的协议，参考之后必须在本文件追加说明；细节见 [CONTRIBUTING.md 第 3.3 节](docs/contributing/CONTRIBUTING.md#33-参考其他项目前先确认协议)。

本仓库自身未附 LICENSE（`package.json` 为 `private: true`）。这不改变第三方项目自身协议的约束力。

## 仅参考，未引入实现

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) · MIT · 参考提交 `5badb15009ae1756c3afe0ae0cef1faafc290ccc`。本项目的运行宿主：阅读其源码与文档以了解 Cordis 插件写法、宿主 API 与客户端启动图谱（种子词表等常量对照自其源码），未复制其实现；运行时以 npm 依赖形式引入。
- [DSH Codex UI](https://github.com/MichengAI/dsh-codex-ui) · Apache-2.0 · 参考提交 `ff42c6f9296ee7022ab2e919f849ecd05d4df63e`。参考其 manifest、浏览器 factory 装配、插槽所有权与宿主验证方式。没有引入该插件的业务或界面实现。

## 含实现移植

暂无。今后若有插件包移植了第三方实现，移植说明写在该包内的 `ATTRIBUTION.md`，并在本文件指向它。
