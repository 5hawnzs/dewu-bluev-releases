# 得物蓝V素材发布工具 —— 已接入插件中心（网页分发）

> 2026-10-03 · 实测数字都在下面，无一处是推断。

## 一、地址

**https://6e5b9dc28eaf4ec4ad57303bc0f16039.app.workbuddy.host**

打开后最右边多了一个 **「蓝V发布」** tab，里面是《得物蓝V素材发布工具》的介绍 +
一个「下载最新版 v1.0.8」按钮（109 MB 的安装包就挂在这个站上）。

原来的插件中心（`3e2624b1…`）**没有动**，还在。两个地址现在并存。

## 二、新增的东西

| 位置 | 内容 |
|---|---|
| `dl/dewu-bluev-publisher-1.0.8-x64-win.exe` | 安装包本体，114 027 790 字节，sha256 `afe27d78…`（与 `dist/` 里那份、以及 `latest.yml` 记的 sha512 完全对得上） |
| `dl/bluev-version.json` | 版本文件：版本号 / 发布日期 / 下载文件名 / 更新日志。**页面打开时会自动拉它** —— 以后改版本只改这个文件，不用碰页面 |
| `index.html` | 加了一个插件条目 + 一个图标；另修了一处原有 bug（见第四节） |

页面上写的更新日志（1.0.6 / 1.0.7 / 1.0.8）都是从 git 的发版提交里抄的，没有编造。

## 三、实测：109 MB 真的能托管、能下载

| 检查 | 结果 |
|---|---|
| 整包下载 | **HTTP 200，114 027 790 字节，sha256 与本地逐字节一致** |
| 下载速度 | 10.1 s（约 11 MB/s）；第一次测是 6.9 s（15.8 MB/s） |
| 页面 / 配置文件 | `index.html`、`version.json`、`dl/bluev-version.json` 线上 sha256 **全部等于本地** |
| 浏览器实测 | 真实浏览器打开线上页 → 7 个 tab 全渲染 → 「蓝V发布」下载按钮 href = `dl/dewu-bluev-publisher-1.0.8-x64-win.exe` → 请求回来头两字节是 `MZ`（真的是 exe，不是 404 回落的 HTML） |
| 逐个 tab 审计 | 3 个有下载按钮的 tab（得物采集 / WPS / 蓝V发布）**地址全部指向真实文件，0 个打不开** |

截图：`得物蓝V-插件中心上线截图.png`

## 四、顺手修掉一个原有 bug（影响的是「得物采集助手」，不是新加的）

线上原页面里，**「得物采集助手」的「下载最新版」按钮是坏的**：

- 实测 URL：`version.json/dl/dewu-collector.zip` → 返回 **HTTP 200 但正文是首页 HTML**（不是 zip）
- 根因：页面里那段「用版本文件拼下载地址」的代码，
  `p.versionUrl.replace(/\/[^\/]*$/, '')` 对 **`version.json` 这种不带斜杠的路径不匹配**，
  整个文件名被留下，于是拼出了 `version.json/dl/…` 这种根本不存在的地址。
- 因为它走的是「路径不存在 ⇒ 回落到首页」这条规则，所以表面上还是 200，看不出错。

修法（两行）：只去掉文件名、留下目录，在站点根时目录为空串。

修完前后对照（同一个审计脚本，同一个线上地址）：

| tab | 修之前 | 修之后 |
|---|---|---|
| 得物采集助手 | `version.json/dl/dewu-collector.zip` → **HTML** | `dl/dewu-collector.zip` → **ZIP ✓** |
| WPS 表格工具箱 | 正常 | 正常 |
| 蓝V发布 | —（新加） | `dl/dewu-bluev-publisher-1.0.8-x64-win.exe` → **EXE ✓** |

## 五、以后怎么更新（重要）

**同一个本地目录再部署一次 → 地址不变。** 这一条我实测过：

> 目录 `E:\WORKBUDDY\2026-09-30-17-35-35\pluginhub-site` 连续部署两次，
> 返回的 sandboxId 都是 `6e5b9dc28eaf4ec4ad57303bc0f16039`（同一个网址）。

所以更新流程是：

1. 改 `E:\WORKBUDDY\2026-09-30-17-35-35\pluginhub-site` 里的文件
   （换新版 exe → 改 `dl/bluev-version.json` 里的 `latest` / `file` / `size` / `sha256` / `changelog`）
2. 重新部署这个目录
3. **链接不用换**，同事的收藏夹继续有效

★ 但 **原来那个 `3e2624b1…` 换不掉** —— 它是在**另一台机器**上部署的（源码是别人通过飞书发来的 zip），
本地没有它的工作目录，所以我没法往那个地址上更新。要让同事看到新页面，得把新链接发出去。

## 六、三个要提前知道的边界

1. **这是云沙箱，不是长期的服务器。** 我没有关于它寿命的官方口径，能说的只是：上次那个（9-29 部署的）
   到今天（10-3）还活着。要长期稳定或自定义域名，得换静态托管——产物就是这 7 个文件，随时能整体搬走。

2. **★ 不要把 App 的「自动更新源」指到这里（现在还不安全）。** 实测这个网关：
   - 不支持 Range 请求（带 `Range` 也返回 **200 + 整包**，没有 `Content-Range`）
   - `Content-Length` 被抹掉（`transfer-encoding: chunked`）
   - 前面是腾讯 EdgeOne CDN（`eo-cache-status`、`server: CloudStudio Gateway`）

   electron-updater 的差量下载（blockmap）要靠 Range 才能工作。所以「把更新源从 COS 换到这里」
   这条**我没有验证过、也不会替你下结论**——真要做得单独测一轮。

3. **拿到链接的人都能下。** 页面和安装包都是公开可读。要挡人只能在页面上加口令，挡不住直接访问 URL 的人。

## 七、文件都在哪

| 用途 | 路径 |
|---|---|
| **要部署的目录**（以后就改这里） | `E:\WORKBUDDY\2026-09-30-17-35-35\pluginhub-site\` |
| 我的工作副本（改之前先在这改） | `D:\work\_pluginhub\site\` |
| 打补丁的脚本（带锚点唯一性校验） | `D:\work\_pluginhub\patch-hub.py` |
| 逐 tab 审计下载地址 | `D:\work\_pluginhub\_hub-audit.js` |
| 线上内容/安装包核对 | `D:\work\_pluginhub\_hub-verify-online.js` |
| 改前的原页面备份 | `D:\work\_pluginhub\site\index.html.bak-7c4eb081` |

审计脚本用法（本地 / 线上都能跑）：

```bash
env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS HUB_URL=<地址> HUB_WAIT=10000 \
  "<仓库>/node_modules/electron/dist/electron.exe" --in-process-gpu --disable-gpu \
  D:/work/_pluginhub/_hub-audit.js
```
