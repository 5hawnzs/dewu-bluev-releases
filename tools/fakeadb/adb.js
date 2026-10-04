'use strict';
/**
 * 假 adb（跨平台）：在 child_process.execFile 这一层做替身，模拟一台在线设备，
 * 并把每次调用按「整条 argv 用空格连接」记进 <dir>/calls.log，用来验证驱动的指令序列。
 *
 * 为什么不沿用「往 PATH 里塞一个假 adb 可执行文件」的老做法（原 tools/fakeadb/adb 是 bash 脚本）：
 *   ① Windows 的 PATH 分隔符是 ';'（path.delimiter），写死 ':' 拼出来的目录根本进不了 PATH；
 *   ② Windows 的 execFile('adb') 只认 adb.exe —— CreateProcess 对无扩展名的名字只会补 .exe，
 *      认不出无扩展名的 bash 脚本（实测 .cmd/.bat 同样 ENOENT）。
 *      而造一个真的 adb.exe 需要编译器 + 把二进制提进仓库，代价与可维护性都不划算。
 * 所以改成在 Node 这一层替换函数：两端行为完全一致，也不再依赖 shell、可执行位或 PATH。
 * 注意：adb.js 在**加载时**就解构了 execFile，因此必须在 require 被测模块之前完成替换。
 *
 * 现场开关（在 dir 里放文件即可，测完删掉）：
 *   MEDIA_LAG      —— content query 假装还没索引到（测「等媒体库索引」）
 *   DUMP_NOT_IDLE  —— uiautomator dump 报 ERROR: could not get idle state.
 *                     文件内容含 'always' → 关动画也救不了（只能失败）；
 *                     否则 → 只在系统动画开着（animator_duration_scale != 0）时失败，
 *                     关掉动画就能成功 —— 对齐真机实测到的行为。
 *   IME_INSTALL_FAIL —— `adb install` 报 Failure（测「装中文输入法失败」时要说清卡在哪一步）
 *   IME_ACTIVE       —— 假装「ADBKeyboard 已装进模拟器且是当前输入法」。**不建这个文件**就是
 *                       全新模拟器的样子（装了 apk 但没启用）——中文输入在这两种状态下行为完全不同，
 *                       必须两种都测（见 src/main/services/adb.js#inputText 的注释）。
 *   FOCUS            —— 假装**前台停在哪一屏**（`dumpsys window | grep mCurrentFocus` 的返回值）。
 *                       文件里写什么 activity 就是什么；写成 '-' 就假装这一行**读不到**。
 *                       文件不存在时默认给「得物发布页」，这样既有用例不受影响。
 *                       用途：验「抓取页面结构」会先说清停在哪一屏、停在别的 App 上会拦下来。
 *   （2026-10-03 起）落地确认 `[ -f 'x' ]` 的回答 = 「这个文件有没有被真实 push 过」，
 *                     用来测「推完当场确认文件在不在」这条新路径。
 *   MULTI_PORT        —— `adb devices` 把同一台设备按 16384 / 5555 / 7555 报三次（真机 MuMu 12 原样）。
 *   NO_ANDROID_ID     —— android_id 读不出来（测「读不到身份就不许合并」）。
 *   NO_DEWU_TOP     —— `dumpsys activity top` 返回一份**不含得物**的层级（其它 App 的）。
 *                       用途：验「uiautomator 与 dumpsys 都没抓到」时的报错文案。
 *   DIR_STALE        —— 受管相册目录处于 `Text file busy` 的 stale 句柄状态：
 *                       `find -delete` / `rm -rf` / `rmdir` 全删不掉，只有 `mv` 改名能过。
 *                       用途：验「清不动时必须走 mv 换名法，而不是原地死磕」。
 *   DIR_UNREADABLE   —— `ls -A` 回 Permission denied（读不到 ≠ 空）：
 *                       用途：验「目录读不出来时绝不判成干净」。
 *   DIR_EMPTY_STUBBORN —— 内容写数字 N：摆出 N 个**顽固空目录残骸**（rm/mv 都不生效，
 *                       但 `find -type f` = 空）。用途：验「空残骸不算失败、只记 note、
 *                       且不再累积」这条判据（真机上那批 255 字符垃圾目录的形态）。
 *
 * 受管相册目录（清相册那一步会碰的两个）：`/sdcard/DCIM/Camera`（相册根）与
 * `/sdcard/DCIM/Camera/bluev`（专属目录）；断言侧读 `fakeExec.__dirs[<路径>]`。
 *
 * `dumpsys activity top` 走的是同目录下的 activity-top.txt 夹具（真机数据，110 个可见节点）。
 *
 * 另外它接受**绝对路径**的可执行名（只要 basename 是 adb / adb.exe）——
 * 因为内置 adb 走的是 `resources/adb/adb.exe` 这种绝对路径，替身不能只认字符串 'adb'。
 */
const fs = require('fs');
const path = require('path');

