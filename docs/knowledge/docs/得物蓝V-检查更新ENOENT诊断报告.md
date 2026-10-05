# 「当前版本出错 + 检查更新 ENOENT」诊断报告

> 诊断对象：`ENOENT: no such file or directory, open 'D:\work\_dist3\win-unpacked\resources\app-update.yml'`
> 结论级别：**已完整复现，机制已定位到 electron-builder 源码行**（不是猜的）

---

## 一、一句话结论

**你运行的不是安装版，而是 `D:\work\_dist3\win-unpacked\` 里的「打包中间产物」。**

`--dir` 方式打包（只出 win-unpacked 目录、不打安装包）时，electron-builder **故意不生成** `resources/app-update.yml`；
而自动更新的第一步就是读这个文件，读不到就报 ENOENT。

**换用真正的安装包（NSIS）安装后再运行，这个问题不会出现。**

---

## 二、证据链（三条，互相独立）

### 证据 1：报错路径本身就说明了 exe 的来源

报错里的绝对路径 `D:\work\_dist3\win-unpacked\resources\app-update.yml`，是运行时用
`process.resourcesPath` 拼出来的。它等于 `D:\work\_dist3\win-unpacked\resources`
⇒ **你双击的就是 `D:\work\_dist3\win-unpacked\` 里的那个 exe**（不是开始菜单/桌面快捷方式装的版本）。

### 证据 2：实测复现，且拿到更新器内部状态

把 `_dist3` 产物复制一份、注入探针跑起来，读到的真实状态：

```json
{
  "resourcesPath": "D:\\work\\_probe3\\resources",
  "isPackaged": true,
  "version": "1.0.1",
  "yamlExisted": false,                       // ← app-update.yml 确实不存在
  "upd":  { "supported": true, "current": "1.0.1", "status": "idle" },
  "check": { "ok": false,
             "error": "ENOENT: no such file or directory, open '...\\app-update.yml'" },
  "updAfter": { "status": "error", "message": "ENOENT: ... app-update.yml" }
}
```

对照实验 —— 只把 `_dist5`（安装包产物）里的 `app-update.yml` 补进同一个目录，**其他什么都不改**，再跑一次：

```json
{
  "yamlExisted": true,
  "check":    { "ok": true },                                    // ← 不再 ENOENT
  "updAfter": { "status": "uptodate", "current": "1.0.1",
                "latest": "1.0.1", "message": "已经是最新版本" }
}
```

⇒ **变量只有一个（app-update.yml 在不在），结果反转。根因确认。**

### 证据 3：electron-builder 源码里那条判断

`node_modules/app-builder-lib/out/publish/PublishManager.js`：

```js
function isSuitableWindowsTarget(target) {
    if (target.name === "appx" && target.options != null && target.options.electronUpdaterAware) return true;
    return target.name === "nsis" || target.name.startsWith("nsis-");
}
// ... 在 afterPack 阶段：
if (packager.platform === Platform.WINDOWS) {
    if (!event.targets.some(it => isSuitableWindowsTarget(it))) return;   // ← 不是 nsis 就直接跳过
}
await writeFile(path.join(packager.getResourcesDir(event.appOutDir), "app-update.yml"), ...);
```

**只有 `nsis`（或显式开了 `electronUpdaterAware` 的 `appx`）才会写这个文件。**
`--dir` 打包的 target 名是 `dir` ⇒ 直接被 `return` 跳过。

---

## 三、为什么「当前版本」看起来是「出错」

**版本号本身没读错。** 探针读到的 `current` 是 `1.0.1`，界面那行显示的也是 `1.0.1`。

那个红色「出错」是**徽标**，不是版本号 —— 对照 `src/renderer/app.js` 的状态表：

```js
const UPD_KIND = {
  idle: ['wait','未检查'], checking: ['run','检查中'], available: ['warn','有新版本'],
  downloading: ['run','下载中'], ready: ['ok','可以安装'], uptodate: ['ok','已是最新'],
  error: ['bad','出错']          // ← 就是这两个字
};
```

流程是：**你点了「检查更新」→ 主进程 check 抛 ENOENT → 状态置为 `error` → 徽标变「出错」+ 下方显示错误原文。**
所以你看到的「当前版本 … 出错」，准确说是「当前版本 1.0.1」+「出错」徽标，两者挨在一起容易被读成一句话。

---

## 四、后面还会复现吗？—— 会，但只限于一种用法

| 你运行的 exe 来自 | 有 `resources/app-update.yml`？ | 检查更新 |
|---|---|---|
| `_dist2` / `_dist3` / `_dist4`（`--dir` 目录打包） | **没有** | **必然 ENOENT**（100% 复现，设计如此，不是缺陷） |
| `_dist5` / `dist`（NSIS 安装包，装完后再跑） | **有** | 正常（实测 `ok:true`） |
| `D:\bluevbeta\dewu-bluev-publisher`（已装副本） | **有** | 正常 |

**一句话判据**：看 exe 所在目录里有没有 **`Uninstall 得物蓝V素材发布工具.exe`**。
有 = 安装版（正常）；没有、只有一个光秃秃的 `win-unpacked` = 绿色目录（必报这个错）。

> 背景：`_dist2/_dist3/_dist4` 是我为了「只换 `app.asar`」而打的**目录版中间产物**，
> 本来就不是给人运行的发布件。发布件只有 NSIS 安装包。

---

## 五、怎么办

### 立即可用（已为你准备好）

我用当前最新代码（含视频自动转 MP4、内置 ffmpeg、更新自检修复、数据清理）重新打了**正式安装包**：

```
D:\work\_dist5\得物蓝V素材发布工具-1.0.1-x64-win.exe     (108.7 MB)
```

实测该产物 `resources\app-update.yml` 存在，`resources\ffmpeg\` 也在。
**装它，然后从开始菜单/桌面快捷方式启动** —— 检查更新会正常返回「已经是最新版本」，不再出现「出错」。

也可以继续用现成的 `D:\bluevbeta\dewu-bluev-publisher\`（已是同一份最新代码 + 带 app-update.yml）。

### 一个重要提醒（关于自动更新）

这次没有跑 `upload-release.js`，**COS 上的 `latest.yml` 仍是 1.0.1**，而包里版本号也是 1.0.1。
所以：

- 装了上面的安装包 → 检查更新会说「已经是最新版本」（正确，但拿不到"新版本"提示）；
- 如果你希望**通过自动更新把带视频功能的新版推给别人**，必须先
  **升 `package.json` 的 version（如 1.0.2）→ 重新打包 → `npm run release:stable`**。
  否则版本号相同，别人永远收不到这个包。

---

## 六、本次诊断做了什么（可复算）

1. 对照三条独立证据（报错路径 / 实测探针 / electron-builder 源码），确认根因；
2. 做**双向对照实验**：同一份产物，只增删 `app-update.yml`，`check` 由 `ok:false(ENOENT)` 变为 `ok:true`；
3. 重新打 NSIS 安装包 `_dist5` 并核验其中确实含 `app-update.yml` + `ffmpeg`；
4. 探针目录（`D:\work\_probe3`）、探针 userData 已全部清理，无残留进程。

**未改动仓库任何源码**（`git status` 干净），本次只做诊断与重新打包。
