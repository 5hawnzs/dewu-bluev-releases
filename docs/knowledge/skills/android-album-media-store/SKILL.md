---
name: android-album-media-store
description: 用 adb 判定并控制「Android 相册里到底能看到什么 / 排在第几格」——把判据从「文件系统/某个目录」换成 **MediaStore**，从而做到「App 里调出相册时只剩我要的那张/那支」以及「指定某张当封面（第一格）」。当出现「发布/上传时相册里混着别的素材，点错了图」「清了目录但相册里还有」「明明删了文件相册里还在转圈/黑格」「第三方 App 内嵌相册读的是哪儿」「相册里只有一条才算对」「封面/主图总是最后那张，改名字能不能让它排第一」这类需求时使用。含：为什么**只清一个目录不够**（内嵌相册是全盘聚合视图，实测把文件放进 /sdcard/Movies 也会出现在 App 相册里）、`content query`/`content delete` 的正确用法（按 `_id` 删，**不需要引号**）、为什么必须**删文件 + 删记录两半都做**（只删记录会被下一次 scan 复活、只删文件会留僵尸记录显示黑格）、App 正持解码句柄时 `rm` 报 `Text file busy` 而 `content delete` 仍能删记录、「清完必须用独立查询复查为空」的验证写法，以及**相册格子排序键的实测方法与结论**（只认 MediaStore `date_modified`、倒序；文件名与推送顺序都无关）。
agent_created: true
---

# 用 MediaStore（而不是文件系统）判定和控制 Android 相册

## 核心判断

**Android 的系统相册、以及第三方 App（得物/小红书/抖音…）内嵌的相册，读的都是 MediaStore。**

⇒ 所以：

| 你想表达 | 正确的判据 |
|---|---|
| 「相册里只有我要的那一条」 | **MediaStore 里没有别的记录** |
| 「清干净了」 | 复查 `content query` **四张表都为空** |
| ~~「目录清空了」~~ | ❌ 不成立 —— 目录空 ≠ 相册空 |

两条最容易踩的推论（都真机实测过）：

1. **内嵌相册是「全盘聚合视图」**：把一个 mp4 放进 `/sdcard/Movies`（**不在** `DCIM/Camera` 下），
   它照样出现在 App 相册里、和专属目录里的**并排显示**。
   ⇒ **只清 `DCIM/Camera` 这类"专属目录"根本不够**。
2. **`adb push` 不等于进相册**：文件到了设备上，但不写库 ⇒ App 相册里**看不到**它。
   必须 `content call --uri content://media/external/file --method scan_file --arg <全路径>`（或
   `--method scan_volume --arg external_primary`）。

## 正确的「清相册」做法（两半都要做）

```bash
# ① 列出记录（4 张表都扫：video / images / audio / files；files 表在部分机型不可查，单独容忍）
adb -s $S shell content query --uri content://media/external/video/media  --projection _id:_data
adb -s $S shell content query --uri content://media/external/images/media --projection _id:_data
# 输出形如：Row: 0 _id=363, _data=/storage/emulated/0/DCIM/Camera/bluev/x.mp4

# ② 先删物理文件（路径不含空格时才拼裸路径）—— 不删的话第 ③ 步之后会"复活"
adb -s $S shell rm -f /storage/emulated/0/Movies/x.mp4

# ③ 再按 _id 删记录（★ 完全不需要引号）
adb -s $S shell content delete --uri content://media/external/video/media/363

# ④ 让媒体库重新扫描，然后**复查**（这一步不做就等于没验收）
adb -s $S shell content call --uri content://media --method scan_volume --arg external_primary
adb -s $S shell content query --uri content://media/external/video/media --projection _id
```

**为什么必须两半都做：**

- **只删记录** ⇒ 物理文件还在 ⇒ 下一次任何 `scan_volume`（App 自己也会触发）把它**重新索引回来**。
- **只删文件** ⇒ 记录还在 ⇒ 相册里显示成**黑格/转圈**，点它报「暂不支持的视频格式」。

## App 正持着解码句柄时（最容易卡住的一种）

App 停在预览/编辑页、正在解码那个视频时：

