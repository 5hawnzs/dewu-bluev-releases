---
name: workbuddy-crash-report-submit
description: 把 WorkBuddy 桌面端的崩溃/卡死证据整理成「可直接提交给官方」的材料包，并给出官方反馈渠道的精确操作步骤。当用户说「怎么把崩溃报告交给官方」「帮我反馈这个 bug」「写个脚本收集报错」「应用崩了要报给谁」时使用。含官方反馈入口的实测事实（正文框仅 300 字符、可传图片、日志是勾选框自动上传）、自动脱敏脚本、以及把长报告渲染成 PNG 长图以绕过字符上限的办法。
agent_created: true
---

# 把 WorkBuddy 崩溃/卡死证据提交给官方

## 0. 先记住这个反直觉的事实（否则会白做）

**应用内「意见反馈」的正文框硬上限只有 300 字符。** 你辛苦整理的长报告**粘不进去**。
唯一能突破的通道是**上传图片**（单张 ≤ 10MB，jpg/png/gif/bmp/webp）。
⇒ 所以正确产出是：**一份 ≤300 字的精炼正文 + 一张把长报告渲染成的 PNG**，而不是一个长 markdown。

## 1. 官方反馈渠道（2026-10-01 从 `resources/app.asar` 实测）

| 项 | 事实 | 依据 |
|---|---|---|
| 入口 | 设置 → **帮助与反馈 →「意见反馈」**（英文 Feedback） | i18n key `settings.helpFeedback.feedback` |
| 其它入口 | 助手消息的「⋯」菜单 →「提交反馈」；错误横幅的「提交反馈」链接 | `messageFeedback.submitFeedback`、`errorBanner.submitFeedback` |
| 后端 | `POST https://copilot.tencent.com/v2/feedback`（staging 为 `staging-copilot.tencent.com`） | app.asar 中的 `feedbackApiUrl` |
| 正文上限 | **`MAX_TEXT_LENGTH = 300`** | app.asar |
| 图片 | jpg/png/gif/bmp/webp，单张 ≤ **10 MB**（`MAX_IMAGE_SIZE`） | app.asar |
| 「上传日志」 | **是个勾选框（默认勾选）**，提交时带 `includeLog`，由客户端**自动打包本机日志**上报 —— **不是**让你挑文件 | `useState(true)` + `includeLog: uploadLog` |
| 频控 | 同一账号 **1 分钟** 只能提交一次（`rateLimitError`） | app.asar |
| 返回 | 后台返回 `feedback_id` | app.asar |
| 另有一项 | 设置里还有「**联系我们**」(`settings.helpFeedback.contactUs`)，其 URL 来自**远程配置**，静态读不到 —— 不要臆测 | app.asar |

> 静态扫描**找不到任何官方反馈邮箱或工单地址**（扫到的邮箱全是开源依赖作者的）。
> 所以别编「发邮件给 xxx」这种结论；没有别的通道就说没有。

## 2. 崩溃证据在哪（本机）

```
~/.workbuddy/logs/Crash-Log/crash-report-main-<pid>-<启动时间>.json     ← 金矿
~/.workbuddy/logs/AppStartup.log                                        ← 版本/build/electron
~/.workbuddy/logs/update/update-YYYYMMDD.log                            ← 更新是否被拦
```

崩溃报告结构：`launchedAt / pid / processName / versions{node,electron,chrome,v8} / platform / arch / appVersion / entries[] / droppedCount`。
`entries[]` 是时间有序的事件流，典型形态：**`renderer_js_error` → `renderer_crash` → `child_process_crash` → `gpu_crash`**。

**最值钱的是 `entries[].stack`** —— 它带**文件名与行号**（如
`at calculateContentBlocksSize (…/renderer/assets/src-m7T4EV47.js:19115:22)`），
官方据此能直接定位代码。**一定要把完整 stack 原文抄进报告，别只写错误消息。**

## 3. 跑脚本

```bash
# Bash 工具里 PATH 是坏的，先在同一条命令里导出（详见技能 win-sandbox-scripting）
export PATH="/c/Users/<用户>/.workbuddy/vendor/PortableGit/usr/bin:/c/Windows:/c/Windows/System32:$PATH"
cd "<工作区>"
"C:/Users/<用户>/.workbuddy/binaries/python/versions/3.13.12/python.exe" "整理反馈给官方.py"
# 无 Chrome/Edge 时：加 --no-image
```

