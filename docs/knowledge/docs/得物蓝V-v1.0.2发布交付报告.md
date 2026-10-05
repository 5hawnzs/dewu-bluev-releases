# 得物蓝V 素材发布工具 —— v1.0.2 发布交付报告

> 交付时间：2026-10-02 深夜 · 对应提交 `1296633`（源码+测试）/ `12a4737`（文档）/ `a371633`（补脚本路径）
> 仓库：`D:\work\dewu-bluev-publisher` · 远端 `origin/main` 已与本地一致（`git ls-remote` 实测）

---

## 一、你交办的四件事（逐条对照）

| # | 你说的话 | 结果 | 证据 |
|---|---|---|---|
| 1 | 「校验池中说有 5 个示例记录，实际没有，检查并删除」 | ✅ **删掉了**。那 5 条是 `pool.js` 里硬编码的 `SAMPLE` 假货号（`26FW-YB160` / `UF46FWT75EH1HF6` / `26FWT81` / `CK-Y208` / `abc`）；兜底改成空池，界面如实写「还没有导入商品池」 | `pool.js` 无 `SAMPLE`；`uicheck` 断言「商品池出厂没有示例货号」 |
| 2 | 「没校验、货号对但颜色错 ⇒ 按搜出来的货号默认选第一件商品，放到模拟器发布的提示词那里」 | ✅ **两处都写了**：①「模拟器发布」页给出完整规则（没校验/颜色对不上都不拦，发布时按货号搜结果后**默认选第一件商品**）；②「货号颜色校验」页注明「只提示、不拦发布」 | `app.js` TABS[6] / TABS[4]；`uicheck` 断言「模拟器发布页写清了颜色规则」 |
| 3 | 「登陆界面还是有黑边框，去掉，把下面的 admin 也去掉」 | ✅ **两处都改**（详见第二节） | `uicheck` 断言「登录页固定浅色」+「出厂账号提示已整条删除」；`logintest` 两条真负向 |
| 4 | 「打包推送到正式版」 | ✅ **已推送并公网核对**（详见第四节） | 公网 `latest.yml = 1.0.2`、安装包 `HTTP 200` |
| — | 「图标正常了不用管」 | ✅ 未改动图标相关任何代码 | 本轮 diff 不含 `build/icon.ico` 与 `make-icon.js` |

---

## 二、登录页「黑边框」的真实原因（不是边框）

**根因是这台机器的 Windows 处在深色模式。** 实测注册表：`AppsUseLightTheme=0`、`SystemUsesLightTheme=0`
⇒ 整块底色走了 `html.dark` 那套变量 ⇒ **近黑底 + 白卡片**，看着就是「黑框」；下面那行是 `loginTip` 的出厂账号提示。

修法（**两处必须一起改**，只改一处会「先闪一块近黑」）：

1. `styles.css`：在 `.gate` 子树里**重新声明整套浅色变量** ⇒ 登录页固定浅色，主界面继续跟随系统主题。
2. `window.js`：`BrowserWindow.backgroundColor` 是 **JS 取色、不随 CSS 走** ⇒ 新增 `GATE_BG='#f2f1ed'` 与
   `bgColor()`；建窗时登录门用浅色，退出登录门按系统切回；`nativeTheme` 变化时只在非登录门才改。
3. 出厂账号提示**整条删掉**（不是设 `hidden` —— 作者样式表的 `display` 会盖掉 `[hidden]`，那样等于没删）：
   `index.html` 的 `#lgTip`、`app.js#showGate()` 那段渲染、`auth.js#status()` 的 `defaultHint` 字段，**连读取链一起删**。

> 出厂账号本身**仍是** `admin / BlueV@2026`（口令只存 scrypt 哈希），只是**不再显示在界面上**。

---

## 三、颜色校验的新口径（你拍板的「不是必需项」）

- `verify.js` 里「颜色不匹配」「主色不符」两处 `block=true` → **`false`**；`isBlocked()` 的旧数据回推同步收紧。
- 现在**全库只剩 1 处 `block = true;`**：**多色货号没填颜色**（这条仍然拦，因为不填就发出去是错的）。
- 「查不到货号」「颜色不匹配」「主色不符」⇒ 都只告警，发布单里那几行**照常「待发布」**。
- 要让机器**真的**按「点第一件商品」执行，还需要在 UI 定位表里、`搜索货号` 后面补一步「点第一件商品」
  —— `uimap.suggest()` 目前没有这一步（界面上已把这条写清）。