| 命令 | 结果 |
|---|---|
| `rm -f <file>` | ❌ `Text file busy`（rc=1） |
| `rm -rf <dir>` / `rmdir <dir>` | ❌ `Text file busy` / `Directory not empty` |
| `find <dir> -mindepth 1 -delete` | ⚠️ **rc=0 却一个都没删**（静默假成功，最坑） |
| `am force-stop <pkg>` 之后再 `rm -f` | ✅ **rc=0，立刻删掉** |
| **`content delete --uri .../<id>`** | ✅ **照样删得掉记录**（相册里立刻看不到），但物理文件留下 |

⇒ 实操顺序：**先试 `content delete`**（能删记录就已经满足"相册里看不到"），
**要连物理文件一起清就 `am force-stop <pkg>` 后再 `rm -f`**。

★ 注意：**只有「进编辑页/预览页开始解码」才持句柄**。只停在相册列表页时**实测能删** ——
所以复现"删不掉"这个现象时，**必须先把素材点选进去**，否则永远复现不出来（会误判成"没有这个问题"）。

★ 另有一类**真 stale 句柄**（MuMu 模拟器的 sdcardfs/dentry 缓存损坏）：`am force-stop` 也解不开，
`rm`/`rmdir`/`mv` 全部失败、`stat` 却看着完全正常。**它不含文件 ⇒ 不影响相册**
（空目录不进 MediaStore）⇒ 判据看「还有没有**文件**」，不是「目录 listing 空不空」。
真要清掉只能**重启模拟器**。

## 格子顺序由什么决定：只认 `date_modified`，倒序（2026-10-05 实测）

「相册里第一格是哪张」= App 内嵌相册的**排序键**问题。**别猜、别信注释**，用下面这套控制实验一次定死。

### 实验方法（可复用）：让三个候选键互相矛盾

三个候选键：**文件名**、**入库/推送顺序（`date_added` / `_id`）**、**文件时间（`date_modified`）**。
造 4 张纯色图（红/绿/蓝/黄，截图里一眼可辨），然后：

```bash
# ① 推送顺序故意反着来：d → c → b → a （date_added 递增）
# ② 文件时间故意另排一序：b 最新 > c > a > d 最旧
adb -s $S push $LOCAL/d_yellow.jpg $R/d_yellow.jpg      # 依序 d, c, b, a
adb -s $S shell "touch -t 202610051225.00 $R/b_green.jpg; touch -t 202610051220.00 $R/c_blue.jpg; \
                 touch -t 202610051215.00 $R/a_red.jpg;  touch -t 202610051210.00 $R/d_yellow.jpg"
# ③ 再入库（★ touch 必须在 scan 之前）
adb -s $S shell "content call --uri content://media/external/file --method scan_file --arg '$R/<f>'"
# ④ 进 App 相册那一屏截图，看格子顺序（dump 常失败 ⇒ 直接 screencap 看图最稳）
```

三个键各自预测的首格都不同 ⇒ **看一次截图就能定出唯一解释**。
再补两步把因果钉死：**只改时间不重扫**（顺序应变而不变 ⇒ 读的是库缓存）→ **重扫**（顺序跟着变 ⇒ 闭环）。

### 结论（MuMu 12 / 得物 / 1080×1920）

| 观察 | 结果 |
|---|---|
| 文件名顺序 vs 相册顺序 | ❌ 无关（**没有任何命名能让它排第一格**） |
| 推送/入库顺序（`date_added`）vs 相册顺序 | ❌ 无关（`date_added` 未变，顺序照样跟着 `date_modified` 变） |
| **文件时间（`date_modified`）** | ✅ **就是它，倒序：时间最新 → 第 1 格** |
| 只改设备端文件 mtime、不重扫 | 顺序**纹丝不动** ⇒ App **不实时读文件系统**，读库里缓存值 |
| 改 mtime 后重扫 | 顺序**立刻跟着变** |

### 由此得到的两个硬约束（否则方案是错的）

1. **`touch` 必须发生在 `scan_file` 之前**。反过来（先入库再 touch）在界面上**不会生效**（实测）。
2. **不要改本地源文件/副本的 mtime 来达到目的**：同盘建副本常走**硬链接**（`fs.link`），
   改它会连**原图**一起改（同一个 inode）。要在设备端 `touch`。

### 顺带两条实测事实

- **`adb push` 会保留源文件的 mtime**（本地 `2020-01-02 03:04:05` 推上去设备端一模一样）
  ⇒ 设备端 mtime 的初始值来自源文件，不是推送时刻。
- **`date_modified` 是秒级**：要让 N 张图的顺序稳定，相邻时间档**至少隔 1 秒**。

