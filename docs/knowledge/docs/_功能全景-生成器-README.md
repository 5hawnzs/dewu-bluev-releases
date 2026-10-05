# docs/visual —— 项目功能全景（可重新生成的可视化文档）

打开 `index.html` 就是一份**随代码一起更新**的功能全景图：六段流水线、功能地图、代码结构、
接口面与权限门禁、两条发布通道、质量护栏、版本线、红线清单。

它不是手写的一次性文档 —— **数字全部由 `build.js` 从工程里读出来**，改完代码重跑一次就同步了。

## 怎么更新

```bash
node docs/visual/build.js                 # 重新生成（版本号 / 页签 / IPC 通道 / 行数 / 版本线全部重读）
node docs/visual/build.js --run           # 先真跑一遍 tools/run-all.js 取回逐套断言数，再生成（约 6 分钟）
node docs/visual/build.js --snapshot <run-all 的输出.txt>
                                          # 用已保存的回归输出里的数字，不重跑
```

产物两个：

| 文件 | 说明 |
| --- | --- |
| `index.html` | 单文件文档（CSS 内联、无外链、无 CDN），双击就能看，也能直接发出去 |
| `data.json` | 本次生成读到的结构化数据快照，便于 `git diff` 看出「这次变了什么」 |

`regression.json`：最后一次**已核实**的回归记录（逐套断言数 + 时间 + 出处）。
不带任何参数跑 `build.js` 时就用它；想让它变成真实时数据，就用 `--run` 或 `--snapshot`。

## 数字从哪来（哪些是自动读的）

| 区块 | 来源 |
| --- | --- |
| 版本 / 依赖 / 打包目标 / 更新源 | `package.json` |
| 功能页签（数量、分组、是否仅管理员） | `src/renderer/index.html` 的侧栏导航 |
| IPC 通道清单与门禁档位 | `src/main/ipc.js`（按 `guard` / `guardAdmin` / 无包裹自动判定） |
| 代码行数与分层 | 递归扫 `src/**/*.{js,html,css}` |
| 回归套件清单与「一套测什么」 | `tools/run-all.js` 的 `SUITES` 与文件头注释 |
| 逐套断言数 | `--run` 实跑 / `--snapshot` 快照 / `regression.json` 已核实记录 |
| 版本线 | `git log` 里带版本号的发版提交 |
| 内置依赖的体积与文件 | `vendor/adb`、`vendor/adbkeyboard`、`vendor/ffmpeg` 实际文件 |

**读不到的写「—」，不编数字**（与仓库的一致性要求同一条：未知 ≠ 0）。

## 哪些是人工维护的

`build.js` 顶部的四个常量：`PIPELINE`（六段流水线的口径与产物）、`PAGES`（页面职责与按钮）、
`REDLINES`（绝不许破的约束）、`UPDATE`（更新与发版口径）、`CHANNEL`（真实/模拟通道对照）。
这些的出处是 `README.md`、`AGENTS.md`、`docs/HANDOFF.md` —— 改口径时**先改文档，再改这里**。

## 只读承诺

生成器只读工程（除了自己的 `index.html` / `data.json`），**不碰 `src/`、不碰配置、不写任何既有文件**，
也不会去连设备或模拟器。`--run` 只是调用仓库自己的 `tools/run-all.js`。
