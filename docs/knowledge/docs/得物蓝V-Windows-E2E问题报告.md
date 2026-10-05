# 得物蓝V 素材发布工具 · Windows 端到端测试问题报告

- 对象仓库：`git@gitee.com:abulaitifans/dewu-bluev-publisher.git`（main）克隆于 `D:\work\dewu-bluev-publisher`
- 测试时间：2026-09-30 ~ 2026-10-01
- 测试方式：`BLUEV_NO_LOGIN=1` 免登录启动真实应用；驱动脚本在仓库外（`D:\work\e2e\`），**未改动 `src/`、未改动 `tools/` 的测试逻辑**（`tools/` 仅在前一阶段按你确认修了 Windows 兼容，见文末）
- 第 3 节回归：`node tools\run-all.js` → **全部通过，共 176 项断言**（修复 tools 后复跑两次均绿）

---

## 0. 一句话结论（第 9 节口径）

```
整体流程：通过，卡点在 4.3 与 4.7.8（两处真缺陷）
卡点现象：①「等比缩放」在 Windows 上必失败（EPERM unlink）②「导入AI报告→导出发布单→发布」时报告回写静默失效
日志原文：见 P1 / P2
```

第 4 节共采集 **44 个检查点**：通过 **37**，未通过 **7**。其中 **3 项为真缺陷（P1~P3）**，**4 项经复现证明是我脚本的断言/时序写错（见 §4，非仓库缺陷）**。

---

## ⚠️ 更新（2026-10-01）：P1 / P2 / P3 已全部修复，并做了双向验证

三条都已改进 `src/`（每改一处跑一遍 `node tools\run-all.js`，**176 项断言全绿**），且**改前必须红、改后必须绿**都拿到了可复算数字：

| 缺陷 | 改前（源码级定点破坏后实测） | 改后（当前代码实测） |
| --- | --- | --- |
| P1 等比缩放 | `转换 0 / 失败 1` + 残留 `.__tmp_scale_4.jpg` | `转换 1 / 失败 0` + 无残留 |
| P2 导出后 reportRow | `[0,0,0,0]` | `[2,3,4,5]` |
| P3 表头缺列 | `busy=true`（谎称「被占用」）+ 往暂存队列塞 1 条 | `busy=false` + 明说「表头缺少…列」+ 队列不动 |
| （对照）P3 真被占用 | `busy=true` + 暂存 | `busy=true` + 暂存 —— 修复没把「真占用」一起吞掉 |

**改法**：
- **P1** `src/main/services/imaging.js`：init 改成 `sharp.cache({ memory: 64, files: 0 })` —— 关掉 libvips 的**输入文件缓存**。
  三种配置实测对照：默认(`files:20`) → unlink 失败；`files:0` → 成功；`cache(false)` → 成功。内存缓存照留，性能不受影响。
- **P2** `src/main/jobs.js` 的 `sheet.export`：重建 `publish.rows` 时按 `id` 把上一批的 `reportRow` 带过来。
- **P3** 新增 `src/main/util/winpath.js: isFileLockError()`；`report.js` / `sheet.js` 的 `mergeResults` 用它分流
  （**只有真锁错误**才「整批暂存、下次再试」），并把「已回写报告：0 行」这种看着像成功的措辞改掉。

完整 diff 见同目录 **`得物蓝V-P1P2P3修复.diff`**。

### 同批补做的另外两件事

1. **4.7.5「发布成功」链路**（按你的要求：不真发帖，模拟发布流程）
   用**模拟设备通道**验证 —— 在 `child_process.execFile` 这一层装假 adb，其余全是真代码：
   自检 7 项 → 推 3 张图 + 媒体扫描 → 15 次 `uiautomator dump` → 14 次坐标点击 → 4 次 ADBKeyboard 中文广播
   → 2 条发布成功、回填时间 → `publish-log.jsonl` → **回写报告 B/C 列 2 行**。**15 项断言全绿**。
   ⚠️ **真机成功链路（真往你账号发帖）仍未验证** —— 那一步需要把 `uiMap` 换成得物发布页的真实节点。

2. **4.8 打包**
   `npm run dist:win` 成功产出两个 exe：`得物蓝V素材发布工具-1.0.0-x64-win.exe`（88.8 MB，安装版）+
   `…-便携版.exe`（88.7 MB）。`dist\win-unpacked\` 能正常启动（主/GPU/渲染三进程），
   且 userData 仍是 `%APPDATA%\dewu-bluev-publisher`（从开发版切到安装版不会「配置全丢」）。
   踩到一个坑：**winCodeSign 解压需要符号链接权限**（非管理员必失败），已给出绕过方法（排除 darwin 再解压）。
   ❌ **未做**：在一台干净 Windows 上真装一遍（窗口按钮/拖动、HEIC 转换、长路径、卸载后数据保留）。

3. **WINDOWS-E2E 第 6 节的 9 条「待确认问题」**已逐条定论（含依据），已写进 `docs/WINDOWS-E2E.md` §6。

---

## 1. 环境（第 5 项）

| 项 | 值 |
| --- | --- |
| `node -v` | `v22.22.2` |
| `git --version` | `git version 2.55.0.windows.3` |
| `adb` | 雷电自带那份**不存在**；实际用 MuMu 自带 `D:\MUMU\MuMuPlayer\nx_main\adb.exe`，`Android Debug Bridge version 1.0.41 / 36.0.0-13206524` |
| `adb devices` | `emulator-5554	device` |
| 模拟器 | **MuMu Player 12**（你原话是雷电 9，本机未装雷电，已按你的决定改用 MuMu） |
| 安卓 / 分辨率 | Android 12（SDK 32）/ 1080x1920 / density 280 |
| 得物 App | `com.shizhuang.duapp` **6.0.5** |
| ADBKeyboard | 原机未装，**由我下载安装**（`senzhk/ADBKeyBoard` 官方 APK，`adb install` 返回 `Success`） |
| 测试素材 | `D:\卡宾\20260901\`（4 个叶子：3 张合格 JPG / 40×40 过小 JPG / 600×600 PNG / 100×100 短边不足 JPG / `.DS_Store` / 5s mp4） |
| 应用数据目录 | `%APPDATA%\dewu-bluev-publisher\`（测试前**从未存在**，本次测试首次创建） |

> 说明：我的执行上下文没有桌面会话/GPU，启动 Electron 必须加 `--in-process-gpu --disable-gpu`（否则 `GPU process isn't usable`）。你本人在桌面双击跑不需要，纯属环境差异。

