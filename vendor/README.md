# vendor/ —— 随安装包一起分发的第三方文件

这里是**要在打包时原样搬进安装包**的东西（`package.json → build.extraResources`）。
它们不经过 asar（asar 是压缩归档，里面的 `.exe` 不能直接执行），装完之后落在这里：

| 仓库里的位置 | 用户机器上装完之后 | 谁在用 |
|---|---|---|
| `vendor/adb/` | `<安装目录>/resources/adb/` | `src/main/index.js` → `adb.setBundledAdbDir()` |
| `vendor/adbkeyboard/` | `<安装目录>/resources/adbkeyboard/` | `src/main/index.js` → `adb.setBundledApkPath()` |

**为什么要内置**：以前 adb 要用户自己去模拟器安装目录里翻（`D:\MUMU\MuMuPlayer\nx_main\adb.exe`）
填进设置里 —— 这是新同事的第一道墙。adb 三件套才 8 MB 出头，内置之后「装上就能用」。
中文输入法同理：不装它，中文标题/正文根本打不进得物发布页。

> ⚠️ 这些二进制**故意进 git**。仓库的 `.gitignore` 一般不许提交二进制（`node_modules`/`dist` 那种几百 MB 的），
> 但这一份是**每次打包都必须有**的，走「构建时下载」会让没网的机器打不出包。
> 合计约 9.6 MB，可以接受。

---

## 1. `vendor/adb/` —— Android platform-tools（官方 Google 构建）

| 文件 | 字节 | md5 |
|---|---|---|
| `adb.exe` | 8,273,560 | `a800950fb8371b10f124d7be32926574` |
| `AdbWinApi.dll` | 108,184 | `fccdfea383a8d06fd152c2ffbd185dd0` |
| `AdbWinUsbApi.dll` | 73,368 | `ce674ec12db4255ca0fc65138f216eaa` |
| `LICENSE.txt` | 11,498 | Apache License 2.0 全文（从上游 `NOTICE.txt` 摘出，行 1–207） |
| `NOTICE.txt` | 1,154,131 | 上游原样，含各组件署名 |

- **版本**：`Android Debug Bridge version 1.0.41` / `Version 37.0.1-15733141`（`source.properties` 里 `Pkg.Revision=37.0.1`）
- **来源**：`https://dl.google.com/android/repository/platform-tools-latest-windows.zip`（8,044,989 字节）
  解出后只取 `adb.exe` / `AdbWinApi.dll` / `AdbWinUsbApi.dll` / `NOTICE.txt`
- **许可**：Apache License 2.0 —— **明确允许随产品再分发**，要求是附上许可全文并保留署名。
  `LICENSE.txt` + `NOTICE.txt` 就是为这个随包一起发进去的（在 `resources/adb/` 下，用户可查）。
- ★ **不要用模拟器自带的 adb 顶替**：MuMu 12 自带的是 `36.0.0-13206524`（`adb.exe` 6,641,760 字节），
  是另一个构建。功能相当，但版本、体积、来源都不如官方这份清楚。要换版本就按下面第 3 节重做一遍。

## 2. `vendor/adbkeyboard/` —— ADBKeyboard（给脚本用的中文输入法）

| 文件 | 字节 | md5 |
|---|---|---|
| `ADBKeyboard.apk` | 17,374 | `84346f7dbae47105c3241f82c1c58ce2` |

- **来源**：`https://github.com/senzhk/ADBKeyBoard`（`master/ADBKeyboard.apk`）
- **包里**：`com.android.adbkeyboard`，输入法组件 `com.android.adbkeyboard/.AdbIME`
- ★ **装上只是第一步**。要能打中文，`adb shell` 这三条缺一不可（`adb.js#installKeyboard()` 一次做完）：
  ```
  adb install -r ADBKeyboard.apk
  adb shell ime enable com.android.adbkeyboard/.AdbIME
  adb shell ime set    com.android.adbkeyboard/.AdbIME
  ```
  只装不启用 ⇒ `ADB_INPUT_TEXT` 广播没人接；不设成当前输入法 ⇒ 字照样进不了输入框。
- ★ **副作用（必须让用户知道）**：设成当前输入法后，**在模拟器里手动点输入框不会弹出键盘**。
  这是 ADBKeyboard 的正常表现（它本来就是给脚本用的）。所以这一步**只由用户在「检查能不能发布」里点按钮触发**，
  程序绝不自动做。

## 3. 怎么更新到新版本

```bash
# ① 下载官方 platform-tools 并解压
curl -L -o pt.zip https://dl.google.com/android/repository/platform-tools-latest-windows.zip
unzip -o pt.zip

# ② 只取这四样覆盖进来（NOTICE.txt 要跟着换）
cp platform-tools/{adb.exe,AdbWinApi.dll,AdbWinUsbApi.dll,NOTICE.txt} vendor/adb/
head -207 vendor/adb/NOTICE.txt > vendor/adb/LICENSE.txt

# ③ 校验 + 对一下版本
cd vendor/adb && md5sum adb.exe AdbWinApi.dll AdbWinUsbApi.dll
./adb.exe version            # 期望 Android Debug Bridge version 1.0.41

# ④ 全量回归（uicheck 会核对这几个文件的哈希与存在性）
node tools/run-all.js
```

★ 换 adb 版本前先读一遍 `docs/HANDOFF.md` 里那条实测：
**内置 adb（37.0.1）跟已装的其它 adb 版本（如 MuMu 的 36.0.0）不会互相重启服务** ——
这台机器上测过，所以不必担心「抢方向盘」。换大版本后建议用真机再跑一次
「检查能不能发布」确认。
