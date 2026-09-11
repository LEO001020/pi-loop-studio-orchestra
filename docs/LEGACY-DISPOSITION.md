# 历史资产对账与处置

本轮初始对账见 `validation/reconciliation/disk.json`、`reference-failures.json`、`validation/bootstrap.json`。磁盘旧 package.json 实为 rc.7，不能将续接文字的 rc.5 当作当前磁盘版本。

保留：私有 Node v24.21.0 原始二进制，SHA-256 `af1f433c29c1515b083b736a05d22d6f999aa0bb139452d8d5ca63db1f0a4b01`；Python 3.12.10 安装与 venv；pi-repl-py 的 Jupyter/stdio 桥机制和许可证；三席位矩阵；E/G 盘配置别名与真实读写能力。Python 修复使用 UTF-8、正确的 connection_file 与内核入口，且重建迁移后的入口脚本。

不移植：Pi Web 前端、预算预留与角色冻结、AppContainer 胶水、看门狗、CDP 注入、标签页自愈、双系统互斥、旧内存 session host、路径双白名单，以及它们衍生的恢复链。

旧 `pi-agent-loop/validation`、ADR-001—015 与 `chatgpt-coding-workspace` 保持原位只读。历史证据是已探索地图，不作为新实现验收。旧 30K executor 校准值不再充当预留：预算已无预留机制。

独立参考 `pi-loop-v2` 已有 Pi、XState、assistant-ui 实现，但真实任务暂停于预算且存在重复编排、恢复 Promise、UI 时序等问题。本轮选择性复用其源码而非重新实现成熟能力，所有继承行为重新审查；参考目录未作为最终交付。新代码和运行时均位于 `pi-loop-studio`，不依赖从旧目录启动。

coding MCP、18766 端口、8045 代理及其他 agent 的量化/RAG 项目不属于本轮重建范围，没有把它们纳入新应用运行生命周期。
