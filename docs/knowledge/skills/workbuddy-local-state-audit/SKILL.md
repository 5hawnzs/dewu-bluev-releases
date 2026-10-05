---
name: workbuddy-local-state-audit
description: 只读查 WorkBuddy 桌面端的本地状态（定时任务是否推微信、会话权限档位、渠道连接、崩溃记录），并把「用户到底该点哪个开关」对上官方文档。当用户说「XX 能不能推到手机」「任务为什么卡在等确认」「定时任务怎么没通知我」「我这条会话是什么权限」「这是不是要我自己点」这类关于客户端自身行为的问题时使用——避免张口就答「做不到」。
agent_created: true
---

# WorkBuddy 本地状态取证（只读）

用户问「能不能推到手机 / 为什么卡在等我点确认」时，**不要凭记忆答**。
客户端的真实状态（谁是开、谁是关）全都落在 `~/.workbuddy/workbuddy.db` 里，**一条只读查询就能给出数字**。

## 0. 一句话结论（先记这两条，2026-10-01 实测）

- **自动化结果 → 手机**：`automations.push_to_wechat`（**逐条**开关）。默认 0，**没人帮你开**。
- **卡在等确认 → 手机批准**：官方「多端协同（连接电脑）」**明确支持**——
  「任务完成、**等待回答、等待审批**时通过**微信订阅通知**提醒您，**点击直达处理**」。
- ⇒ 所以「人不在电脑前就干等」**不是产品限制，是开关没开**。

## 1. 数据在哪（表/列速查）