脚本 `scripts/collect_feedback.py` 产出到 `<脚本目录>/给官方/`：

| 文件 | 用途 |
|---|---|
| `01_意见反馈正文.txt` | **≤300 字符**，直接全选粘贴进反馈框（**每次运行按实测数据重新合成**，见下） |
| `02_完整技术说明.md` | 完整技术报告（人读 / 发给对接人） |
| `03_崩溃报告_原始/*.json` | 全部崩溃报告（**已脱敏**，可逐条复算） |
| `04_关键日志摘录.txt` | 更新被拦等关键日志原文 |
| `05_环境与版本.txt` | 版本 / 系统信息 |
| `06_反馈正文_长图_*.png` | 把 02 渲染成图片，**走「上传图片」通道** |
| `给官方-反馈包.zip` | 以上全部打包 |

脚本会**严格校验 300 字符，超出就报错退出**（不静默截断 —— 截断会让正文失去意义却看不出来）。

## 4. 提交步骤（交给用户做）

1. 设置 → 帮助与反馈 →「意见反馈」
2. 正文粘贴 `01_意见反馈正文.txt` 全文
3. **保持勾选「上传日志」**（默认已勾）；不想传对话记录可取消
4. 「上传图片」把 `06_反馈正文_长图_*.png` **全部**传上去
5. 提交 → 提示「反馈提交成功」后 **1 分钟内不能再提交**，想补内容要等
6. 更完整的材料（zip）另发给对接的官方同学/技术支持群

## 5. 脱敏（必须做，且要自证）

必脱：用户名与含用户名的路径、邮箱、`machineId/deviceId/userId/uid/sessionId/token/apiKey/secret/password/cookie/Authorization`、非本机 IP。
**刻意保留**：`build=` 哈希（官方排查要用）。

两个坑：
- **要同时覆盖 JSON 的 `"key":"value"` 和日志的 `key=value`** 两种写法。
  只写 JSON 版会漏掉日志行（实测漏了 `userId=86a59951-…`）。
- **`re.sub` 的替换串里反斜杠是转义符**：`r"C:\Users\<用户>"` 会抛
  `re.PatternError: bad escape \U`。路径类替换一律**改用函数替换** `lambda m: "C:\\Users\\<用户>"`。

**脱敏必须自证**：生成后 grep 一遍敏感串，确认命中数为 0（命中的应只是你自己文档里"machineId"这个词）。

## 6. 把长报告渲染成 PNG 长图（绕过 300 字符上限）

Chrome/Edge 无头 `--screenshot` **只截视口，不会自适应整页**（实测：`--window-size=1000,600` 得到的就是 1000×600）。
用**两遍法**：

1. **量高**：页面里挂 `window.onload` 把 `document.documentElement.scrollHeight`
   写进 `<html data-page-h="…">`，然后
   `chrome --headless=new --dump-dom --virtual-time-budget=4000 <file://…>`，
   从输出里正则取 `data-page-h="(\d+)"`。
2. **截图**：`chrome --headless=new --hide-scrollbars --force-device-scale-factor=1
   --screenshot=out.png --window-size=<W>,<H>`。

要点：
- 页面 `body { width: <W>px }` 固定宽度，**量高与截图必须用同一个 W**，否则换行不同、高度对不上。
- **单页别超过 ~3200px**：太长的图在反馈系统里会被缩略到看不清 ⇒ 按内容块**分页**（贪心对半分，逐步量高）。
- 判读 PNG 尺寸**不需要 Pillow**：读 PNG 头第 16–24 字节的 IHDR 宽高即可。
- `--user-data-dir` 指向 `tempfile.gettempdir()`，**别放进交付目录**；
  工作区内的 `shutil.rmtree` 可能被 safe-delete 钩子拦（`SAFE_DELETE_FAIL_CLOSED`）。

## 7. 容易犯的取证错误（都踩过）

- **把提示词原文当成真实输出**。grep 日志/会话时命中的字符串可能出自**提示词模板**，
  不是程序真的打印过。判据：**按角色分流**（工具输出 / 助手文本 / 提示词），
  实测那次命中的三句话在提示词里各出现 1 次、真实工具输出里 0 次。
- **版本号可能有两套**：应用**自报**的 `appVersion`（AppStartup.log / 崩溃报告）
  与安装包/更新服务的 `productVersion`（install-manifest.json / update 日志）**可以不一致**。
  实测：自报 `5.0.3`，更新服务说 `5.5.6.38337834`。
  ⇒ **两个都列出来并标注来源，不要替官方下结论说哪个是"真版本"。**
