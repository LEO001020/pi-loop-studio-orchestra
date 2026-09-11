# candidate.3：依据可复现反例修正运行边界

此版本在独立 `pi-loop-studio` 目录延续重建。candidate.2 的已校验 ZIP 保留，未以新源码覆盖旧包或改写旧回执。candidate.3 的总状态以根目录 VERIFICATION.md、BLOCKED-UNVERIFIED.md 及 release/CLOSEOUT.json 为准。

## 先证明问题，再验证修复

`validation/runtime-boundaries-before-c3` 的四项新增测试全部失败。它们是原生命令、真实 Python 内核及明确标注的 Pi 模拟传输测试，不是对真实模型成绩的替代。

| 反例 | 原行为 | 修正 |
|---|---|---|
| Python 先写文件再超时 | 记为 failed，丢失 stdout 与未知副作用语义 | 已发送单元的中断／退出记 unknown，保留部分 stdout/stderr；未发送的启动失败仍是已知失败 |
| 单个 Pi 回包包含超时 Python、write、submit | 后续写入及结构化成功仍可能发生 | Pi 原生 beforeToolCall 阻止同批后续操作，shouldStopAfterTurn 阻止追加模型请求，宿主拒绝完成；无需看门狗 |
| CJS/ESM 项目缺失 express 依赖 | 从祖先目录的宿主 node_modules 借用而意外成功 | Node 原生同步模块解析 hook 将任务依赖限制为本工作树；npm 自身的执行依赖单独保留，不把它们暴露给业务 import |
| 构建生成 dist 后执行测试 | 新的可再生产物被误判为源码篡改 | 新增 UI 可调 generatedDirectories；仅新增且未分配交付所有权的构建文件作为生成物，哈希仍记录；原有文件及显式交付物仍完整核验 |

不把正在正常执行的其他岗位命令误判为未知：新的判定只看 `unknown`，不是 `running`，所以不会让并发子任务互相冻结。处理未知副作用必须明确查看回执；不能通过重置预算或重复点击继续把它自动消除。

新增 npm 反例不是只检查环境变量：两个不同工作树通过实际 npm lockfile/ci 安装不同版本的本地依赖，再各自运行测试；保留首轮 hook 误拦截 Node 测试子进程预加载的失败，修复后原有测试与新测试共同回归。

## 真实项目揭示的第五个问题

新验证项目不再是空目录生成零依赖函数，而是已有十个 TypeScript 源文件、固定原始测试、固定构建脚本、实际 Zod 依赖归档与锁文件的修复。原测试先实际失败，然后才提交给模型。构建采用 Node 原生 TypeScript 类型擦除，不是 tsc 类型检查。

真实侦查中，旧的 read 接口把 `vendor/zod.tgz` 压缩字节解码为乱码：一次预览超过两万字符，随后执行层达到工具轮数上限。没有把这当作“模型不够强”或提高轮数绕过：增加了只读的标准库归档入口。

`read_archive` 使用随附 Python 的 tarfile/zipfile 原生实现，列出成员或按精确成员名分页返回 UTF-8 源码和哈希，不落地解压、不执行归档、不跟随归档链接。普通 read 对归档和非 UTF-8 二进制返回明确错误，不再把乱码作为独立证据计数。实际图片仍交给 Pi 原生读取接口。

源码参考：Python 3.12 标准库 `tarfile.open/extractfile` 与 `ZipFile.open`，Node `module.registerHooks` 与 `TextDecoder`，以及安装的 Pi Agent beforeToolCall/shouldStopAfterTurn 类型定义。官方文档索引：https://docs.python.org/3.12/library/tarfile.html 、https://docs.python.org/3.12/library/zipfile.html 、https://nodejs.org/api/module.html 、https://nodejs.org/api/util.html 。在线文档小版本可能滚动，真实运行依据为本包 Node v24.21.0 / Python 3.12.10 与锁定源码及命令回执。

## 保留边界

另一项调度修正：收集侦查结果不等于每个侦查都成功。个别岗位的无效提交保留错误、不作为事实；成功报告仍须独立审核，规划者同时得到缺失清单。没有一份成功证据时不能继续；预算、用户暂停、取消和未知副作用始终保持其停止语义。此举删除“一个补充调查耗尽轮数则全部九份已完成报告不得使用”的全有或全无栅栏，不放宽原始任务验收。

Node 模块 hook 是依赖卫生，不是 OS 沙箱。原生命令可以主动改变环境，直接访问外部文件；Python 仍使用随附内核及共享基础库，不能宣称整个项目环境完全 hermetic。新归档读取只支持 bounded UTF-8 regular members，不支持 PDF/OCR、任意二进制语义解析、加密归档或恶意压缩炸弹的绝对安全保证。

新真实任务最初在加入归档工具前触及轮数限制，后续使用同一任务 ID 恢复已完成侦查，不重复派发已提交结果。其账单包含失败侦查与恢复成本；不能把完成后的记录宣传成单一源码版本从头无中断成功，也不能用这一样本推导总体成功率。

## 当前实测未决问题

真实新项目 ID 为 `808f88b6-9f9c-4425-bdd1-c727a39c25f1`。截至最后一次重试的回执（`validation/live-project-service-recovered-c3`），它停在独立侦查审核，尚无执行任务派发，累计已报告 8,457,751 token，51 次用量未知。这个结果不能签为新项目端到端通过，也不能把侦查并发等同于实际实现并发。

同一辅助模型的受控对照：仅 read 时，默认推理配置和 bounded-off 均实际完成“读取 → 结构化审核”；read + read_archive 也成功。完整工具集、read/ls/grep/find 组合与研究工具组合的探针分别出现连接错误或 HTTP 502。样本有限，不能据此确定是工具模式、数量、提供方协议转换还是网络状态导致；未擅自把它归因于外部网络，也没有降低原始验收标准或并发数。后续更细的诊断请求被平台拦截，未绕过重放。各探针原始回执仍保留。

因此，candidate.3 的代码／原生回归与可安装性可以独立验证，但新真实依赖项目的任务成功率仍为 BLOCKED。打包程序的 `--allow-blocked` 只允许把真实失败清单放入可安装包，不把失败改写为通过；最终 CLOSEOUT 状态与功能状态分别记录。