/** @param {string} dir 现场目录（至少要含 window.xml 与 shot.png 两个夹具） */
function makeFakeAdb(dir) {
  const CALLS = path.join(dir, 'calls.log');
  // 实际被执行的「可执行文件」逐个记下来（calls.log 只记 argv）。
  // 用来证明「留空 adb 路径时，真的去执行了内置的那份 resources/adb/adb.exe」。
  const FILES = path.join(dir, 'files.log');
  // ★ 2026-10-04：设备端 `am broadcast --es msg "…"` **真正收到的字符串**（按 sh 双引号语义解出来）。
  //   用途：回归里断言「设备收到的字 == 源文一字不差」——这是「文案原样贴进去」唯一硬证据。
  const BROADCAST_LOG = path.join(dir, 'broadcasts.log');
  const WINDOW_XML = path.join(dir, 'window.xml');
  const SHOT_PNG = path.join(dir, 'shot.png');
  const NOT_IDLE_FLAG = path.join(dir, 'DUMP_NOT_IDLE');
  // ★ 2026-10-03 真机实测的另一种症状：得物发布页首屏的 uiautomator
  //   有时**一个字都不打印**（不是 could not get idle state）。
  //   建 DUMP_SILENT 文件 → 系统动画还开着时返回**空输出**；关掉动画就成功（同真机）。
  const SILENT_FLAG = path.join(dir, 'DUMP_SILENT');
  // ★ 2026-10-04：模拟「设备上没有 `timeout`」（老的 / 精简过的系统）。
  //   真机 sh 会打印 not found、命令根本不执行 ⇒ 用来验「这种情况也要照旧走关动画回退」。
  const NO_TIMEOUT_FLAG = path.join(dir, 'DUMP_NO_TIMEOUT');
  // `dumpsys activity top` 的夹具 = 真机抓下来的得物发布页 View Hierarchy
  //（前面**故意**垫了两段别的 App，用来证明过滤是按包名做的，不是「取第一段」）。
  // 现场开关：建 NO_DEWU_TOP 文件 → 返回一份**不含得物**的输出（测「备用通道也没抓到」）。
  const TOP_DUMP = path.join(dir, 'activity-top.txt');
  const TOP_NO_DEWU = path.join(dir, 'NO_DEWU_TOP');

  const read = (p, fallback) => { try { return fs.readFileSync(p); } catch (e) { return fallback; } };

  // 「设备上已经推送过去的文件」：真实 push 到哪个远端路径就记哪个。
  const pushed = [];
  // ★ 2026-10-03 新增：「真的进了媒体库」的文件。
  //   真机上 push ≠ 进库 —— 必须再调 `content call ... scan_file/scan_volume` 才会进
  //   （实测：不调的话得物相册里根本看不到这个文件）。所以 content query 只回 scanned、
  //   不回 pushed —— 否则「扫描没生效」这种情况永远测不出来（恒绿）。
  const scanned = [];
  // ★★ 2026-10-04：给每条进库的记录分配一个**稳定 id**。
  //   真机 MediaStore 的 `_id` 是主键 —— 删掉一条**不会**让别的记录改号。
  //   老夹具拿「下标 + 100」当 id ⇒ 删掉中间一条会让后面所有记录改号，于是
  //   「按 _id 逐条删」这种写法在回归里**只能删掉一条、剩下的全部假绿**
  //   （clearAlbum 正是逐条删的，所以这条必须修）。
  let nextMediaId = 100;
  const mediaIds = new Map();               // 路径 -> _id
  const mediaIdOf = p => {
    const key = String(p);
    if (!mediaIds.has(key)) mediaIds.set(key, nextMediaId++);
    return mediaIds.get(key);
  };
  // 现场开关 SCAN_FAIL：假装媒体扫描**没生效**（scan_file 回空 STREAM、scan_volume 不回填）
  //   —— 用来验「扫描失败时必须靠进库确认兜底，且最终如实失败」。
  const SCAN_FAIL = path.join(dir, 'SCAN_FAIL');

  // 设备上的「文件」：只需模拟 dump 用到的那个路径。
  // 关键语义（真机实测）：uiautomator dump **成功才写文件**；失败时目标文件一字不动。
  // 所以失败时若不清掉旧文件，cat 出来的就是**上一个页面**的结构。
  const devFiles = new Map();

  // ★★ 2026-10-04 新增：模拟「受管相册目录」的真实文件系统语义。
  //   为什么必须加：清相册那一步（adb.js#clearMediaDir）走的是
  //     `find <dir> -mindepth 1 -delete` / `rm -rf <dir>/*` / `ls -A <dir>` /
  //     `find <dir> -type f` / `ls -d <child>` / `rmdir <child>` / `mv <dir> <trash>`
  //   这一套。旧夹具只认 `rm -f`，其余一律回空 ⇒ 清目录在回归里变成**空操作**、
  //   无论代码写得多烂都全绿（典型假绿）。这里把这几个命令的语义补上，才算真测到。
  //
  //   ★★★ 2026-10-04（第四十轮）**推广成通用受管目录表**（原来只认 bluev 一个）：
  //     产品现在会清**两个**目录 —— 专属目录 `DCIM/Camera/bluev` 与**相册根**
  //     `DCIM/Camera`（用户口径「清空整个 DCIM/Camera」）。只模拟 bluev ⇒
  //     「清 Camera 根」那条分支在回归里**根本没被跑到**（等于没测）。
  //     ⇒ 建立 `dirs` 表：每个受管路径一份 {exists, files, renames} 状态，命令按路径分发。
  //       子目录走 `ls -d` 判「还在不在」；父目录的 `ls -A` **不能自动列出子目录**，
  //       只列出显式塞进 `files` 的顽固残骸 —— 这样「根目录还有空残骸」这个现场才摆得出来。
  //
  //   现场开关（建文件即生效）：
  //     DIR_STALE           —— `Text file busy` 的 stale 句柄状态：`find -delete` / `rm -rf`
  //                            都**删不掉**，只有 `mv` 改名 / `ls` 能过。
  //                            验「清不动时必须走 mv 换名法，而不是原地死磕」。
  //     DIR_EMPTY_STUBBORN  —— **顽固空目录**：它 rm 不掉、mv 也不生效（stale 句柄跟着 inode
  //                            走，改名照样锁着），但 `find <it> -type f` = 空。
  //                            这正是真机上那批「255 字符空垃圾目录」的形态 ⇒ 用来验
  //                            「空目录残骸**不算失败**、只记 note、且**不再累积**」这条新判据。
  //   语义细节（对齐真机，2026-10-04 实测）：
  //     · 目录不存在   → `ls -A` 回 `ls: <dir>: No such file or directory`（code 1）
  //     · 目录存在且空 → `ls -A` 回空、code 0
  //     · 有残留       → `ls -A` 逐行列出
  //     · stale 时     → find/rm 删不掉内容，`mv` 成功（这是 mv 换名法成立的根据）
  const DIR_STALE = path.join(dir, 'DIR_STALE');
  // 现场开关 DIR_UNREADABLE：`ls -A <dir>` 回**非 missing 的失败**（权限拒绝之类）。
  //   用途：证明「读不到目录时**不许**判成干净」——
  //     目录不存在（No such file）与「读不出来」（Permission denied）是两回事：
  //       · 前者 ⇒ 本来就没有 ⇒ 干净；
  //       · 后者 ⇒ **不知道里面有什么** ⇒ 必须如实报错，绝不能放过（放过去 = 假装清干净了）。
  const DIR_UNREADABLE = path.join(dir, 'DIR_UNREADABLE');
  // 现场开关 DIR_EMPTY_STUBBORN 的取值 = 要摆出几个「顽固空残骸」（缺省 0 = 不开）。
  const STUBBORN_FLAG = path.join(dir, 'DIR_EMPTY_STUBBORN');
  const stubbornN = () => {
    if (!fs.existsSync(STUBBORN_FLAG)) return 0;
    const v = parseInt(read(STUBBORN_FLAG, Buffer.from('1')).toString('utf8').trim(), 10);
    return Number.isFinite(v) && v > 0 ? v : 1;
  };
  // ★★★ 2026-10-04 新增现场开关 **DIR_LOCKED_BY_APP**：锁在**得物进程自己**手里那种。
  //   真机形态（本轮实测，用户报「第 2/3 篇直接提示没能清干净」的真因）：
  //     得物停在发布页 / 相册页时，它**正拿着这批 mp4 的硬解码句柄** ⇒
  //       `rm` / `find -mindepth 1 -delete` / `rmdir` / `mv` **全失败**（Text file busy /
  //       Operation not permitted），而 `am force-stop com.shizhuang.duapp` 之后**同一句立刻成功**。
  //   ★★ 为什么必须与 DIR_STALE **分开摆**（不能合并成一个开关）：
  //     DIR_STALE 模拟的是 MuMu sdcardfs 留下的**真 stale 句柄**（跟一个已经消失的 inode 走）——
  //     那种 **force-stop 也解不开**。两类现象长得一模一样（都是 Text file busy），但解法不同：
  //       · 锁在 App 里   ⇒ 强停得物再删就过了（不该去造 trash 残骸）；
  //       · 真 stale 句柄 ⇒ 只能 mv 换名绕开。
  //     产品代码两手都留着（先强停、过不了再换名）⇒ 回归里也必须两类都有，
  //     否则「先强停」这一手被删掉、或「换名」那一手被删掉，都测不出来。
  const DIR_LOCKED_BY_APP = path.join(dir, 'DIR_LOCKED_BY_APP');
  let appStopped = false;   // 被 `am force-stop <得物>` 过 ⇒ 它进程里的句柄一起被系统收走
  const appLocked = () => fs.existsSync(DIR_LOCKED_BY_APP) && !appStopped;
  const appStops = [];      // 真的被执行过的 force-stop 包名（断言要用它证明「确实停了得物」）
  // ★★ 2026-10-04 新增现场开关 **TAP_FOCUS**：**点完之后前台落到哪一屏**
  //   （模拟得物对这次提交的真实反应）。内容取值（缺省 = publish）：
  //     · `publish` —— 还停在发布流程里（＝没发出去：得物压根没受理，或提交那步被跳过了）；
  //     · `draft`   —— 落到**草稿箱**（＝这条被存成草稿了；用户原话「我什么时候跟你说真实发布环境可以存草稿的」）；
  //     · `leave`   —— 离开发布流程、回到个人主页（＝这次**真的**提交出去了）。
  //   用途：验用户口径「**发出去了才算成功**」—— 只有 leave 能算成功，另两种必须记失败，
  //   而且必须**把得物强停掉**（不然那条草稿会一直留在「草稿箱」里）。
  const TAP_FOCUS = path.join(dir, 'TAP_FOCUS');
  const PUB_FOCUS = 'com.shizhuang.duapp/media.publish.activity.TotalPublishProcessActivity';
  const DRAFT_FOCUS = 'com.shizhuang.duapp/media.activity.DraftActivity';
  const PROFILE_FOCUS = 'com.shizhuang.duapp/.modules.user.ui.MyActivity';

  // 受管目录的规范路径（命令里可能出现 /sdcard/... 或 /storage/emulated/0/... 两种写法）
  const CAMERA = '/sdcard/DCIM/Camera';
  const BLUEV = CAMERA + '/bluev';
  const toCmp = p => norm(p).replace(/^\/storage\/emulated\/0\//, '/sdcard/');
  const DIRS = [CAMERA, BLUEV];
  const newDirState = () => ({ exists: false, files: [], renames: [] });
  const dirs = {};
  DIRS.forEach(d => { dirs[d] = newDirState(); });
  // 把命令里的路径统一成 /sdcard/... 形式，好和受管路径比
  const norm = p => String(p || '').trim().replace(/\/+$/, '');
  /** 路径命中的受管目录规范名；不是受管路径 ⇒ null */
  const whichDir = p => {
    const c = toCmp(p);
    return DIRS.find(d => c === d) || null;
  };
  /** 内容夹具：用推到过这个目录的 pushed 文件 + 显式塞进 files 的顽固名 */
  const filesOf = (d) => pushed.filter(p => toCmp(p).indexOf(d + '/') === 0)
    .map(p => toCmp(p).slice(d.length + 1)).concat(dirs[d].files);
  // 兼容旧名字（D 组断言直接读 fakeExec.__bluevDir / __bluevDirPath）
  const dirState = dirs[BLUEV];
  const bluevFiles = () => filesOf(BLUEV);

  // 系统动画开关的初值（真机默认都是 1）
  const anim = { window_animation_scale: '1', transition_animation_scale: '1', animator_duration_scale: '1' };

  // 设备上的输入法状态：全新模拟器**没有**启用 ADBKeyboard —— 用来测「装了没启用」这条分支
  const ime = { default: 'com.android.internal/.Default', enabled: [] };
  // 现场开关 IME_ACTIVE：模拟「已经把 ADBKeyboard 装进模拟器并设为当前输入法」。
  // 建了这个文件 → default_input_method 直接回 ADBKeyboard，且 ime list -s 里也有它。
  // ★ 为什么一定要有这个开关：中文输入能不能成功**只取决于设备的当前输入法**，
  //   跟「apk 有没有打进安装包」是两件事（见 adb.js#inputText 的注释）。
  const IME_AUTO = 'com.android.adbkeyboard/.AdbIME';
  // ★ 2026-10-03 设备身份：真机实测 MuMu 12 会把**同一台模拟器**在 16384 / 5555 / 7555
  //   三个端口上各报一次，三者 `settings get secure android_id` 完全相同（本机 927145746ae845d6）、
  //   /proc/uptime 也一致 ⇒ 是同一台。下面两个开关用来验「设备列表按身份去重」：
  //   MULTI_PORT     —— `adb devices` 返回同一台设备的三个端口
  //   NO_ANDROID_ID  —— android_id 读不出来（这时**不许**合并，宁可多列）
  const MULTI_FLAG = path.join(dir, 'MULTI_PORT');
  const NOID_FLAG = path.join(dir, 'NO_ANDROID_ID');
  const DEV_ANDROID_ID = '927145746ae845d6';
  const imeReady = () => fs.existsSync(path.join(dir, 'IME_ACTIVE'));
  const imeList = () => (imeReady() && !ime.enabled.includes(IME_AUTO) ? [IME_AUTO] : []).concat(ime.enabled);

  const okOut = out => ({ out: out == null ? '' : out, code: 0 });
  const fail = msg => ({ out: msg + '\n', code: 1 });

  /** 处理**一条** shell 子命令（adb shell 里用 ';' 串起来的多条会逐个进来） */
  function shellSub(sub) {
    // ★ 2026-10-03 夹具修正：真机上 `cmd 2>&1` / `cmd >/dev/null` 里的**重定向不属于命令本身**。
    //   原来不剥 ⇒ `uiautomator dump X 2>&1` 用 split().pop() 取「输出文件」取到了 `2>&1`
    //   （把结构写进一个叫 2>&1 的文件），接着 `cat X 2>&1` 又去 cat 一个叫 `2>&1` 的文件
    //   ⇒ 只要上游把「抓屏 + 回传」合并成一条 shell，整条链路就全部认不出来（adbtest 一次挂 35 条）。
    let cmd = sub.trim()
      .replace(/\s*\d?>&\s*\d+/g, '')
      .replace(/\s*\d?>\s*\/dev\/null/g, '')
      .trim();
    // ★ 2026-10-04：模拟「设备上没有 `timeout`」——真机 sh 会打印 not found、命令根本不执行。
    //   用来证明「没有 timeout 的老设备」上行为退回改之前（照旧走关动画回退），
    //   **不会**被误判成「这一屏抓到了、只是读不出内容」而跳过回退。
    if (/^timeout\s+\d+\s+/.test(cmd) && fs.existsSync(NO_TIMEOUT_FLAG)) {
      return okOut('/system/bin/sh: timeout: inaccessible or not found\n');
    }
    // ★ 2026-10-04：真机上给裸 dump 加了 `timeout <秒>` 上限（超时被杀 ⇒ 当"没抓到"）。
    //   夹具必须认这个前缀，否则 `/^uiautomator dump /` 匹配不上 ⇒ 整条抓屏链路变空操作
    //   （那是**假绿**：测试全过，真机上却什么都没抓）。
    //   夹具里 uiautomator dump 是立即返回的，谈不上超时；「被杀」的症状由 DUMP_SILENT
    //   （空输出、关动画后成功）如实复现 —— 与真机 timeout 杀进程后的可观测结果一致。
    cmd = cmd.replace(/^timeout\s+\d+\s+/, '').trim();
    if (!cmd) return okOut('');
    // 真 sh 的 echo：合并抓屏那条命令里用它当中段分隔标记
    if (/^echo\b/.test(cmd)) return okOut(cmd.replace(/^echo\s*/, '') + '\n');
    if (cmd === 'wm size') return okOut('Physical size: 1080x2400\n');
    if (cmd === 'input') return okOut('usage: input [<source>] <command>\n');
    // ★★ 2026-10-04 新增：定位表里的 tapXY / tapId 最终都落到 `input tap`。
    //   现场开关 TAP_FOCUS：点完之后前台落到哪一屏（publish / draft / leave，见文件顶部说明）。
    //   真机形态就是用户口径「发出去了才算成功」要防的那两种：得物没受理（还停在发布流程里）、
    //   或把它**当草稿存了**。用途：验「这两种必须记失败 + 强制关掉得物清草稿」。
    if (/^input (tap|keyevent|text) /.test(cmd)) {
      if (fs.existsSync(TAP_FOCUS)) {
        const v = read(TAP_FOCUS, Buffer.from('')).toString('utf8').trim();
        const to = /draft/i.test(v) ? DRAFT_FOCUS : (/leave/i.test(v) ? PROFILE_FOCUS : PUB_FOCUS);
        fs.writeFileSync(path.join(dir, 'FOCUS'), to);
      }
      return okOut('');
    }
    // ★★ 2026-10-04 修正（推翻了我上一轮**自己编出来**的「行首 # 会让命令炸」）：
    //   真机逐条实验 12 组（MuMu 12 / Android 12 / 内置 adb）——
    //     `"a\n#TW"` / `"a\n##TW"` / `"a\n\`b"` / `"a #TW"` / `"a\n #TW"` / `"a\n$X"` /
    //     `"a\n;b"` / `"a\n&b"` / `"a\n\\b"` —— **一次 `no closing quote` 都没有**，行首 `#` 照发。
    //   旧夹具里那条「行首 #/反引号 ⇒ no closing quote」判据是**我自己定的**，它和当时的
    //   「转义修法」互相印证，把假 bug 喂成了「已修复」，代价是**真的把反斜杠写进了正文**
    //   （真机 dump 出来是 `\#TW男装`）。⇒ 夹具**不得**再复现那个不存在的症状。
    //   改为**如实模拟 sh 的双引号语义**，把设备端真正收到的串记下来：
    //     sh 双引号内真正的转义只有 `\"` `` \` `` `\$` `\\` 和「反斜杠+换行」；
    //     其余反斜杠**原样保留** —— 这正是「把 `#` 写成 `\#` 会污染正文」的机制。
    //   ⇒ 回归据此断言「设备收到的字 == 源文一字不差」，谁再往文案里塞反斜杠都会红。
    if (/^am broadcast /.test(cmd)) {
      // ★★★ 2026-10-04 新增：ADBKeyboard 的**第二条输入通道** `ADB_INPUT_B64`。
      //   产品把**非 ASCII**（中文 / emoji / 含空格或引号的文案）一律走这条 —— 传的是原始
      //   UTF-8 字节的 base64，字母表只有 A-Za-z0-9+/=（没有空格 / 引号 / $ / 反引号 / 换行）
      //   ⇒ 设备端 sh 再怎么解析引号都坏不了；空格与 emoji 全部原样进去。
      //   判据来源（真机实测，不是推理）：MuMu 12 + 内置 ADBKeyboard v2.0 跑「5 轮 × 3 条」时，
      //   标题「酒红调长袖T恤 氛围感拉满🍷」经 B64 打进发布页后，uiautomator dump **回读**
      //   `etTitle` 得到的就是原串一字不差（含那个空格与 emoji）。
      //   ⇒ 夹具里「设备收到的字」= **base64 解码后的 UTF-8 串**。
      if (/-a\s+ADB_INPUT_B64\b/.test(cmd)) {
        const mB = /--es msg\s+([^\s"]+)\s*$/.exec(cmd);
        // 如实：不是合法 base64（含非法字符）⇒ 设备端一个字都收不到（不记）。
        if (mB && /^[A-Za-z0-9+/]+={0,2}$/.test(mB[1])) {
          let delivered = '';
          try { delivered = Buffer.from(mB[1], 'base64').toString('utf8'); } catch (e) { delivered = ''; }
          try { fs.appendFileSync(BROADCAST_LOG, JSON.stringify(delivered) + '\n'); } catch (e) {}
        }
        return okOut('Broadcast completed: result=0\n');
      }
      const mm = /--es msg "([\s\S]*)"$/.exec(cmd);
      if (mm) {
        const delivered = mm[1].replace(/\\(["`$\\])/g, '$1').replace(/\\\n/g, '');
        try { fs.appendFileSync(BROADCAST_LOG, JSON.stringify(delivered) + '\n'); } catch (e) {}
      }
      return okOut('Broadcast completed: result=0\n');
    }
    if (/^rm -f /.test(cmd)) {
      cmd.split(/\s+/).slice(2).forEach(p => devFiles.delete(p));
      return okOut('');
    }
    // ★★ 2026-10-04 新增：专属相册目录的真实语义（清相册那一步用的就是这些命令）。
    //   顺序有讲究：先判 `ls` 系列（最简单、最常调），再判 find / rm -rf / mv。
    // ★ 注意：真机上 MediaStore/磁盘路径有两种写法（/sdcard/... 与 /storage/emulated/0/...），
    //   产品代码发出来的正是后者 ⇒ 判断**不能用字面 indexOf(BLUEV)**（那样永远匹配不上，
    //   mv 分支就成了死代码，测试会误以为「代码没走换名法」）。统一走 toCmp 后比较。
    const hasBluev = (...ps) => ps.some(p => {
      const n = toCmp(p);
      return n === BLUEV || n.indexOf(BLUEV + '/') === 0;
    });

    if (/^ls -A /.test(cmd)) {
      const target = cmd.replace(/^ls -A\s+/, '').trim();
      const d = whichDir(target);
      if (!d) return fail('ls: ' + target + ': No such file or directory');
      if (fs.existsSync(DIR_UNREADABLE)) return fail('ls: ' + target + ': Permission denied');
      const st = dirs[d];
      if (!st.exists) return fail('ls: ' + target + ': No such file or directory');
      const list = filesOf(d).concat(st.pending || []);
      return okOut(list.join('\n') + (list.length ? '\n' : ''));
    }
    // ★★ `ls -d <child>`：代码用来判「这个子项删掉了没有」。真机语义：存在 ⇒ 回显路径、code 0；
    //   不存在 ⇒ `No such file or directory`、code 1（非 0）。两者**都必须有回显可判**。
    //   ★ 子项可以是受管目录的**任意直接子级**（例：`DCIM/Camera/X_gone_…`），
    //     所以判据 = 「父目录是受管目录 且 这个名字在它的残留清单里」。
    if (/^ls -d /.test(cmd)) {
      const target = cmd.replace(/^ls -d\s+/, '').replace(/\s+2>\S+$/, '').trim();
      const d = whichDir(target);
      if (d) {
        if (!dirs[d].exists) return fail('ls: ' + target + ': No such file or directory');
        return okOut(target + '\n');
      }
      const c = toCmp(target);
      const slash = c.lastIndexOf('/');
      const parent = slash > 0 ? c.slice(0, slash) : '';
      const name = c.slice(slash + 1);
      if (parent && dirs[parent] && dirs[parent].exists && filesOf(parent).includes(name)) {
        return okOut(target + '\n');
      }
      return fail('ls: ' + target + ': No such file or directory');
    }
    if (/^mkdir -p /.test(cmd)) {
      const target = cmd.replace(/^mkdir -p\s+/, '').trim();
      const d = whichDir(target);
      if (d) { dirs[d].exists = true; dirs[d].pending = []; }
      return okOut('');
    }
    // ★★ 受管目录的**直接子级**解析（清相册「逐个子项处理」那条退路会用到）：
    //   父目录是受管目录、且这个名字在它的残留清单里 ⇒ 返回 {parent, name}；否则 null。
    //   文件 vs 目录：名字带媒体后缀 = 文件（`find -type f` 看得见）；不带 = 空目录残骸。
    const childOf = (p) => {
      const c = toCmp(p);
      const slash = c.lastIndexOf('/');
      const parent = slash > 0 ? c.slice(0, slash) : '';
      const name = c.slice(slash + 1);
      if (parent && dirs[parent] && dirs[parent].exists && filesOf(parent).includes(name)) {
        return { parent, name };
      }
      return null;
    };
    const isFile = (name) => /\.(mp4|jpg|jpeg|png|mov|gif|avi|webp|mp3|wav)$/i.test(name);
    /** 从一个受管目录里移除某个子项（含 pushed 里对应的整条路径） */
    const dropChild = (parent, name) => {
      const idx = dirs[parent].files.indexOf(name);
      if (idx >= 0) dirs[parent].files.splice(idx, 1);
      for (let i = pushed.length - 1; i >= 0; i--) {
        if (toCmp(pushed[i]) === parent + '/' + name) pushed.splice(i, 1);
      }
    };
    // ★★ `find <dir> -type f`：递归找**文件**（用来判「相册里还有没有素材」）。
    //   真机语义：目录不存在 ⇒ find 回非 0（stderr 有 No such file），stdout 空。
    //   ★ 产品代码结尾处只拿 stdout 当判据 ⇒ 这里**必须保证**「空目录残骸」时 stdout 一定是空，
    //     否则「空残骸放行」这条断言会假红。
    if (/^find .* -type f/.test(cmd)) {
      const target = cmd.replace(/^find\s+(\S+).*$/, '$1').trim();
      const d = whichDir(target);
      if (d) {
        const st = dirs[d];
        if (!st.exists) return fail('find: ' + target + ': No such file or directory');
        const files = pushed.filter(p => toCmp(p).indexOf(d + '/') === 0)
          .map(p => toCmp(p)).concat(
            st.files.filter(f => isFile(f)).map(f => d + '/' + f));
        return okOut(files.join('\n') + (files.length ? '\n' : ''));
      }
      // 子级：`find <child> -type f` —— 名字是文件 ⇒ 回显它自己；是空目录残骸 ⇒ 空
      const ch = childOf(target);
      if (ch) {
        return okOut(isFile(ch.name) ? toCmp(target) + '\n' : '');
      }
      return fail('find: ' + target + ': No such file or directory');
    }
    if (/^find .* -mindepth 1 -delete/.test(cmd)) {
      const target = cmd.replace(/^find\s+(\S+).*$/, '$1').trim();
      const d = whichDir(target);
      if (!d) return okOut('');
      if (fs.existsSync(DIR_STALE) || appLocked()) {
        // stale 句柄 / 锁在 App 进程里：删不掉，如实报 Text file busy（真机原话）
        return fail('rm: ' + target + ': Text file busy');
      }
      // ★★ 顽固空残骸现场：`find -delete` **删不掉目录**（能删文件，但残骸目录留着）。
      //   真机实测那批 255 字符垃圾目录就是这样：目录本身永远在、里面一个文件都没有。
      //   所以这里**清掉真文件、保留残骸名**，并如实报错（非零）——
      //   产品代码只看 stdout 判「还有没有残留」，不因 rc 而崩。
      if (stubbornN() > 0) {
        // ★ 关键：只清掉**真文件**，把残骸名**原样留着**（真机上它们就在那儿、删不掉）。
        dirs[d].files = dirs[d].files.filter(f => !isFile(f));
        for (let i = pushed.length - 1; i >= 0; i--) {
          if (toCmp(pushed[i]).indexOf(d + '/') === 0) pushed.splice(i, 1);
        }
        return fail('rm: ' + target + '/X_gone_...: Device or resource busy');
      }
      dirs[d].files = [];
      dirs[d].pending = [];
      for (let i = pushed.length - 1; i >= 0; i--) {
        if (toCmp(pushed[i]).indexOf(d + '/') === 0) pushed.splice(i, 1);
      }
      return okOut('');
    }
    if (/^rm -rf /.test(cmd)) {
      // ★ 判据必须用 whichDir（规范路径比较），不能用字面 indexOf('Camera/bluev') ——
      //   产品发的是 /storage/emulated/0/... 写法，字面比永远匹配不上（假绿源头）。
      // ★★ 逐子项退路会发 `rm -rf <child>`（child 可能是 Camera 根下的任意子级）⇒ 一并支持。
      const target = cmd.split(/\s+/)[2];
      const d = whichDir(target);
      const ch = d ? null : childOf(target);
      if (!d && !ch) return okOut('');
      // stale / 顽固开关 / App 占着 之下 rm 一律删不掉（含子项）—— 真机原话 Text file busy / busy
      if (fs.existsSync(DIR_STALE) || stubbornN() > 0 || appLocked()) {
        return fail('rm: ' + target + ': Text file busy');
      }
      if (d) {
        dirs[d].files = [];
        dirs[d].pending = [];
        for (let i = pushed.length - 1; i >= 0; i--) {
          if (toCmp(pushed[i]).indexOf(d + '/') === 0) pushed.splice(i, 1);
        }
      } else {
        dropChild(ch.parent, ch.name);
      }
      return okOut('');
    }
    if (/^rmdir /.test(cmd)) {
      // 空目录残骸：stale / 顽固 / App 占着 之下 rmdir 也放不掉（真机实测偶尔能过，这里从严）
      const target = cmd.replace(/^rmdir\s+/, '').replace(/\s+2>\S+$/, '').trim();
      if (fs.existsSync(DIR_STALE) || stubbornN() > 0 || appLocked()) {
        return fail('rmdir: ' + target + ': Device or resource busy');
      }
      const d = whichDir(target);
      const ch = d ? null : childOf(target);
      if (d) { dirs[d].files = []; dirs[d].pending = []; }
      else if (ch) dropChild(ch.parent, ch.name);
      return okOut('');
    }
    if (/^mv /.test(cmd) && (whichDir(cmd.split(/\s+/)[1]) || childOf(cmd.split(/\s+/)[1]))) {
      // ★ 关键：mv **通常在 stale 句柄下都能成功** —— 这正是 mv 换名法能绕过去的原因。
      //   真机实测（2026-10-04）：`rm -rf <dir>` rc=1、`mv <dir> <trash>` rc=0。
      // ★★ 但**顽固空残骸**是个例外：stale 句柄跟着 inode 走，改名之后照样锁着 ⇒
      //   本夹具在 DIR_EMPTY_STUBBORN 开启时让 mv 也失败（`Device or resource busy`），
      //   以复现「空残骸既删不掉也改不了名 ⇒ 只能记 note 放行」这个真实现场。
      const target = cmd.split(/\s+/)[1];
      const d = whichDir(target);
      const parts = cmd.split(/\s+/);
      // ★★ 2026-10-04 真机实测：锁在 App 进程里时 **连 mv 也不行** ——
      //   真机原话 `mv: bad '...': Operation not permitted`（得物正在用这批文件）。
      //   这与 DIR_STALE 的 `Device or resource busy` 是两种不同的真机报错，别混成一个。
      if (appLocked()) {
        return fail('mv: bad \'' + target + '\': Operation not permitted');
      }
      // ★★ 2026-10-04 真机约束：`Camera` 是 sdcardfs 的**挂载点级目录**，它自己不能被改名。
      //   真机原话：`mv: bad '.../DCIM/Camera/': Device or resource busy`。
      //   ⇒ 夹具必须同样拒绝「换名 Camera 根」，否则产品代码里那条
      //     「逐个子项退路」（第三十八轮）在回归里**永远跑不到**（假绿）。
      if (d === CAMERA) {
        return fail('mv: bad \'' + target + '\': Device or resource busy');
      }
      // 子级（例：`mv DCIM/Camera/X_gone_1 DCIM/Camera/X_gone_2`）：
      //   ★ 真机语义 = 换名，**原路径消失、新名出现**。残骸就是这样一路被加后缀的。
      if (!d) {
        const ch = childOf(target);
        const to = toCmp(parts[parts.length - 1]);
        // ★★ stale 现场：stale 句柄跟着 inode 走 ⇒ **连子项改名也不生效**
        //   （真机实测：改完名那个目录/文件照样锁着）。这条分支专门用来复现
        //   「删不掉也改不了名 ⇒ 只能如实报失败」这个红线（D6c 用的就是它）。
        // 顽固空残骸开关：目录残骸改名同样不生效；但**文件**改名仍然可以（文件先离开相册最要紧）。
        if (fs.existsSync(DIR_STALE)) {
          return fail('mv: bad \'' + target + '\': Device or resource busy');
        }
        if (stubbornN() > 0 && !isFile(ch.name)) {
          return fail('mv: bad \'' + target + '\': Device or resource busy');
        }
        dirs[ch.parent].renames.push(to);
        dropChild(ch.parent, ch.name);
        dirs[ch.parent].files.push(to.slice(ch.parent.length + 1));
        return okOut('');
      }
      if (stubbornN() > 0 && filesOf(d).some(f => !isFile(f))) {
        return fail('mv: bad \'' + target + '\': Device or resource busy');
      }
      dirs[d].renames.push(parts[parts.length - 1]);
      // 换名后这个路径不再存在，直到代码 mkdir 重建它。
      // ★ 内容随目录一起被搬走 ⇒ files 必须清空（否则 mkdir 重建后又"带着"残留，
      //   等于换名法没生效，测试会误判成失败）。
      dirs[d].files = [];
      dirs[d].pending = [];
      dirs[d].exists = false;
      for (let i = pushed.length - 1; i >= 0; i--) {
        if (toCmp(pushed[i]).indexOf(d + '/') === 0) pushed.splice(i, 1);
      }
      return okOut('');
    }
    if (/^uiautomator dump /.test(cmd)) {
      const target = cmd.split(/\s+/).pop();
      const mode = fs.existsSync(NOT_IDLE_FLAG)
        ? (read(NOT_IDLE_FLAG, Buffer.from('')).toString('utf8').includes('always') ? 'always' : 'anim')
        : '';
      const blocked = mode === 'always' || (mode === 'anim' && anim.animator_duration_scale !== '0');
      if (blocked) return okOut('ERROR: could not get idle state.\n');   // 真机：报错但**不写文件**
      // ★ 真机上还有一种：一个字都不打印（同样是“页面永不 idle”）。
      //   动画关掉后就能成功 —— 用来验「无输出也要走关动画重试」。
      if (fs.existsSync(SILENT_FLAG) && anim.animator_duration_scale !== '0') return okOut('');
      devFiles.set(target, read(WINDOW_XML, Buffer.from('<hierarchy/>')).toString('utf8'));
      return okOut(`UI hierchary dumped to: ${target}\n`);
    }
    if (/^cat /.test(cmd)) {
      const target = cmd.split(/\s+/).pop();
      if (!devFiles.has(target)) return fail(`cat: ${target}: No such file or directory`);
      return okOut(devFiles.get(target));
    }
    if (/^ime list( |$)/.test(cmd)) return okOut(imeList().map(c => c + '\n').join(''));
    if (/^ime enable /.test(cmd)) {
      const c = cmd.split(/\s+/).pop();
      if (!ime.enabled.includes(c)) ime.enabled.push(c);
      return okOut(`Input method ${c} enabled for user: 0\n`);
    }
    if (/^ime set /.test(cmd)) {
      const c = cmd.split(/\s+/).pop();
      if (!ime.enabled.includes(c)) ime.enabled.push(c);
      ime.default = c;
      return okOut(`Input method ${c} selected\n`);
    }
    if (/^settings (get|put|delete) secure /.test(cmd)) {
      const m = cmd.match(/^settings (get|put|delete) secure (\S+)(?:\s+(\S+))?$/);
      if (!m) return fail('settings: bad args');
      const [, verb, key, val] = m;
      if (key === 'android_id') {
        // 夹具不区分连的是哪个端口：**所有端口回同一个 id** —— 正是真机上「同一台设备」的样子
        return okOut(fs.existsSync(NOID_FLAG) ? 'null\n' : DEV_ANDROID_ID + '\n');
      }
      if (key === 'default_input_method') {
        if (verb === 'get') return okOut((imeReady() ? IME_AUTO : ime.default) + '\n');
        ime.default = verb === 'put' ? val : '';
        return okOut('');
      }
      return okOut(verb === 'get' ? 'null\n' : '');
    }
    if (/^settings (get|put|delete) global /.test(cmd)) {
      const m = cmd.match(/^settings (get|put|delete) global (\S+)(?:\s+(\S+))?$/);
      if (!m) return fail('settings: bad args');
      const [, verb, key, val] = m;
      if (verb === 'get') return okOut((key in anim ? anim[key] : 'null') + '\n');
      if (verb === 'put') { anim[key] = val; return okOut(''); }
      delete anim[key];
      return okOut('');
    }
    // ★ 2026-10-03 新增：推完素材的「落地确认」（adb.js#filesMissing 发的命令）。
    //   真机语义就是「文件在磁盘上吗」。夹具里「在不在」= 有没有真实 push 过 ——
    //   这样「推完却在设备上找不到」这种失败才测得到（不会恒为 EXISTS 造成假绿）。
    if (/^\[ -f /.test(cmd)) {
      const m = cmd.match(/^\[ -f '([^']*)' \]/);
      if (!m) return fail('bad test');
      return okOut(pushed.includes(m[1]) ? 'EXISTS\n' : 'MISSING\n');
    }
    // ★ 2026-10-03 新增：媒体扫描（adb.js#mediaScan 发的就是这条）。
    //   真机语义：scan_file 成功回 `Bundle[{android.intent.extra.STREAM=content://media/...}]`，
    //   这时文件**才**进库（content query 才看得见）；失败的标志是 STREAM=null。
    if (/^content call /.test(cmd)) {
      const failScan = fs.existsSync(SCAN_FAIL);
      const argM = cmd.match(/--arg\s+'?([^']+)'?/);
      const arg = argM ? argM[1].trim() : '';
      if (/--method scan_file/.test(cmd)) {
        const asSd = arg.replace(/^\/storage\/emulated\/0\//, '/sdcard/');
        if (!failScan && asSd && pushed.includes(asSd)) {
          if (!scanned.includes(asSd)) scanned.push(asSd);
          return okOut(`Result: Bundle[{android.intent.extra.STREAM=content://media/external_primary/video/media/${mediaIdOf(asSd)}}]\n`);
        }
        return okOut('Result: Bundle[{android.intent.extra.STREAM=null}]\n');
      }
      if (/--method scan_volume/.test(cmd)) {
        if (!failScan) pushed.forEach(p => { if (!scanned.includes(p)) { scanned.push(p); mediaIdOf(p); } });
        return okOut('Result: Bundle[{}]\n');
      }
      return okOut('Result: Bundle[{}]\n');
    }
    if (/^content query /.test(cmd)) {
      // 媒体库索引：只回**真进过库**（scanned）的文件 —— push 本身不算进库。
      // 想模拟「扫描发了但还没索引到」，就在现场目录建一个 MEDIA_LAG 文件
      const lag = fs.existsSync(path.join(dir, 'MEDIA_LAG'));
      const list = lag ? [] : scanned;
      // ★★ 2026-10-04：投影语义要对齐真机。
      //   真机 `content query --projection _id:_data` 回的是 `Row: N _id=K, _data=路径`
      //   （**逗号分隔、带 _id**），clearMediaDir 的正则抓的就是这个格式。
      //   旧夹具回的是 `Row: N _data=路径`（没 _id）⇒ 会把**所有记录都漏掉**，
      //   于是「按记录删库」这一半在回归里等于没测（假绿）。
      return okOut(list.map((p, i) =>
        `Row: ${i} _id=${mediaIdOf(p)}, _data=${String(p).replace(/^\/sdcard\//, '/storage/emulated/0/')}`
      ).join('\n') + (list.length ? '\n' : ''));
    }
    if (/^content delete /.test(cmd)) {
      // ★★ 2026-10-04 新增：按 _id 删库记录（clearMediaDir 用的就是这条）。
      //   真机语义：删掉记录的同时**物理文件也一起消失**（见 adb.js 顶部实测注释）。
      //   夹具要同步把 scanned / pushed 里的对应项去掉 —— 否则 content query 还看得见，
      //   「删完库里还有」这种 bug 就永远抓不到。
      const m = cmd.match(/\/media\/(\d+)\s*$/);
      if (m) {
        const id = Number(m[1]);
        const idx = scanned.findIndex(p => mediaIdOf(p) === id);   // 按**稳定 id** 反查（不再用下标推算）
        if (idx >= 0) {
          const gone = scanned[idx];
          scanned.splice(idx, 1);
          mediaIds.delete(String(gone));
          for (let i = pushed.length - 1; i >= 0; i--) {
            if (norm(pushed[i]).replace(/^\/storage\/emulated\/0\//, '/sdcard/') ===
                norm(gone).replace(/^\/storage\/emulated\/0\//, '/sdcard/')) pushed.splice(i, 1);
          }
        }
      }
      return okOut('');
    }
    // ★★ 2026-10-04 新增：`input tap` 的现场开关 TAP_FOCUS 见上面第 24x 行 ——
    //   它**必须**写在已有的 `input (tap|keyevent|text)` 那一支里；另起一个分支就是死代码
    //   （前面那条已经 return 了。写这一条时我自己踩过一次，如实记在这儿）。
    // ★★★ 2026-10-04 新增：**当前点击坐标系**（`init=` / `cur=`）。必须排在通用 `dumpsys window`
    //   之前 —— 那条已经 return 了，写在它后面就是死代码（这条坑我自己踩过一次，记在这儿）。
    //   真机依据（MuMu 12 / 1080x1920，本机实测）：
    //     · 得物（竖屏锁定）在前台 → `init=1080x1920 280dpi cur=1080x1920 app=1080x1920`
    //     · MuMu 桌面（横屏）在前台 → 同一命令变成 `cur=1920x1080`，且 screencap / dump bounds 全是 1920x1080
    //   ⇒ 默认给**竖屏**（发布全程都是得物在前台，实测就是这个值）。
    //   现场开关 UISIZE：写 `宽x高`（例如 `1920x1080`）就让这一行报那个尺寸 ——
    //   用来验「定位表的坐标系和这台设备对不上 ⇒ 必须拦下、不许硬点」那条守卫。
    if (/^dumpsys window displays/.test(cmd)) {
      const fsz = path.join(dir, 'UISIZE');
      const rawsz = fs.existsSync(fsz) ? read(fsz, Buffer.from('')).toString('utf8').trim() : '';
      const sz = /^\d+x\d+$/.test(rawsz) ? rawsz : '1080x1920';
      return okOut(`  init=1080x1920 280dpi cur=${sz} app=${sz} rng=1080x1038-1080x1878\n`);
    }
    if (/^dumpsys window/.test(cmd)) {
      const f = path.join(dir, 'FOCUS');
      const exists = fs.existsSync(f);
      const raw = exists ? read(f, Buffer.from('')).toString('utf8').trim() : '';
      // 现场开关 FOCUS：写什么就假装前台是什么；不存在 → 默认得物发布页。
      //   ★★ 2026-10-04 夹具修正：以前写成 '-' 是**永久**回 `mCurrentFocus=null`，
      //     而现在产品里多了一个「回主线」守卫会轮询前台 —— 真机上 `mCurrentFocus=null`
      //     只出现在**转场的一瞬间**（本机实测 `dumpsys activity top` 是**永远**有堆栈的），
      //     永久 null 这种状态真机上不存在 ⇒ 拿它测出来的结论是假的。
      //   ⇒ 现在的语义：'-' = **这一次**读不到（模拟转场瞬间），下一次读就正常了
      //     （启动页那一跳照旧会转成首页），读完之后把 FOCUS 复原成正常值。
      //     现场开关 FOCUS_UNREADABLE：假装**永久**读不到（`dumpsys window` 一直不吐 focus 行）
      //     —— 这是守卫必须如实报错、且**绝不瞎启动 App** 的那条路径。
      //   ★★★ 2026-10-04 二次修正（这一条是写测试时实测出来的**真问题**）：
      //     上面那个判据只挡住了「FOCUS 写着 '-'」的情况。而这条用例的真实场景是
      //     「前台**就是得物首页**，只是这一行**读不出来**」—— FOCUS 里写的是
      //     `com.shizhuang.duapp/.modules.home.ui.HomeActivity`，于是这里照常把 focus 回给了
      //     调用方 ⇒ 守卫一看「就是首页」直接判成功、三连全绿。
      //     ⇒ **FOCUS_UNREADABLE 必须优先**：只要它在，无论 FOCUS 写什么，这一行都读不出来。
      if (fs.existsSync(path.join(dir, 'FOCUS_UNREADABLE'))) return okOut('  mCurrentFocus=null\n');
      if (raw === '-') {
        // 转场瞬间：这一次读不到，下一次读就正常（真机 `mCurrentFocus=null` 只出现在转场那一瞬）
        fs.writeFileSync(f, 'com.shizhuang.duapp/media.publish.activity.TotalPublishProcessActivity');
        return okOut('  mCurrentFocus=null\n');
      }
      let focus = raw || 'com.shizhuang.duapp/media.publish.activity.TotalPublishProcessActivity';
      // ★★ 2026-10-04：启动页转场 —— 真机实测得物启动后走 `SplashActivity` → `HomeActivity`
      //   （有转场，耗时不确定）。夹具里用「读第二次前台时才转」来模拟：
      //   产品代码靠轮询等待跨过去（见 adb.js#ensureApp），所以这个语义必须真。
      //   现场开关 SPLASH_STUCK：假装卡在启动页（一直转不过去）—— 验「等不到就必须如实失败」。
      if (/SplashActivity/.test(focus) && !fs.existsSync(path.join(dir, 'SPLASH_STUCK'))) {
        focus = 'com.shizhuang.duapp/.modules.home.ui.HomeActivity';
        try { fs.writeFileSync(f, focus); } catch (e) { /* 写不进去不影响这一轮 */ }
      }
      if (focus === '-') return okOut('  mCurrentFocus=null\n');
      return okOut(`  mCurrentFocus=Window{a1b2c3d4 u0 ${focus}}\n`);
    }
      // ★★ 2026-10-04：「回主线」守卫要用 —— 起手先把 App 拉回首页。
      //   真机语义（本机实测）：
      //     · `am start -n <pkg>/<Act>` 成功回 `Starting: Intent { cmp=... }`，
      //       并且**前台真的换过去**（先落启动页、再转首页）；
      //     · Activity 名不存在时回 `Error type 3 / Activity class does not exist`（rc 仍是 0！）
      //       —— 得物 `.MainActivity` 就是这种，实测报的就是这个。
      //   ★ 这里必须**真的改 FOCUS**（前台）。只回一句成功而前台不动的话，
      //     守卫会一直等下去直到超时 —— 那把「拉不起来」这条失败路径测成恒失败，等于没测到成功路径。
      //   ★ 现场开关 SPLASH_STUCK：假装卡在启动页（转不过去）—— 验「等不到首页必须如实失败」。
      // ★★ 2026-10-04 新增：`am force-stop <pkg>`（清相册时用来把占着文件的得物强停掉）。
      //   真机语义（本轮实测）：force-stop 会把**该进程持有的文件句柄一起收走** ——
      //   同一句 `rm -rf <dir>` 在 force-stop 之前报 `Text file busy`、之后就成功。
      //   ⇒ 夹具里 `appStopped = true` 让 DIR_LOCKED_BY_APP 这套锁**失效**。
      //   ★ 注意语义边界：这只解「锁在 App 进程里」那类；DIR_STALE（真 stale 句柄）**照旧锁着**。
      if (/^am force-stop /.test(cmd)) {
        const pkg = cmd.replace(/^am force-stop\s+/, '').trim();
        appStops.push(pkg);
        if (/^com\.shizhuang\.duapp/i.test(pkg)) appStopped = true;
        return okOut('');
      }
      if (/^am start /.test(cmd)) {
      const m = cmd.match(/-n\s+(\S+?)\/(\S+)/);
      if (!m) return okOut('Error: no intent supplied\n');
      const pkg = m[1], act = m[2];
      // ★★ 2026-10-04 真机实测修正（这一条是**假绿**的根源，必须对齐真机语义）：
      //   真机 `am start -n <pkg>/<Act>` **认 Activity 名的原文** ——
      //     带点（`.modules.home.ui.SplashActivity`）= 包内相对路径 ⇒ 能启动；
      //     不带点（`modules.home.ui.SplashActivity`）= 被当成顶层类全名 ⇒
      //       `Error type 3 / Activity class does not exist`（本机实测）。
      //   ★ 旧夹具把两边的点都 `replace(/^\./, '')` 掉了 ⇒ **两种写法都被判成存在**
      //     ⇒ 产品代码里「误删前导点」这个**真机必崩**的 bug 在回归里恒绿，
      //     一直到真机连发第 2 条才暴露（代价：连着 2 条内容失败）。
      //   ⇒ 夹具从此**原样比较**：得物真实入口只认带点的那一份。
      const REAL = {
        'com.shizhuang.duapp': ['.modules.home.ui.SplashActivity']
      };
      const known = REAL[pkg];
      if (known && !known.includes(act)) {
        return okOut(`Error type 3\nError: Activity class {${pkg}/${act}} does not exist.\n`);
      }
      // ★★ 关键：启动**不会**让前台直接变成启动页 —— 真机实测得物启动后是
      //   `SplashActivity` → 转 → `HomeActivity`（有启动页转场，耗时不确定）。
      //   夹具必须照这个语义来，否则会得出错误结论：
      //     写成「起手就变 HomeActivity」⇒ 守卫看一眼就过，等于**没测到等待逻辑**；
      //     写成「永远停在 SplashActivity」⇒ 守卫每次都超时，等于**成功路径测不出来**。
      //   ⇒ 在 FOCUS 里落**启动页**（真机第一跳的样子），下一次读前台时才转成首页。
      //     产品代码靠**轮询等待**跨过这个转场（见 adb.js#ensureApp）。
      //   ★ 现场开关 SPLASH_STUCK：假装卡在启动页（启动页一直转不过去）——
      //     用来验「等不到首页时必须如实失败、绝不硬点」这条负向路径。
      const asFocus = /^\./.test(act) ? pkg + '/' + act : pkg + '/.' + act;
      fs.writeFileSync(path.join(dir, 'FOCUS'), asFocus);
      return okOut(`Starting: Intent { cmp=${asFocus} }\n`);
    }
    // 起手兜底那条：monkey 落到**该包的默认入口**（真机实测 = SplashActivity → HomeActivity）
    if (/^monkey /.test(cmd)) {
      if (!/-p\s+\S+/.test(cmd)) return fail('monkey: no package specified');
      fs.writeFileSync(path.join(dir, 'FOCUS'), 'com.shizhuang.duapp/.modules.home.ui.SplashActivity');
      return okOut('Events injected: 1\n');
    }
    if (/^dumpsys activity top/.test(cmd)) {
      // ★ 真机：这是 uiautomator 抓不到时**唯一的退路**（dumpsys 不等 idle）。
      //   见 src/main/services/adb.js#dumpViaDumpsys —— 得物发布页首屏是持续动画页，
      //   uiautomator 连试十几次全报 could not get idle state。
      // ★★ 2026-10-04：「回主线」守卫也会走这条 —— 但要的是**栈顶 Activity**那几行，
      //   所以先按 `| grep -m1 "..."` 里那段**设备端就筛好**的语义处理（见 adb.js#topActivityMatching
      //   与 #frontActivity 的注释：那份 dump 有 1000+ 行，实测必须让设备端先筛）。
      //   ★ 夹具这里对齐真机的一个重要事实：`dumpsys activity top` 是**整栈** dump ——
      //     后台栈里的老 Activity（这里是 settings）也照样列着。所以「整份里出现过」
      //     **不等于**「现在就在那一屏」；只认**第一个**匹配才是栈顶。
      const gm = cmd.match(/\|\s*grep\s+-m1\s+"([^"]*)"/);
      if (gm) {
        const pat = gm[1];
        if (fs.existsSync(TOP_NO_DEWU)) return okOut('');   // 现场开关：这份 dump 里没有得物
        // ★ 现场开关 FOCUS_UNREADABLE = 「前台这一行永远读不出来」：这时**两条通道都得读不到**
        //   （真机上真出现这种状态时，`dumpsys activity top` 也不会有得物那一段）。
        //   只让 `dumpsys window` 读不到、备用通道却照旧吐得物 ⇒ 守卫能从备用通道确认「到了」
        //   从而判成功 —— 那是**产品代码的正确行为**，不是漏拦（写测试时实测踩到：
        //   第一版只挡了 window，结果这三条一直假红）。
        if (fs.existsSync(path.join(dir, 'FOCUS_UNREADABLE'))) return okOut('');
        const lines = [
          'TASK null id=2 userId=0',
          '  ACTIVITY com.android.settings/.Settings 1a2b3c4 pid=1000',
          'TASK 10042:com.shizhuang.duapp id=91 userId=0',
          '  ACTIVITY com.shizhuang.duapp/.modules.home.ui.HomeActivity a6b4125 pid=9560'
        ];
        const hit = lines.filter(l => l.indexOf(pat) >= 0).slice(0, 1);
        return okOut(hit.join('\n') + (hit.length ? '\n' : ''));
      }
      if (fs.existsSync(TOP_NO_DEWU)) {
        return okOut('TASK 1000:com.android.settings id=35 userId=0\n'
          + '    View Hierarchy:\n'
          + '      DecorView@ddd[SubSettings]\n'
          + '        android.widget.TextView{eee V.E...... ........ 0,0-300,90}\n');
      }
      return okOut(read(TOP_DUMP, Buffer.from('')).toString('utf8'));
    }
    if (cmd === 'pm list packages') return okOut('package:com.shizhuang.duapp\npackage:com.android.adbkeyboard\npackage:com.android.shell\n');
    return okOut('');
  }

  /** 返回这条命令的结果 { out, code } */
  function respond(argv) {
    const args = argv.slice();
    if (args[0] === 'version') return okOut('Android Debug Bridge version 1.0.41\n');
    if (args[0] === 'devices') {
      if (fs.existsSync(MULTI_FLAG)) {
        // 同一台模拟器被三个端口各报一次（真机 MuMu 12 实测的原样）
        return okOut('List of devices attached\n127.0.0.1:16384\tdevice\n127.0.0.1:5555\tdevice\n127.0.0.1:7555\tdevice\n');
      }
      return okOut('List of devices attached\n127.0.0.1:5555\tdevice\n');
    }
    if (args[0] === '-s') args.splice(0, 2);

    if (args[0] === 'exec-out') return okOut(read(SHOT_PNG, Buffer.alloc(0)));   // screencap -p，二进制
    if (args[0] === 'install') {
      if (fs.existsSync(path.join(dir, 'IME_INSTALL_FAIL'))) return fail('Failure [INSTALL_FAILED_INVALID_APK]');
      return okOut('Success\n');
    }
    if (args[0] === 'push') {
      const remote = args[args.length - 1];
      if (remote && !pushed.includes(remote)) pushed.push(remote);
      return okOut('1 file pushed. 0.4 MB/s\n');
    }

    if (args[0] === 'shell') {
      // adb shell 会把整串交给设备上的 sh，所以 ';' 串起来的多条要逐条执行、按序拼接输出
      const parts = args.slice(1).join(' ').split(';');
      if (parts.length === 1) return shellSub(parts[0]);
      let out = '';
      for (const p of parts) {
        const r = shellSub(p);
        out += r.out;
        if (r.code) return { out, code: r.code };
      }
      return okOut(out);
    }
    return okOut('');
  }

  /** 可直接覆盖到 require('child_process').execFile 上 */
  const fakeExec = function execFile(file, args, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    const argv = Array.isArray(args) ? args : [];
    const opts = options || {};
    // 现场留痕（先写日志再回包，顺序与原 bash 假 adb 一致）
    try { fs.appendFileSync(CALLS, argv.join(' ') + '\n'); } catch (e) { /* 日志写不进去不该影响被测逻辑 */ }
    try { fs.appendFileSync(FILES, String(file) + '\n'); } catch (e) { /* 同上 */ }
    if (file !== 'adb') {
      // 真被调到了别的可执行文件：明确报错，不要假装成功
      // （内置 adb 是绝对路径，basename 得是 adb / adb.exe —— 见文件头说明）
      const base = path.basename(String(file || '')).toLowerCase();
      if (base !== 'adb' && base !== 'adb.exe') {
        const err = new Error(`假 adb 只替身 'adb'，却被要求执行 '${file}'`);
        err.code = 'ENOENT';
        return process.nextTick(() => callback && callback(err, '', ''));
      }
      // ★ 真 execFile 对「路径不存在」会直接 ENOENT。这里也要一样 ——
      //   否则测「手填了一个不存在的 adb 路径」时会假绿（假 adb 什么都肯执行）。
      const isPath = /^[A-Za-z]:[\\/]/.test(String(file)) || path.isAbsolute(String(file));
      if (isPath && !fs.existsSync(String(file))) {
        const err = new Error(`spawn ${file} ENOENT`);
        err.code = 'ENOENT';
        return process.nextTick(() => callback && callback(err, '', ''));
      }
    }
    const res = respond(argv);
    const code = res.code || 0;
    const isBuffer = opts.encoding === 'buffer';
    const stdout = Buffer.isBuffer(res.out) ? res.out : (isBuffer ? Buffer.from(res.out) : String(res.out));
    process.nextTick(() => {
      if (!callback) return;
      if (code) {
        // 真 adb 失败时是「非 0 退出码 + 消息在 stdout」，这里保持一致
        const err = new Error(`Command failed with exit code ${code}`);
        err.code = code;
        return callback(err, stdout, '');
      }
      callback(null, stdout, '');
    });
  };
  // ★★ 2026-10-04：把「专属相册目录」的现场状态挂出来，测试直接读它做断言
  //   （不用去解析 calls.log 猜 —— 那只能证明"发过命令"，证明不了"目录真干净了"）。
  //   state.files  = 目录里还剩的项；state.exists = 目录在不在；state.renames = 换名历史。
  fakeExec.__bluevDir = dirState;
  fakeExec.__bluevDirPath = BLUEV;
  // ★★ 2026-10-04（第四十轮）：通用受管目录表 —— 支持清**相册根** `/sdcard/DCIM/Camera`。
  //   断言用法：`fakeExec.__dirs['/sdcard/DCIM/Camera'].files = ['X_gone_1']`
  fakeExec.__dirs = dirs;
  fakeExec.__cameraDirPath = CAMERA;
  // ★★ 2026-10-04 新增：`am force-stop` 的现场（断言侧用它证明「确实强停过、停了哪个包」）。
  //   · `__appStops` —— 真被执行过的 force-stop 包名列表（空 = 一次都没停过）。
  //   · `__appReset()` —— 把「App 已被停掉 ⇒ 它手里的锁没了」这个状态**复位**（用例之间隔离用）。
  //     ★ 必须有这个复位口：`appStopped` 是**进程级**状态，不复位的话第二组用例会接着第一组的
  //       "锁已经没了"往下跑 ⇒ 该红的用例反而绿（典型串味假绿）。
  fakeExec.__appStops = appStops;
  fakeExec.__appReset = () => { appStopped = false; };
  return fakeExec;
}

module.exports = { makeFakeAdb };
