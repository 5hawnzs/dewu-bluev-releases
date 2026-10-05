# 得物蓝V ·「设备检查」两条报警的实测报告

> 报障原文：「目前点击设备检查，显示：**读不到 app 的界面**、**中文打不进去（已内置输入法）**」
> 查证日期：2026-10-02 · 设备：MuMu 12 / Android 12 / 900×1600 / `emulator-5554`
> 代码仓库：`D:\work\dewu-bluev-publisher`（HEAD `ec02b52`）

---

## 一句话结论

| 报警 | 表面原因 | 真因 | 结论 |
|---|---|---|---|
| 中文打不进去 | 模拟器上输入法没启用 | ★★ **代码里中文压根没走 ADBKeyboard 那条路** —— `input text` 打不进中文却返回成功，会发出一条**没标题没正文**的帖子 | **已修 + 已实测** |
| 读不到 App 的界面 | 抓取失败 | 当时模拟器**停在得物发布页**，那一屏此刻不 idle；切一下前后台就恢复（**8/8**） | **不是工具坏了**，文案已改清 |

---

## 一、「中文打不进去」—— 两层，第二层才是要命的

### 1.1 你看到的（设备侧，真实存在）

```
$ adb shell ime list -s
com.sohu.inputmethod.sogou.chuizi/...SogouIME       ← 只有 MuMu 自带的搜狗
$ adb shell settings get secure default_input_method
com.sohu.inputmethod.sogou.chuizi/...SogouIME
$ adb shell pm list packages | grep adbkeyboard
package:com.android.adbkeyboard                      ← apk 装着，但从没启用
```

⇒ **「程序内置了输入法」= 安装包自带这个 apk，不等于已经装进模拟器并启用。**
这一步必须做一次（发布页那个「一键装上中文输入法」按钮）。

**现场已处置**：手动跑完那三步，实测 0.5 秒完成，设备检查随即全绿。

```
ime enable com.android.adbkeyboard/.AdbIME  → Input method ... now enabled for user #0
ime set    com.android.adbkeyboard/.AdbIME  → Input method ... selected for user #0
```

### 1.2 ★★ 更严重的：代码根本没在用这条路（静默假成功）

```js
// 改前 publisher.js
const adbKeyboard = !!c.adbKeyboard;     // ← publish.adbKeyboard 这个键【全仓无人写】
...
adb.inputText(serial, step.value, { adbKeyboard });

// 改前 adb.js
async function inputText(serial, text, { adbKeyboard = false } = {}) {
  if (adbKeyboard) { ...广播... }        // ← 恒不成立
  return shell(serial, `input text "${esc}"`);   // ← 中文走这里
}
```

`publish.adbKeyboard` **默认配置里没有、界面上也没有开关** ⇒ 恒为假 ⇒ 中文永远走 `input text`。

### 1.3 拿真实设备取证（Chrome 地址栏当靶子，截图见附件）

| 通道 | 内容 | 结果 | 命令返回 |
|---|---|---|---|
| `input text` | `abc` | ✅ 正常进框 | exit 0 |
| `input text` | `中文标题` | ❌ **一个字都没进**（地址栏纹丝不动） | **exit 0、无任何输出** |
| `am broadcast -a ADB_INPUT_TEXT` | `中文标题` | ✅ 进框 | `Broadcast completed: result=0` |

⇒ **`input text` 对中文无效，却返回成功。** 旧流程会一路跑完、日志写「发布成功」，
实际发出去的是一条**标题正文全空**的帖子 —— 这是「不许造假成功」里最典型的一种。

### 1.4 附带发现：广播的返回码也不能当证据

```
$ adb shell cmd package query-receivers --brief -a ADB_INPUT_TEXT
No receivers found                                    ← 接收器是跟着 AdbIME 服务动态注册的
$ adb shell am broadcast -a ADB_INPUT_TEXT --es msg hello
Broadcast completed: result=0                         ← 有人接也是这个值
$ adb shell am broadcast -a NO_SUCH_ACTION_XYZ --es msg hello
Broadcast completed: result=0                         ← 没人接还是这个值
```

⇒ 旧实现里 `if (r.ok && /result=0/.test(r.stdout)) return r;` 等于**给「中文没进去」盖了个合格的章**。

### 1.5 修法

1. `adb.keyboardReady(serial)`：读 `settings get secure default_input_method`，**按设备真实状态**判定；
2. `adb.inputText(serial, text)`：
   - 纯 ASCII ⇒ `input text`（实测可用，且不依赖设备输入法状态）；
   - 含中文 ⇒ 必须走广播；输入法不可用时**明确失败**并写清下一步（绝不静默退化）；