### 让「指定的那张」排第 1 格（唯一可行做法）

命名 / 推送顺序都做不到（上表已证）。只有一条路：**让目标那张在库里的 `date_modified` 最大**。

```bash
# ① 先把整批都推上去（顺序随便）
for f in $FILES; do adb -s $S push "$f" "$R/$(basename $f)"; done
# ② 只对「要当第一格」的那张在设备端打一个最新的时间（★ 别动本地文件，硬链接会改原图）
adb -s $S shell "touch -t <比其它都新的时刻> '$R/<目标文件名>'"
# ③ 再统一入库（★ touch 必须在这之前；先扫后 touch 界面不生效）
for f in $ALL; do adb -s $S shell "content call --uri content://media/external/file --method scan_file --arg '$R/<f>'"; done
# ④ 复查单张的 date_modified 是不是最大 —— 别只看「扫过了」
adb -s $S shell "content query --uri content://media/external/images/media --projection _display_name:date_modified --where \"_display_name LIKE '%xxx%'\""
```

**用户不需要做任何手工动作**：命名只是给人看的输入，把「叫什么 = 当主图」翻译成设备端一次
`touch` 是**程序的活**。约定要落在代码里（谁去 touch、什么时候 touch），别写成「让用户自己改图片时间」。

### ★★ 「选哪张当第 1 格」的四类策略（别自己发明第五类）

机制解决「怎么让某张排第一」，剩下的是**规则**问题。可用的只有四类，按用户要付出的力气排：

1. **位置规则**（零操作）：取叶子内**第 1 张**（最早拍）或最后一张。实测：拍片习惯「正面先、背面后」时，
   原样取「最后一张」会把**背面图**推成主图；反过来取「第 1 张」立刻改观（3 个叶子 3/3 合格）。
2. **命名覆盖**（偶尔改 1 个名字）：名字含 `主图`/`封面`/`cover` 优先，没有则退回位置规则。
   ★ 算「用户要花多少力气」时**别按总张数算**——只需给出问题的那个叶子改 **1 张**。
3. **模型挑**（零操作，花钱）：每叶子送模型挑「正面/全身/露脸/无遮挡」。必须**先检测模型的图片输入能力**，
   不支持就**明说**，不许静默降级成规则。
4. **发布前肉眼核验**（看一眼）：预览将要用的主图缩略图，人工拦最后一道。

★ **拿实测数字否掉的方案**：按「文件大小 / 分辨率 / 竖构图」自动挑 —— 实测同一叶子里
正面与背面**体积几乎一样**（5.1MB vs 6.0MB、12.9MB vs 13.2MB），**区分不出来**；没有人脸检测就别声称能判背面。

## 验证：必须用「独立于被测逻辑的查询」复查

写断言时**别**只看自己那个函数返回的 `ok`。实测过一个反例：把清理范围从「全盘」退回
「只清 DCIM/Camera」之后，函数返回的 `ok` **仍然是 `true`**（因为它的复查被同一个 bug 带偏了），
只有**另外写一句 `content query` 直接数库**才发现还剩 1 条。

⇒ 断言 = **直接数库**（`content query ... --projection _id` 数行数），而不是读返回值。

## 编码/命令坑

- `adb shell` 的多个参数会**在设备端再被 shell 解析一次** ⇒ **别往里面塞引号**（会被吃掉）；
  按 `_id` 删天然不需要引号，这也是选它的理由之一。
- `--arg` 给路径时用 **`/storage/emulated/0/...` 全路径**，给 `/sdcard/...` 会拿到空 STREAM（实测）。
- MediaStore 里同一个文件可能记成 `/sdcard/...` 也可能记成 `/storage/emulated/0/...`
  ⇒ 比路径前缀时**两种都要认**。

## 配套回归怎么写

1. **正向**：库里放两条（一条在"专属目录"、一条在**别处**）⇒ 清完**独立数库 = 0**。
2. **反向对照**：没被 App 占着时**一次都不许 `force-stop`**（乱停会把用户正在用的 App 关掉）。
3. **空库**：直接判干净、`removed = 0`、不许无脑强停。
4. **夹具要贴真机语义**：记录 id 必须**稳定**（真机 `_id` 是主键，删一条不会改别人的号）。
   夹具若用「下标 + 100」当 id，删中间一条会让后面全部改号 ⇒ 「按 _id 逐条删」在回归里
   **只能删掉一条、剩下全假绿**。
