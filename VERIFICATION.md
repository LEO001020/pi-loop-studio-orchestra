# 最终验收

状态：**BLOCKED_FINAL_ACCEPTANCE**

完成时间：2026-09-11T06:31:56.364Z

| 项目 | 结果 | 退出码 | 类型 | 回执 |
|---|---|---:|---|---|
| build | PASS | 0 | 原生命令 / 确定性测试 | validation/acceptance-1789108164580/build/command.json |
| regression | PASS | 0 | 原生命令 / 确定性测试 | validation/acceptance-1789108164580/regression/command.json |
| foundations | PASS | 0 | 原生命令 / 确定性测试 | validation/acceptance-1789108164580/foundations/command.json |
| dependency-isolation | PASS | 0 | 原生命令 / 确定性测试 | validation/acceptance-1789108164580/dependency-isolation/command.json |
| launch | PASS | 0 | 原生命令 / 确定性测试 | validation/acceptance-1789108164580/launch/command.json |
| budget-live | FAIL | 1 | 真实模型 | validation/acceptance-1789108164580/budget-live/command.json |
| ui | PASS | 0 | 真实模型 | validation/acceptance-1789108164580/ui/command.json |
| restart | PASS | 0 | 原生命令 / 确定性测试 | validation/acceptance-1789108164580/restart/command.json |

## 真实任务

主验收：

```json
{
  "id": "3230e182-be8d-4815-8e67-e3ab76742564",
  "status": "completed",
  "created": "2026-09-10T23:15:22.425Z",
  "updated": "2026-09-11T00:05:33.393Z",
  "spent": 4205068,
  "budget": 20000000,
  "requests": 428,
  "roles": {
    "principal": {
      "calls": 13,
      "tokens": 396728,
      "unknown": 0
    },
    "executor": {
      "calls": 286,
      "tokens": 2621256,
      "unknown": 0
    },
    "auxiliary": {
      "calls": 129,
      "tokens": 1187084,
      "unknown": 0
    }
  },
  "unknown": 0,
  "executorPeak": 12,
  "executionOnlyPeak": 11,
  "jobs": 12,
  "integrated": 12,
  "workspace": "D:\\Code\\pi-loop-studio\\workspace\\live-acceptance-1d789289-52ab-4bd6-826f-d91bef2baaca",
  "publication": "completed",
  "independentTestSummary": "array throws RangeError (0.5327ms)\n✔ non-array inputs throw TypeError (0.1828ms)\n✔ non-number and non-finite elements throw TypeError (0.223ms)\n✔ sparse arrays with holes throw TypeError (0.2616ms)\n✔ immutability and frozen array support (0.5313ms)\nℹ tests 106\nℹ suites 0\nℹ pass 106\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 402.9924\n"
}
```

最终源码回归：

```json
{
  "id": "808f88b6-9f9c-4425-bdd1-c727a39c25f1",
  "status": "blocked",
  "created": "2026-09-11T05:33:30.724Z",
  "updated": "2026-09-11T06:15:24.505Z",
  "spent": 8457751,
  "budget": 30000000,
  "requests": 610,
  "roles": {
    "principal": {
      "calls": 8,
      "tokens": 37438,
      "unknown": 1
    },
    "executor": {
      "calls": 503,
      "tokens": 8214572,
      "unknown": 0
    },
    "auxiliary": {
      "calls": 99,
      "tokens": 205741,
      "unknown": 50
    }
  },
  "unknown": 51,
  "executorPeak": 12,
  "executionOnlyPeak": 0,
  "jobs": 0,
  "integrated": 0,
  "workspace": "D:\\Code\\pi-loop-studio\\workspace\\validator-project-2c2ae471-3ebd-4be0-aecf-659249694710",
  "independentTestSummary": "t Test.postRun (node:internal/test_runner/test:1542:19)\n      at Test.run (node:internal/test_runner/test:1467:12)\n      at async Test.processPendingSubtests (node:internal/test_runner/test:974:7) {\n    generatedMessage: false,\n    code: 'ERR_ASSERTION',\n    actual: undefined,\n    expected: undefined,\n    operator: 'throws',\n    diff: 'simple'\n  }\n",
  "originalAcceptanceFilesUnchanged": true,
  "buildValidation": "Native Node TypeScript erasure + runtime tests; NOT tsc type checking",
  "generatedArtifacts": []
}
```

完整命令、stdout、stderr、退出码、环境与源码 SHA256 见 docs/verification/acceptance.json 与 final-harness。确定性测试中的模拟模型不计入真实模型请求。历史失败仍保存在 validation。便携安装另见 docs/verification/portable/receipt.json。此状态不证明长期稳定性、总体成功率或用户满意度。