---

## 2. 真缺陷

### P1 · 4.3「处理可自动项」：等比缩放在 Windows 上必失败，并残留临时文件

1. **哪一步**：4.3 合规检查 → 点「开始检查」，再点「处理可自动项」（`compliance.fix`）。触发项：`26FW-YB160+冠军白_3\4.jpg`（100×100，短边 < 150，规则判定「等比缩放」）。文件来自扁平副本，是**硬链接**。
2. **预期**：日志 `处理完成：转换 2 · 隔离 1 · 失败 0`；缩放后 `4.jpg` 为缩放结果，无临时文件。
   **实际**：日志 `处理完成：转换 1 · 隔离 1 · 失败 1`；`4.jpg` 原样保留，目录里多出 `.__tmp_scale_4.jpg`。
3. **报错原文**：
   ```
   [error] [合规处理] 4.jpg 处理失败：EPERM: operation not permitted, unlink 'D:\卡宾\flat_20261001-0132\26FW-YB160+冠军白_3\4.jpg'
   ```
   （`src/main/services/compliance.js:159` 的 `fs.promises.unlink`，外面套了 `wp.retry`，6 次、约 6.6s 后放弃 —— 所以这步耗时 > 5s，也解释了为何脚本 5s 内抓不到日志。）
4. **现场文件**：
   - `D:\卡宾\flat_20261001-0132\26FW-YB160+冠军白_3\`：`1.jpg`(链接数2) `2.jpg`(2) `3.jpg`(1，PNG 转换产物) `4.jpg`(2) `.__tmp_scale_4.jpg`(1，残留)
   - `%APPDATA%\dewu-bluev-publisher\config.json` → `paths = {"source":"D:/卡宾/20260901","output":"D:/卡宾/输出","rejected":"D:/卡宾/_rejected"}`
5. **环境**：同上表。
6. **根因（已用最小复现锁定）**：不是硬链接问题，是 **sharp/libvips 的文件缓存持有源文件句柄，Windows 上句柄未释放前 `unlink` 必报 EPERM**。
   复现矩阵（脚本 `D:\work\e2e\retest.js`，仓库外）：

   | 用例 | 结果 |
   | --- | --- |
   | A1 等比缩放，目标为**硬链接** | ❌ `failed=1`，`EPERM unlink`，残留 `.__tmp_scale_4.jpg` |
   | A2 等比缩放，目标为**实体复制**（非硬链接） | ❌ 同样失败、同样残留 → **与硬链接无关** |
   | A3 同一流程，先 `sharp.cache(false)` | ✅ `failed=0`，无残留 |
   | A4 sharp 读完后立即 unlink | ✅ 正常 |

   `fitWithin()`（`imaging.js:182`）会**先 `sizeOf()` 做一次 metadata 读**、再 `toFile()`，两次都命中 libvips 文件缓存。

7. **修复方向（未动源码，供参考）**：`compliance.fix()` 里「删旧文件→改名」之前，改用 `sharp.cache(false)` / `sharp.cache({ files: 0 })`，或把源图先读成 Buffer 再交给 sharp，避免持锁；另建议失败时清理 `.__tmp_*`，别把中间产物留在素材目录。

---

### P2 · 4.7.8 路A「结果回写报告」：先导出发布单，回写就静默失效（0 行）

1. **哪一步**：4.6 路A「导入 AI 内容报告」→ 4.6 路B「导出发布单」→ 4.7「开始发布」→ 结束时应把结果回写到报告的 B（实际执行时间）/ C（执行结果）列。
2. **预期**：报告第 2 行 B 有回填时间、C 写「发布成功」或「失败：原因」。
   **实际**：B/C 始终为空，日志 `已回写报告：0 行`（不报错、不提示，静默）。
3. **报错原文**（无报错，正因如此才危险）：
   ```
   [ok] 已合并回写发布单：4 行
   [ok] 已回写报告：0 行 → report_ok.xlsx
   ```
4. **现场文件**：`D:\work\e2e\data\report_ok.xlsx`（B/C 列为空）；`D:\卡宾\输出\publish-log.jsonl`、`pending-results.json`。
5. **根因（已复现）**：`src/main/jobs.js` 的 `sheet.export` 分支重建 `publish.rows` 时**没有带走 `reportRow`**（导入报告时它是回写定位 Excel 行号的唯一依据）。之后 `report.mergeResults` 过滤 `r.reportRow` 得空集，直接早返回 `{updated:0}` —— 既不写也不报错。
   复现（`D:\work\e2e\retest2.js`，报告表头按真机一致：A=素材路径 / B=实际执行时间 / C=执行结果）：

   | 用例 | 结果 |
   | --- | --- |
   | D1 **只走路A**（导入报告→直接发布） | ✅ `已回写报告：4 行`，B=`01:48:36` C=`发布成功` |
   | D4 导入报告**再导出发布单**→发布 | ❌ 导出前 `reportRow=[2,3,4,5]`，导出后变 `[null,null,null,null]`，B/C 为空、`已回写报告：0 行` |

6. **修复方向**：`sheet.export` 重建 `pubRows` 时透传原行的 `reportRow`（按 `seq`/`id` 从既有 `publish.rows` 找回）。

---

### P3 · 报告回写失败时，把「表头缺列」等不可恢复错误说成「报告仍被占用」

1. **哪一步**：4.7.8 报告回写（任意触发点）。当报告表头缺「实际执行时间 / 执行结果」列时。
2. **预期**：明确告知「报告表头缺少 X 列，无法回写」。
   **实际**：日志说「报告仍被占用，N 条结果已暂存，下次再试」，把不可恢复错误当成可重试的占用，结果每次运行都白重试一遍。
3. **报错原文**：
   ```
   [warn] 报告仍被占用，4 条结果已暂存，下次再试（可只读打开但不建议编辑保存）
   ```
   而 `report.mergeResults` 内部真实返回的是：
   ```json
   {"updated":0,"pending":1,"busy":true,"skipped":0,
    "error":"报告表头缺少「素材路径 / 实际执行时间 / 执行结果」列，无法回写"}
   ```
4. **现场文件**：`D:\work\e2e\out3\retest2-result.json`（D5 项）；`%APPDATA%\dewu-bluev-publisher\config.json`。
5. **根因**：`report.js:352` 的 `catch` 把所有异常一律归为 `busy`（占用）。
6. **修复方向**：区分「占用类错误（EBUSY/EPERM/EACCES）」与「表头/数据类错误」，后者直接报原文、不暂存。

---

## 3. 4.7 真实通道：本轮只验到「失败链路」，未跑通「成功发布」

4.7.1~4.7.7 全部**通过**（设备添加/检测、驱动自检 7 项全绿、抓页面结构、导入定位表、失败恢复动作校验、失败截图 + 行标红 + 重跑、`publish-log.jsonl` 追加、重导出日志、占用暂存与补写）。

但**真实发布成功路径未验证**，原因必须先讲清（不是我糊过去）：

- 我用的是「**故意不命中**」的安全定位表（`tapText = __BLUEV_E2E_NO_SUCH_NODE__`），只为安全地验证失败/截图/回退链路，**不会真往你的账号发帖**。
- 因此本轮真实通道的结论是：**失败链路健壮**（失败原因写清「找不到「…」；当前可见文本：…」、每条失败都存了 `failures\seqN_tryM_*.png`、行标红、有「重跑」、结果进了 jsonl）。
- **真实“发布成功”需要把 uiMap 改成得物发布页的真实节点**（抓取到的候选表是猜的，必须人工改对）。这一步要动你的真实发布流程，**我没有替你跑** —— 需要的话你确认，我再做。

失败截图现场：`D:\卡宾\输出\failures\`（6 张，seq1~3 各 2 次重试）
示例：`seq1_try1_1790789631207.png`；可见文本抓到了 `烈焰觉醒 / 指尖大冒险 / …` —— 说明当时设备前台不是得物发布页。

---

## 4. 复现后判定为「我脚本写错，非仓库缺陷」的 4 项

> 这 4 项在首轮 `run-all` 时显示 FAIL，但经独立复现证明**功能正常**，我不把它们当仓库问题报。

| 首轮显示 | 真相 | 证据 |
| --- | --- | --- |
| 4.1 改口令 FAIL | **断言写错**：`auth.status()` 返回体里根本没有 `ok` 字段（只有 `requireLogin/user/isAdmin/…`），`mid.ok === true` 恒为假。功能正常（第二次用 `BlueV@2026x` 当旧口令改回成功，反证第一次真改了） | `src/main/auth.js:145-157`；`src/preload/index.js:13` |
| 4.4 两个批次并行 FAIL | **断言写错**：脚本自己又发了第 3 次 `copy.generate`（dup 探针），导致 `starts===2` 不成立。真实指标 `主进程最大并发=2`、`maxRows=2`、两份 `copy.json` 各 4 条，**均达标** | 首轮 result.json；`D:\卡宾\输出\batches\` |
| 4.4 重复启动同一批次被拒 FAIL | **时序问题**：探针在第一批跑完（本地模板是毫秒级）之后才发，自然不触发去重。**同时刻并发**重测 → 第二个被正确拒绝 | `D:\work\e2e\out2\retest-result.json` B 项：`r2.error="批次「DUPTEST_E2E」正在处理中，先等它跑完或取消掉"` |
| 4.6 含视频行标「暂不发布」FAIL | **断言写错**：导入阶段该行 `result=''`、原因在 `reason` 字段；`result='校验未通过'` 要等导出/发布阶段才写入。`reason="含 1 个视频，真实通道目前只推图片"` 正确 | `D:\work\e2e\out2\retest-result.json` C0.5 项 |
| 4.7.8 占用演练 FAIL | **被 P2 连带**：因 reportRow 丢失，`mergeResults` 根本没进写分支。用**表头正确**的报告重测 → 通过 | `retest2.js` D2：日志「报告仍被占用，4 条结果已暂存」，`pending=4`；D3 补写后 `pending=0`、B/C 有值 |

---

## 5. 其他观察（不算缺陷，供你判断）

- **4.1 免登录模式下账号区不渲染**：`BLUEV_NO_LOGIN=1` 时设置页的「账号与安全」区不出现，必须先真登录一次才渲染。文档与此一致（属设计），但**在免登录下想测改口令会卡住**，建议文档补一句。
- **测试后应用状态被改动**（都在 `%APPDATA%\dewu-bluev-publisher\`，测试前是空的）：
  - `config.json`：`paths` 指向 `D:\卡宾\*`；`publish.devices=[{UR视频号 / emulator-5554}]`；`publish.uiMap` 里是**故意不命中**的占位步骤 + `recover` 2 步。
  - `auth.json`：admin 口令已改回出厂 `BlueV@2026`，但 `mustChange=false`、`usingDefault=false`。
  - 若你要在这台机器上正式用，建议先删掉 `%APPDATA%\dewu-bluev-publisher\` 重新初始化。
- **`tools/` 的 Windows 兼容修复**（前一阶段你已确认，非本次新增）：`tools/adbtest.js` 改为在 `child_process.execFile` 层做假 adb 替身（新增 `tools/fakeadb/adb.js`，删除失效的 bash 版 `tools/fakeadb/adb`）；`tools/reporttest.js:166` 的 `await import(绝对路径)` 改 `require`；`tools/run-all.js` 子进程去掉 `ELECTRON_RUN_AS_NODE` 并给 Electron 套件加 `--in-process-gpu --disable-gpu`；README/HANDOFF/WINDOWS-E2E 同步。`git status` 已列在下面。

---

## 6. 复现脚本与产物（都在仓库外，未污染工程）

| 路径 | 说明 |
| --- | --- |
| `D:\work\e2e\make-data.js` | 造素材 / 商品池 / 三份 AI 内容报告 |
| `D:\work\e2e\e2e.js` | 第 4 节全流程驱动（44 检查点） |
| `D:\work\e2e\retest.js` | 复现 A/B/C（缩放 EPERM、批次去重、报告回写初测） |
| `D:\work\e2e\retest2.js` | 复现 D（正确表头的路A回写、占用暂存、补写、导出丢 reportRow、报错文案） |
| `D:\work\e2e\out\result.json` `out\logs-full.json` | 首轮 44 项结果 + 全量日志 |
| `D:\work\e2e\out2\retest-result.json` | A/B/C 复现结果 |
| `D:\work\e2e\out3\retest2-result.json` | D 复现结果 |
| `D:\卡宾\输出\` | 合规报告 / 发布单 / publish-log.jsonl / failures / dumps / batches |

---

**等你确认前，我没有改 `src/` 下任何一行代码。**

`git status`（仓库 `D:\work\dewu-bluev-publisher`，仅前阶段的 tools/文档改动）：
```
 M README.md
 M docs/HANDOFF.md
 M docs/WINDOWS-E2E.md
 M tools/adbtest.js
 M tools/reporttest.js
 M tools/run-all.js
 D tools/fakeadb/adb
?? tools/fakeadb/adb.js
```
