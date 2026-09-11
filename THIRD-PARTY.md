# 第三方组件与许可证

本项目新增源码采用根 LICENSE 的 MIT 条款；该条款不替代随附组件自己的许可证。JavaScript 实际版本由 package-lock.json 锁定，直接依赖的许可证与版本清单由发布脚本写入 docs/verification/dependencies.json；各包的完整许可证保留在 node_modules 内。

核心采用 @earendil-works/pi-agent-core / pi-ai / pi-coding-agent、assistant-ui、XState、React、React Flow、Express、TypeBox、Zod、Mozilla Readability、linkedom、diff 与 Lucide。pi-subagents、LangGraph、Temporal、Open WebUI、LibreChat、LobeChat 是审查的替代/参考项目，不应被误列为本应用实际运行依赖。

vendor/pi-repl-py 保留其原许可证。Python 安装包含其 LICENSE 与已安装包的 dist-info 许可证。Git for Windows/MinGit 是单独随附的第三方运行时，保留其原有许可文件和 RUNTIME-PROVENANCE.json；其源代码来自 Git for Windows 的同版本公开发布，不能把整个便携包概括为单一 MIT 授权。私有 Node 来自用户保留的 v24.21.0 构建，保留对应上游 LICENSE 与二进制哈希；本轮没有再次编译。

发布清单与压缩包明确排除有效凭据和私人会话。公开研究文本仅用作本机工程审计，不代表本项目重新许可原论文。对外再分发时应依照各第三方原始条款，而不是仅依赖本文摘要。