3. `publisher` 不再读 `c.adbKeyboard`；
4. 设备检查里这条从「能发，但…」(warn) 升级为**「中文发不出去」**(bad)，并明说「内置 ≠ 已装进模拟器」。

---

## 二、「读不到 App 的界面」—— 不是工具坏了

### 2.1 现场

```
$ adb shell dumpsys window | grep mCurrentFocus
mCurrentFocus=...com.shizhuang.duapp/...media.publish.activity.TotalPublishProcessActivity
$ adb shell "rm -f /sdcard/t.xml; uiautomator dump /sdcard/t.xml"
ERROR: could not get idle state.        ← 连试 4 次全失败（含临时把三个动画开关置 0）
```

### 2.2 阳性对照（证明链路本身是好的）

| 目标 | plain dump |
|---|---|
| 桌面（Launcher） | ✅ 26382 字节 |
| 得物**发布页**（卡住时） | ❌ `could not get idle state.` |
| 得物**发布页**（切后台再回前台后） | ✅ **8/8 全成功**，20964 字节 / 单次约 **2.1 s** |

⇒ 「抓不到」取决于**这一屏此刻的状态**，与 adb / uiautomator 无关。

### 2.3 修法（只改文案，不动行为）

抓不到时查 `mCurrentFocus`，先说清**当时停在哪一屏**，再给实测有效的动作（退到首页 / 切到桌面再回），
并明确写「**不是 adb 坏了**」—— 否则用户会以为要重装或换工具。

---

## 三、改了什么（5 个文件）

| 文件 | 改动 |
|---|---|
| `src/main/services/adb.js` | 新增 `keyboardReady()` / `currentFocus()`；重写 `inputText()`；设备检查两条文案 + 判定级别 |
| `src/main/services/publisher.js` | 删掉 `!!c.adbKeyboard`，输入通道交给 `adb.inputText` 自判；设备列表多回两个输入法字段 |
| `src/renderer/app.js` | 设置页「外部依赖」+ adb 路径说明：写清「内置 ≠ 已装进模拟器」 |
| `tools/fakeadb/adb.js` | 新增现场开关 `IME_ACTIVE`（模拟「已装进模拟器并启用」） |
| `tools/adbtest.js` | 新增 ⑯ 组（11 条）+ ⑬ 组 2 条；★ 并把 `publish.adbKeyboard` 从测试配置里**删掉**，让测试与产线配置形态一致 |

---

## 四、自证（不是「看起来对」）

**① 全量回归**：`node tools/run-all.js` → **十二套全绿，489 项断言**（`adbtest` 61 → **72**）。

**② 双向验证**：把 `adb.js` / `publisher.js` 还原成**改前**版本，跑**新写的**断言：

| 破坏 | 结果 |
|---|---|
| 只还原 `adb.js` | 红 **11** 条 |
| `adb.js` + `publisher.js` 都还原（完整复现线上） | 红 **12** 条 |

其中一条直接打出改前的真相：

```
FAIL  ⑯ 中文打不进去时，这一条如实标「失败」  → 发布成功 /
FAIL  ⑯ ★ 绝不把中文塞给 `input text`          → input text "白色的鞋谁懂" | ...
```

还原后两个文件 md5 逐字节一致（脚本 `try/finally` 兜底）。

**③ 真机复核**：直接调**产线函数** `adb.inputText()`

| 设备当前输入法 | 调用 | 返回 |
|---|---|---|
| ADBKeyboard | `inputText(serial, '中文标题')` | `ok: true` → 截图里中文进框 ✅ |
| 搜狗 | `inputText(serial, '第二段中文')` | `ok: false, code: 'ime-not-active'` + 说清下一步 ✅ |

**④ 设备状态已还原**：三个动画开关 = `1 1 1`；当前输入法 = `com.android.adbkeyboard/.AdbIME`（你要的就是能打中文）。

---

## 五、你要做的

1. 打开「模拟器发布」页 → 点「检查能不能发布」→ 现在应该是**全绿**（本机已实测）。
2. 若换新模拟器/新账号，**第一次**要在这页点一次「一键装上中文输入法」（只点一次，之后一直有效）。
3. 装完之后，**在模拟器里手动点输入框不会弹键盘** —— 这是 ADBKeyboard 的正常表现，不是坏了。
   想恢复手动打字：`设置 → 系统 → 语言和输入法` 里切回搜狗即可。

> ⚠️ 别把「能发出去」当成「发对了」：改前那批如果发过，标题/正文很可能是空的。可以按发布时间回查一下。