| 想知道 | 位置 |
|---|---|
| 定时任务是否推微信 | `automations.push_to_wechat`（0/1）、`status`、`rrule`、`deleted_at` |
| 定时任务运行历史 | `automation_runs` / `automation_runtime_state`（`next_run_at`、`last_run_at`） |
| 会话权限档位 | `sessions.permission_mode`（实测值：`bypassPermissions` 或 `null`） |
| 会话属于哪个工作区 | `sessions.cwd`（**别从 `projects/<目录名>` 反推**，`-` 同时代表 `:` 和 `\`） |
| 模型 / 专家 / 沙箱 | `sessions.model` / `expert_id` / `use_sandbox_cli` |
| 微信渠道是否启用 | `~/.workbuddy/settings.json` → `claw.channels.wechatmp`、`claw.users.<uid>.channels.wechatmp.artifactUploadEnabled` |
| 多端协同开关（允许移动端连接 / 允许锁屏运行） | ★ **本地无可靠落点**（2026-10-01 实测：`settings.json` 顶层只有 `claw`、`enabledPlugins`；`user-state.json`/`local_storage` 查不到）⇒ **别猜，让用户看界面** |
| 客户端版本 | `<安装目录>/resources/install-manifest.json` → `appVersion` |
| 崩溃 | `~/.workbuddy/logs/Crash-Log/`（见技能 `workbuddy-crash-report-submit`） |

## 2. 固定的只读查法

Node 22 **自带 `node:sqlite`**（实验特性，会打 `ExperimentalWarning`，无害）。
必须：**用托管 Node 全路径** + **`{ readOnly: true }`** + **在同一条命令里 `export PATH`**。

```bash
export PATH="/usr/bin:/bin:$PATH"
NODE="C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2/node.exe"
"$NODE" -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('C:/Users/Administrator/.workbuddy/workbuddy.db', { readOnly: true });
console.table(db.prepare('select name,status,push_to_wechat,rrule from automations where deleted_at is null').all());
" 2>&1 | grep -v ExperimentalWarning | grep -v trace-warnings
```

- **别写库**：库有 `-wal`/`-shm`，客户端正开着；工具（`automation_update` 等）才是改动的正规通道。
- 输出很长就 `| head -40`；`console.table` 比逐行 `console.log` 好读。

## 3. 权限档位与「该点哪里」

- `sessions.permission_mode`：`bypassPermissions` = 已关掉二次确认（≈ 界面「允许完全访问」）；
  `null` = 没记录（**不等于「默认权限」**，别当成 0 用）。
- 界面位置（**都要用户在界面上点，我改不了**）：
  - **允许完全访问**：输入框**底部**权限按钮 → 「允许完全访问」开关。**全局**（当前客户端所有任务）、**不跨设备**。
  - **安全中心**（更推荐，细粒度）：**文件安全**（按路径，读/写/删 三态 允许/询问/拒绝）、
    **命令安全**（按**命令前缀** 允许/询问/禁止）、**网络安全**、删除保护（进回收站）、
    **批量删除审批（默认 50）**、自动修改前备份。
  - **定时任务推微信**：任务本身的推送开关。★ `automation_update` **没有这个参数**、
    `mode=view` 也不返回该字段 ⇒ **必须界面点**（先只读查一遍，告出「N 条里 0 条已开」）。
- 降低弹窗的**另一半在自己身上**：别顺手 `rm -rf` 收尾（「中风险」拦截多由它触发）；
  要删就先出清单等用户批；长任务拆成「每段都有可读产出」，别让结果锁死在最后一步。

## 4. 手机侧两条链路的官方事实

- 文档：<https://www.codebuddy.cn/docs/workbuddymini/features/Multidevice>（多端协同 · 连接电脑）
- 能力：远程续聊（小程序发指令 → 桌面端执行）、**远程停止**、状态可视化（含「等待输入」）、
  **任务通知（完成 / 等待回答 / 等待审批 → 微信订阅通知 → 点击直达处理）**、远程配置（权限/模型/技能以电脑端为准）。
- ★ **通知规则精读**（2026-10-01 官方原文，决定「到底收不收得到」）：
  - **「任务完成」只推小程序端发起的任务**（电脑端发起的由电脑自行通知，不重复打扰）；
    但 **「等待回答」「等待审批」无论谁发起都推** ⇒ 用户抱怨的「卡在等我在电脑上点确认」属于后者，**能收到**。
  - **「等待审批」= Agent 申请敏感操作权限** ⇒ 含**「是否在沙箱外执行」这类确认弹窗**，不只是工具授权。
  - 点通知**直达对应面板**：「等待类会直接拉起对应的问答或审批面板」；若已在电脑端处理完，提示「该请求已处理」。
  - ★★ **微信订阅通知「一次授权只能推送一次」**：小程序会话里弹订阅提示 → 选「通知我」→ 微信授权窗，
    **必须勾上「任务确认通知」**（管审批；另一项是「任务完成提醒」）。**额度用完不推送、也不弹窗打断**；
    用户每次在小程序里与该会话互动（发消息 / 回答问题 / 批准权限）**自动补充一次**额度。
  - ★ **订阅是「会话内」的，不是账号级的**：提示只在**具体某个会话**里出现 ⇒ 想让某个**电脑端发起**的会话
    能推到手机，用户必须**在小程序里进入那个会话并产生一次互动**才会弹订阅提示。
    ⇒ 交付时必须**点名「去哪个会话里订阅」**，只说「打开订阅」用户会找不到入口。
  - ★ **额度是「用掉才补」而非「一直满」**：判据是「**刚在该会话里互动过**」。⇒ 让用户最后一步用
    「在小程序里发一句话 → 再触发一次敏感操作」来验证，比让他干等通知可靠。
  - 通知前有**缓冲期**：期间在电脑或小程序处理了就不再推；用户正停在该会话页面也不打扰。
  - ⇒ 交付话术：**「能做，但要三件事同时成立」= ① 桌面端开了连接许可 ② 小程序端订阅并勾了「任务确认通知」
    ③ 额度没用完（互动即补）**。只说「能」而不说额度会把人坑在「怎么这次没通知我」。
- 开启四步：① 桌面端**侧边栏底部悬停「连接移动端」图标** → 开「允许移动端连接此设备」
  ② 开**允许锁屏运行**（连接面板「保持唤醒状态，以便远程访问」；或 系统设置 → 通用 → 允许锁屏运行，
  两档：熄屏后保持唤醒 / 保持屏幕常亮）③ 小程序：微信搜 **WorkBuddy**，**同一账号**登录 → 设备入口选电脑
  ④ 电脑保持开机 + WorkBuddy 在运行。
- 版本门槛：**PC ≥ 5.3.8**、App ≥ 1.2.0（查 `install-manifest.json` 的 `appVersion` 自证）。
- 另一条路：微信 Claw 通道（`claw.channels.wechatmp`）；`artifactUploadEnabled: true` ⇒ 产物能回传小程序。

## 5. 陷阱

- **`null` ≠ `0`**：没记录就写「未记录」，别报成「关着」。
- **DB 里的档位可能与用户当场看到的不一致**（模式可能是在「被拦之后」才打开的）。
  如实并列两个事实，**不要硬圆成一个自洽故事**。
- ★ **查不到就说查不到**：「允许移动端连接此设备」「允许锁屏运行」这两个开关的状态**本地没有可靠落点**
  （见 §1）⇒ 报告里只能写「本机自证的部分是：版本 X ✅、微信通道 enabled ✅」，开关状态**让用户自己在界面看**。
  同类问题：`push_to_wechat` 能查（在 DB 里），别把「查不到」的那个也顺手编一个值。
- 用户可能同时在**别的会话/别的工作区**里干活 ⇒ 先看 `sessions.cwd` 归类。
- 机器不同路径可能不同：Node/安装目录按当前 runtime 说明与 `install-manifest.json` 现取。