---

## 四、发布与验证（实测数字）

| 项 | 值 |
|---|---|
| 版本 | `1.0.1` → **`1.0.2`** |
| 安装包 | `得物蓝V素材发布工具-1.0.2-x64-win.exe` |
| 体积 | `113,981,179 B` = **108.7 MB**（上一版 92,229,456 B = 88.0 MB，**+20.7 MB**） |
| blockmap | `119,988 B` = 117.2 KB |
| 公网清单 | `latest.yml` = **`1.0.2`**（sha512 与本地 `dist/latest.yml` 逐字相同） |
| 公网安装包 | `HTTP 200` / `Content-Length: 113,981,179`（与本地同） |
| 测试通道 | `beta.yml` **一个字节没动**（仍 `1.0.1-beta.2`） |
| 下载地址 | `https://dewu-bluev-release-1499238579.cos.ap-guangzhou.myqcloud.com/latest.yml` |

**★ 体积为什么涨了 20.7 MB —— 全是 ffmpeg。** 这一点必须讲清楚：

- `1.0.1` 发布时只内置了 **4 个**文件（`adb.exe` / `AdbWinApi.dll` / `AdbWinUsbApi.dll` / `ADBKeyboard.apk`）。
- `vendor/ffmpeg/ffmpeg.exe`（`82,797,568 B`，**GPL-3.0 静态构建**）是**当天 12:12 才进的仓库**（提交 `505be4f`）。
- ⇒ **`1.0.2` 是第一个把 GPL ffmpeg 推到公网正式通道的版本。**
  仓库自己的 README 与 `vendor/README.md` §3 写着「只在自己公司内部装机使用没问题；**若要分发给客户/外部方**，
  请换成 LGPL 共享构建」。**这条我在推送前摆给你确认过，你选的是「照推」（口径：只在自己公司/团队内部装机）。**
  若后续要发给客户，先换 LGPL 共享构建再发下一版即可。

---

## 五、测试证据（可复算）

- **全量回归 747 项全绿**（上一轮 745）：
  `smoke 39 · adbtest 72 · pendingtest 9 · compliancetest 26 · videotest 31 · batchtest 23 · reporttest 34 ·
  brandtest 80 · uicheck 123 · logintest 71 · gatetest 17 · updatertest 67 · releasetest 65 · prunetest 45 · logtest 45`
- **双向验证 7 条定点破坏**（每条从干净源码起 → **只由指定断言报红** → 逐字节还原且 md5 一致）：
  B1 去掉 `.gate` 浅色变量 / B2 塞回 `#lgTip` / B3 颜色又拦 / B4 `isBlocked` 退回 `pass === false` /
  B5 塞回示例池 / B6 多色漏填也不拦 / B7 删掉发布页那段说明。
  脚本已归档：`D:\work\_e2e\breakverify-v102.py`（跑法 `python breakverify-v102.py`；只复跑某几条 `… 1,3`）。
- 包内自证（直接读产物 `resources/app.asar`）：`version=1.0.2`、`vendor` **没进 asar**（符合设计）、
  `.gate` 浅色变量在、`#lgTip` 已不在、发布页新说明在、`block = true;` 只剩 1 处。

---

## 六、两件需要你点头的事

1. **清理源上 `1.0.0` 旧包**：`prune-release.js` 的 dry-run 说会删 `得物蓝V素材发布工具-1.0.0-x64-win.exe`
   （85.0 MB）—— 因为保留策略是「当前 + 1 个可回滚」，现在当前 `1.0.2`、回滚 `1.0.1`，`1.0.0` 出局。
   我**没有执行删除**（工具默认 dry-run）。要删就说一声，我跑 `--apply`。
2. **已装副本**：`D:\bluevbeta\dewu-bluev-publisher` 我只换了 `resources/app.asar`（旧的那份备份成
   `app.asar.bak-1.0.1`）。要真机验收登录页效果，直接启动它即可；要彻底干净就装新的 `1.0.2` 安装包。

> 另外提醒：自动更新只对**安装版**生效 —— 如果你现在跑的是 `npm start`（开发模式）或早先的便携版，
> 它收不到这次更新，得手动装一次 `1.0.2`。