- **不要拿"资源占用正常"去否定崩溃**：崩溃瞬间 CPU/内存/磁盘全宽松是**正常的**，
  因为卡死是**主线程被阻塞**或**进程被杀**，不是算不过来。
  判据看 `Crash-Log` 里的 `renderer_crash`，不是看任务管理器。
- `cmd /c ver` 的中文输出在 Python 里是 **GBK**，直接读会乱码 ⇒ 用 `platform.platform()`。
- **★ 别把「崩溃记录条数」当「崩溃次数」**。同一次崩溃可能同时写 **2 条** `renderer_crash`
  （`index.html` 与业务页各自的 webContents 一起被杀）。
  实测 09-18~10-03：**23 条记录 → 去重后 21 次崩溃事件**（按 `timestamp[:19]` 去重）。
  ⇒ 脚本已内置 `renderer_crash_events`；写「今天崩了几次」必须用去重值，否则对不上用户体感。
- **★ 正文别写死**。`BODY` 曾是一段硬编码，跑第二次时数字全是上一轮的（会静默误导用户去提交）。
  现已改为 `build_body(sumry, evid)` **从本次实测数据合成**：句子按重要性排序、从前往后塞满
  ≤300 字符，塞不下的**丢弃并在 stdout 打印丢了哪几句**（不静默截断）。改脚本时别退回硬编码。

## 8. 报告里必须留一节「我未能确认的部分」
把推断和事实分开（例：「多会话共用同一渲染进程」是推断、未做对照实验）。
官方最需要的是**可复算的数字 + 完整 stack + 明确的不确定性**，不是一段自信的散文。

## 9. 量化「闪退浪费了多少积分」（用户一定会问）

跑 `scripts/credit_loss_audit.py`（只读，不改任何文件）。

**数据在哪**（都没写在崩溃报告里，得自己关联）：
- `~/.workbuddy/workbuddy.db` → 表 **`session_usage`**：`session_id / used / size / credit_json`。
  `credit_json` = `{requestId: 积分}`，**按每个模型调用分别记账**（不是按「一条回复」）。
- 会话明细 `~/.workbuddy/projects/<目录>/<sessionId>.jsonl`：每行 `providerData.traceId` = 上面的 requestId。
- 崩溃时刻：`Crash-Log/*.json` 的 `renderer_crash` 时间戳。

**判据**：某次调用**有 `function_call` 但找不到对应的 `function_call_result`**（`parentId` 对不上）
⇒ 这一步被中途打断；再看它**之后**多久发生闪退来定置信度。

**实测（2026-10-03，21 次崩溃 / 26 个会话）**：

| 口径 | 积分 | 次数 |
|---|---|---|
| ≤10 秒内闪退（几乎可断定是闪退打断的） | **42.36** | 6 |
| ≤60 秒 | 51.91 | 7 |
| ≤10 分钟 | 79.13 | 10 |
| ≤1 小时 | 171.28 | 12 |
| 全部截断（含与闪退无关的） | 275.62 | 22 |

同期「积分明细表可见的已扣总量」= **9156.56**，所以 ≤1 小时口径只占 **1.87%**。

**报告时必须同时讲清三件事，否则就是夸大**：
1. 本地**没有**「因故障作废/退还的积分」字段 —— 上表量的是**调用被截断**，不是平台认定的浪费。
2. **重做的成本量不出来**：崩溃后重说一遍、我重跑一遍，那部分才是大头，但没法从数据里区分。
3. 所以给一个**区间**（严 / 宽）并说明口径，别只报一个数当定论。

**踩过的坑（都真的踩了）**：
- ★ 提取 requestId **不能用** `providerData.traceId` 精确匹配 —— 有一批键实际写在别的字段里，
  用它筛会得到「40.6% 的积分查无记录」这种**假结论**。改用**在文件原文里做字面匹配**（实测缺口归零）。
  ⇒ 一个说「几乎全丢」的指标，先怀疑指标本身。
- ★ 归因方向别搞反：被打断的调用发生在崩溃**之前**，要找的是**它之后的下一次**崩溃
  （写成「调用之后 10 分钟内」会漏掉全部真实案例）。
- 同一会话里 `credit_json` 的键数 ≈ **模型调用次数**（会远多于「对话轮数」），别拿它当次数报给用户。

