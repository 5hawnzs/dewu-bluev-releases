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
  const WINDOW_XML = path.join(dir, 'window.xml');
  const SHOT_PNG = path.join(dir, 'shot.png');
  const NOT_IDLE_FLAG = path.join(dir, 'DUMP_NOT_IDLE');
  // ★ 2026-10-03 真机实测的另一种症状：得物发布页首屏的 uiautomator
  //   有时**一个字都不打印**（不是 could not get idle state）。
  //   建 DUMP_SILENT 文件 → 系统动画还开着时返回**空输出**；关掉动画就成功（同真机）。
  const SILENT_FLAG = path.join(dir, 'DUMP_SILENT');
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
  // 现场开关 SCAN_FAIL：假装媒体扫描**没生效**（scan_file 回空 STREAM、scan_volume 不回填）
  //   —— 用来验「扫描失败时必须靠进库确认兜底，且最终如实失败」。
  const SCAN_FAIL = path.join(dir, 'SCAN_FAIL');

  // 设备上的「文件」：只需模拟 dump 用到的那个路径。
  // 关键语义（真机实测）：uiautomator dump **成功才写文件**；失败时目标文件一字不动。
  // 所以失败时若不清掉旧文件，cat 出来的就是**上一个页面**的结构。
  const devFiles = new Map();

  // ★★ 2026-10-04 新增：模拟「专属相册目录」DCIM/Camera/bluev 的真实文件系统语义。
  //   为什么必须加：清相册那一步（adb.js#clearMediaDir）现在走的是
  //     `find <dir> -mindepth 1 -delete` / `rm -rf <dir>/*` / `ls -A <dir>` / `mv <dir> <trash>`
  //   这一套。旧夹具只认 `rm -f`，其余一律回空 ⇒ 清目录在回归里变成**空操作**、
  //   无论代码写得多烂都全绿（典型假绿）。这里把这几个命令的语义补上，才算真测到。
  //   现场开关（建文件即生效）：
  //     DIR_STALE   —— 这个目录处于 `Text file busy` 的 stale 句柄状态：
  //                    `find -delete` 与 `rm -rf` 都**删不掉**，只有 `mv` 改名/`ls` 能过。
  //                    用来验「清不动时必须走 mv 换名法，而不是原地死磕」。
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
  // 只模拟 bluev 这一个专属目录（真实产品里也只有它）
  const BLUEV = '/sdcard/DCIM/Camera/bluev';
  const dirState = { exists: false, files: [], renames: [] };
  // 把命令里的路径统一成 /sdcard/... 形式，好和 BLUEV 比
  const norm = p => String(p || '').trim().replace(/\/+$/, '');
  // 现场夹具：内容就用推到过这个目录的 pushed 文件（与真实一致：推完才在目录里）
  const bluevFiles = () => pushed.filter(p => norm(p).indexOf(BLUEV + '/') === 0)
    .map(p => norm(p).slice(BLUEV.length + 1)).concat(dirState.files);

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
    const cmd = sub.trim()
      .replace(/\s*\d?>&\s*\d+/g, '')
      .replace(/\s*\d?>\s*\/dev\/null/g, '')
      .trim();
    if (!cmd) return okOut('');
    // 真 sh 的 echo：合并抓屏那条命令里用它当中段分隔标记
    if (/^echo\b/.test(cmd)) return okOut(cmd.replace(/^echo\s*/, '') + '\n');
    if (cmd === 'wm size') return okOut('Physical size: 1080x2400\n');
    if (cmd === 'input') return okOut('usage: input [<source>] <command>\n');
    if (/^input (tap|keyevent|text) /.test(cmd)) return okOut('');
    if (/^am broadcast /.test(cmd)) return okOut('Broadcast completed: result=0\n');
    if (/^rm -f /.test(cmd)) {
      cmd.split(/\s+/).slice(2).forEach(p => devFiles.delete(p));
      return okOut('');
    }
    // ★★ 2026-10-04 新增：专属相册目录的真实语义（清相册那一步用的就是这些命令）。
    //   顺序有讲究：先判 `ls -A`（最简单、最常调），再判 find / rm -rf / mv。
    // ★ 注意：真机上 MediaStore/磁盘路径有两种写法（/sdcard/... 与 /storage/emulated/0/...），
    //   产品代码发出来的正是后者 ⇒ 判断**不能用字面 indexOf(BLUEV)**（那样永远匹配不上，
    //   mv 分支就成了死代码，测试会误以为「代码没走换名法」）。统一走 norm 后比较。
    const hasBluev = (...ps) => ps.some(p => {
      const n = norm(p).replace(/^\/storage\/emulated\/0\//, '/sdcard/');
      return n === BLUEV || n.indexOf(BLUEV + '/') === 0;
    });
    if (/^ls -A /.test(cmd)) {
      const target = cmd.replace(/^ls -A\s+/, '').trim();
      if (!hasBluev(target)) return fail('ls: ' + target + ': No such file or directory');
      if (fs.existsSync(DIR_UNREADABLE)) return fail('ls: ' + target + ': Permission denied');
      if (!dirState.exists) return fail('ls: ' + target + ': No such file or directory');
      const list = bluevFiles();
      return okOut(list.join('\n') + (list.length ? '\n' : ''));
    }
    if (/^mkdir -p /.test(cmd)) {
      const target = cmd.replace(/^mkdir -p\s+/, '').trim();
      if (hasBluev(target)) dirState.exists = true;
      return okOut('');
    }
    if (/^find .* -mindepth 1 -delete/.test(cmd)) {
      const target = cmd.replace(/^find\s+(\S+).*$/, '$1').trim();
      if (!hasBluev(target)) return okOut('');
      if (fs.existsSync(DIR_STALE)) {
        // stale 句柄：删不掉，如实报 Text file busy（真机原话）
        return fail('rm: ' + target + ': Text file busy');
      }
      dirState.files = [];
      for (let i = pushed.length - 1; i >= 0; i--) {
        if (norm(pushed[i]).indexOf(BLUEV + '/') === 0) pushed.splice(i, 1);
      }
      return okOut('');
    }
    if (/^rm -rf /.test(cmd) && cmd.indexOf('Camera/bluev') >= 0) {
      if (fs.existsSync(DIR_STALE)) return fail('rm: ' + BLUEV + ': Text file busy');
      dirState.files = [];
      for (let i = pushed.length - 1; i >= 0; i--) {
        if (norm(pushed[i]).indexOf(BLUEV + '/') === 0) pushed.splice(i, 1);
      }
      return okOut('');
    }
    if (/^mv /.test(cmd) && cmd.indexOf('Camera/bluev') >= 0) {
      // ★ 关键：mv **永远成功** —— 这正是 mv 换名法能在 stale 句柄下绕过去的原因。
      //   真机实测（2026-10-04）：同一时刻 `rm -rf <dir>` rc=1、`mv <dir> <trash>` rc=0。
      const parts = cmd.split(/\s+/);
      dirState.renames.push(parts[parts.length - 1]);
      // 换名后「bluev」这个路径不再存在，直到代码 mkdir 重建它。
      // ★ 内容随目录一起被搬走 ⇒ files 必须清空（否则 mkdir 重建后又"带着"残留，
      //   等于换名法没生效，测试会误判成失败）。
      dirState.files = [];
      dirState.exists = false;
      for (let i = pushed.length - 1; i >= 0; i--) {
        if (norm(pushed[i]).indexOf(BLUEV + '/') === 0) pushed.splice(i, 1);
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
          return okOut(`Result: Bundle[{android.intent.extra.STREAM=content://media/external_primary/video/media/${200 + scanned.length}}]\n`);
        }
        return okOut('Result: Bundle[{android.intent.extra.STREAM=null}]\n');
      }
      if (/--method scan_volume/.test(cmd)) {
        if (!failScan) pushed.forEach(p => { if (!scanned.includes(p)) scanned.push(p); });
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
        `Row: ${i} _id=${100 + i}, _data=${String(p).replace(/^\/sdcard\//, '/storage/emulated/0/')}`
      ).join('\n') + (list.length ? '\n' : ''));
    }
    if (/^content delete /.test(cmd)) {
      // ★★ 2026-10-04 新增：按 _id 删库记录（clearMediaDir 用的就是这条）。
      //   真机语义：删掉记录的同时**物理文件也一起消失**（见 adb.js 顶部实测注释）。
      //   夹具要同步把 scanned / pushed 里的对应项去掉 —— 否则 content query 还看得见，
      //   「删完库里还有」这种 bug 就永远抓不到。
      const m = cmd.match(/\/media\/(\d+)\s*$/);
      if (m) {
        const idx = Number(m[1]) - 100;
        if (idx >= 0 && idx < scanned.length) {
          const gone = scanned[idx];
          scanned.splice(idx, 1);
          for (let i = pushed.length - 1; i >= 0; i--) {
            if (norm(pushed[i]).replace(/^\/storage\/emulated\/0\//, '/sdcard/') ===
                norm(gone).replace(/^\/storage\/emulated\/0\//, '/sdcard/')) pushed.splice(i, 1);
          }
        }
      }
      return okOut('');
    }
    if (/^dumpsys window/.test(cmd)) {
      const f = path.join(dir, 'FOCUS');
      const exists = fs.existsSync(f);
      const raw = exists ? read(f, Buffer.from('')).toString('utf8').trim() : '';
      // 现场开关 FOCUS：写什么就假装前台是什么；不存在 → 默认得物发布页；写成 '-' → 假装读不到
      const focus = raw || (exists ? '-' : 'com.shizhuang.duapp/media.publish.activity.TotalPublishProcessActivity');
      if (focus === '-') return okOut('  mCurrentFocus=null\n');
      return okOut(`  mCurrentFocus=Window{a1b2c3d4 u0 ${focus}}\n`);
    }
    if (/^dumpsys activity top/.test(cmd)) {
      // ★ 真机：这是 uiautomator 抓不到时**唯一的退路**（dumpsys 不等 idle）。
      //   见 src/main/services/adb.js#dumpViaDumpsys —— 得物发布页首屏是持续动画页，
      //   uiautomator 连试十几次全报 could not get idle state。
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
  return fakeExec;
}

module.exports = { makeFakeAdb };
