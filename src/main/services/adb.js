'use strict';
/**
 * ADB 驱动层：只做「确实能做到」的真实动作，做不到就明确报错，绝不假装成功。
 *   - 设备在线 / 分辨率 / 包是否安装 / 工具可用性：真实探测
 *   - 推图 + 触发媒体扫描：真实命令
 *   - 界面结构抓取（uiautomator dump）+ 点击 / 输入：真实命令
 *   - 中文输入依赖 ADBKeyboard（com.android.adbkeyboard）—— apk 随包内置，
 *     探测里会说清「装没装 / 启用没启用」，并给一个「一键装上」的按钮
 *
 * ★ adb 本身也随包内置（`vendor/adb/` → 打包后 `resources/adb/`），
 *   解析顺序见下面 setAdbPath 那段注释：手填 > 内置 > 系统 PATH。
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * adb 可执行文件从哪来 —— 三段，优先级从高到低：
 *   ① **用户手填**的完整路径（填了、且文件真的在 ⇒ 就用它。绝不因为「内置了一个」就悄悄替掉他的配置）
 *   ② **程序内置**（安装包里的 `resources/adb/adb.exe`，开发时是仓库 `vendor/adb/`）⇒ 新同事零配置
 *   ③ 系统 **PATH** 上的 `adb`（老用户既有的装法，不能被内置版本打断）
 *
 * 解析结果里带 `source`，界面照实显示「现在用的是哪一个、从哪来」—— 不猜、不藏。
 * 这一段只依赖 fs/path，不 require('store')：测试里换假 adb 只动 child_process 那一层就够了。
 */
let adbBin = 'adb';      // 用户手填值（'' 或 'adb' = 没填）
let bundledDir = '';     // 内置 adb 所在目录（打包后 resources/adb；开发时仓库 vendor/adb）
let bundledApk = '';     // 内置的中文输入法 apk（ADBKeyboard.apk 的绝对路径）

function setAdbPath(p) {
  const s = String(p == null ? '' : p).trim();
  adbBin = s || 'adb';
  return adbBin;
}
function getAdbPath() { return adbBin; }
function setBundledAdbDir(d) { bundledDir = String(d == null ? '' : d).trim(); return bundledDir; }
function getBundledAdbDir() { return bundledDir; }
function setBundledApkPath(p) { bundledApk = String(p == null ? '' : p).trim(); return bundledApk; }
function getBundledApkPath() { return bundledApk; }

const ADB_EXE = process.platform === 'win32' ? 'adb.exe' : 'adb';
function bundledAdbPath() { return bundledDir ? path.join(bundledDir, ADB_EXE) : ''; }

/**
 * ★ 纯函数（不碰文件系统），专门为了能被测试直接喂输入：
 *   `resolveAdbChoice({ configured, bundled, exists })` → { path, source, configuredMissing, bundled }
 * source 取值：`configured`（用你填的）/ `bundled`（用内置的）/ `path`（走系统 PATH）/
 *              `configured-missing`（你填的那个不存在，也**没有**可用的备选）
 */
function resolveAdbChoice({ configured = '', bundled = '', exists = () => false } = {}) {
  const cfg = String(configured || '').trim();
  const cfgIsPath = !!cfg && cfg !== 'adb';
  const cfgMissing = cfgIsPath && !exists(cfg);
  if (cfgIsPath && !cfgMissing) return { path: cfg, source: 'configured', configuredMissing: false, bundled: '' };
  if (bundled && exists(bundled)) return { path: bundled, source: 'bundled', configuredMissing: cfgMissing, bundled };
  return { path: cfg || 'adb', source: cfgIsPath ? 'configured-missing' : 'path', configuredMissing: cfgMissing, bundled: '' };
}

/** 当前实际会去执行的那个 adb（每次现算，不做缓存 —— 用户可能刚把文件放进去） */
function active() {
  return resolveAdbChoice({ configured: adbBin, bundled: bundledAdbPath(), exists: fs.existsSync });
}
function getActiveAdb() { return active(); }

/** 随包内置的这两样东西到底在不在（设置页「外部依赖」照实显示，不猜） */
function bundledStatus() {
  const exe = bundledAdbPath();
  return {
    dir: bundledDir, exe, exists: !!(exe && fs.existsSync(exe)),
    apk: bundledApk, apkExists: !!(bundledApk && fs.existsSync(bundledApk)),
    active: active()
  };
}

function execAdbOnce(args, { timeout = 20000, binary = false } = {}) {
  return new Promise(resolve => {
    execFile(active().path, args, {
      timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
      encoding: binary ? 'buffer' : 'utf8'
    }, (err, stdout, stderr) => resolve({
      ok: !err,
      stdout: stdout || (binary ? Buffer.alloc(0) : ''),
      stderr: String(stderr || ''),
      code: err ? err.code : null
    }));
  });
}

/**
 * ★★ 2026-10-04 新增：**adb 服务类瞬时故障自愈**（真机实测踩出来的）。
 *
 * 现象（真机连续发布 3 条时实测）：跑着跑着某一条突然整条失败，报的却是
 *   `adb: device '127.0.0.1:16384' not found` 或 `cannot connect to daemon` ——
 * 而**同一秒**手工再执行一遍同样的命令就好了。根因是 MuMu 12 自带的 adb server（36.0.0）
 * 与随包内置的 adb（37.0.1）会**抢 5037 端口**：谁后启动谁把 server 换掉，
 * 于是正在跑的这条链路会撞上「server 刚被换走」那一瞬间。
 *
 * ★ 关键区分（别把业务错误也当服务错误去重试）：
 *   · **服务类**（`cannot connect to daemon` / `failed to start daemon` / `server out of date` /
 *     `Could not install *smartsocket*` / `device '...' not found` / `device not found`）
 *     ⇒ 是可自愈的：`start-server` + `connect <net-serial>` 之后**原样重试一次**；
 *   · **业务类**（例：`ls: No such file or directory`、`Activity class does not exist`）
 *     ⇒ **原样返回、绝不重试**（重试只会浪费时间、还可能掩盖真错误）。
 *
 * ★ 实测一个反直觉的点：只 `start-server` **不足以**恢复 —— 设备是**网络端口**（127.0.0.1:16384），
 *   server 重启后那条 `-s <host:port>` 通道就没了 ⇒ 必须**再 connect 一次**。
 *   （只 start-server 的版本实测仍然失败；补 connect 后才真正自愈。）
 */
const ADB_SERVICE_ERR = /daemon still not running|cannot connect to daemon|failed to start daemon|adb server (?:is )?out of date|Could not install \*smartsocket\*|device '[^']*' not found|device not found/i;
const NET_SERIAL = /^[\w.\-]+:\d+$/;
async function execAdb(args, opts = {}) {
  const first = await execAdbOnce(args, opts);
  if (first.ok) return first;
  const blob = `${first.stderr || ''}${first.stdout || ''}`;
  if (!ADB_SERVICE_ERR.test(blob)) return first;   // 业务错误：原样返回，不重试
  await execAdbOnce(['start-server'], { timeout: 20000 });
  const arr = Array.isArray(args) ? args : [];
  const si = arr.indexOf('-s');
  const serial = si >= 0 ? String(arr[si + 1] || '') : '';
  if (serial && NET_SERIAL.test(serial)) {
    await execAdbOnce(['connect', serial], { timeout: 20000 });
  }
  return execAdbOnce(args, opts);
}

const withS = (serial, args) => (serial ? ['-s', serial] : []).concat(args);

async function version() {
  const r = await execAdb(['version']);
  return r.ok ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

async function devices() {
  const r = await execAdb(['devices']);
  if (!r.ok) return [];
  return r.stdout.split(/\r?\n/).slice(1)
    .map(l => l.trim()).filter(Boolean)
    .map(l => { const [serial, state] = l.split(/\s+/); return { serial, state }; });
}

async function online(serial) {
  const list = await devices();
  return list.find(d => d.serial === serial && d.state === 'device') || null;
}

async function shell(serial, cmd, opts) {
  return execAdb(withS(serial, ['shell', cmd]), opts);
}

async function push(serial, local, remote) {
  return execAdb(withS(serial, ['push', local, remote]), { timeout: 120000 });
}

/** /sdcard/... 与 /storage/emulated/0/... 是同一处，但 MediaStore 的 _data 记的是后者 */
function toMediaPath(p) {
  return String(p || '').replace(/^\/sdcard\//, '/storage/emulated/0/');
}

/**
 * 把刚推上去的素材**真正写进 MediaStore** —— 这是「得物相册里能不能看到它」的唯一条件。
 *
 * ★★ 2026-10-03 真机实测更正（127.0.0.1:16384 / MuMu 12 / Android 12，全部可复算）：
 *   以前这里发两条广播（MEDIA_SCANNER_SCAN_FILE / MEDIA_MOUNTED）—— 在这台设备上**完全无效**：
 *     · MEDIA_MOUNTED 是受保护广播，shell 发会被拒（Permission Denial ... from uid=2000(shell)）
 *     · MEDIA_SCANNER_SCAN_FILE 发得出去（result=0）但**没有接收者** ⇒ 文件永远不进库
 *   这就是以前「视频已推到设备，但等了 182.9s 媒体库还没索引到」的**真根因**。
 *   有效做法（两条都实测通过；优先级：单文件精准 → 整卷兜底）：
 *     a) content call --uri content://media/external/file --method scan_file --arg <绝对路径>
 *        成功返回 Bundle[{android.intent.extra.STREAM=content://media/external_primary/video/media/N}]
 *     b) content call --uri content://media --method scan_volume --arg external_primary
 *        返回 Bundle[{}]，整卷重扫（秒级）
 *   ★ `--arg` 必须给 /storage/emulated/0/... 全路径；传 /sdcard/... 会拿到空 STREAM（实测）。
 *
 * 返回 { ok, how, raw }；ok=false 时把两种方式的原始输出都带回去 —— 不假装扫成功。
 */
async function mediaScan(serial, remoteFile) {
  const abs = toMediaPath(remoteFile);
  let raw = '';
  if (abs) {
    const r = await shell(serial, `content call --uri content://media/external/file --method scan_file --arg '${abs}'`, { timeout: 30000 });
    raw = `${r.stdout || ''}${r.stderr || ''}`;
    if (r.ok && /content:\/\/media\//.test(raw)) return { ok: true, how: 'scan_file', raw };
  }
  const r2 = await shell(serial, 'content call --uri content://media --method scan_volume --arg external_primary', { timeout: 60000 });
  raw += `${r2.stdout || ''}${r2.stderr || ''}`;
  return { ok: r2.ok, how: abs ? 'scan_file→scan_volume' : 'scan_volume', raw };
}

/**
 * 「推的素材真落到设备上了吗」的落地确认（**诊断用**，主流程不再走这条）。
 *
 * ★ 2026-10-03 更正：得物相册读的是 MediaStore，所以发布前的判据是
 *   `mediaScan()` 写库 + `mediaVisible()` 确认进库（见 publisher.js）。
 *   本函数保留作诊断：把「推都没推上去」和「推上去了但没进库」两种失败分开。
 *
 * 返回 { missing: [缺失的文件], error: '' }。
 * 查不动（命令失败 / 回读条数对不上）时把所有文件都算缺失并带回原因 —— **不假装存在**。
 */
async function filesMissing(serial, remoteFiles) {
  const want = (Array.isArray(remoteFiles) ? remoteFiles : [remoteFiles]).filter(Boolean);
  if (!want.length) return { missing: [], error: '' };
  // 一个文件吐一个词（EXISTS / MISSING），顺序跟 want 一致 —— 不解析 ls 的输出格式，免得被本地化坑到
  const cmd = want.map(p => `[ -f '${p}' ] && echo EXISTS || echo MISSING`).join('; ');
  const r = await shell(serial, cmd, { timeout: 30000 });
  if (!r.ok) {
    return { missing: want.slice(), error: String(r.stderr || '').trim() || '落地确认执行失败' };
  }
  const flags = String(r.stdout || '').split(/\s+/).filter(s => s === 'EXISTS' || s === 'MISSING');
  if (flags.length !== want.length) {
    return { missing: want.slice(), error: `落地确认没查清（要查 ${want.length} 个，回了 ${flags.length} 个）` };
  }
  return { missing: want.filter((p, i) => flags[i] === 'MISSING'), error: '' };
}

/**
 * 把这个「专属相册目录」清空（媒体库记录 + 物理文件一起）。
 *
 * ★★ 2026-10-03 真机实测（127.0.0.1:16384 / MuMu 12 / Android 12）：
 *   得物相册读的就是 MediaStore ⇒「上一条的素材不许出现在这一条里」这件事必须做两半：
 *     a) 素材推到本工具**专属目录**（得物相册下拉里会变成独立相册，见 publisher 的 remoteDir）；
 *     b) 推新素材**之前**把这个目录清干净。
 *   只做 a 不做 b ⇒ 目录里累着上一条的素材，相册里照样混在一起（选图那步会选到上一条的图）。
 *
 * ★ 为什么按 _id 删、不按路径 where：
 *   `content delete --where "_data='/storage/...'"` 里的引号会被 `adb shell` 吃掉，实测报
 *   `Invalid token storage`；换成 relative_path 也一样（引号同样会被吃）。
 *   **按 _id 删完全不需要引号**：content delete --uri content://media/external/video/media/153
 *   实测：删掉记录的同时**物理文件也一起消失** —— 正是我们要的。只删文件不删记录会留下
 *   僵尸记录，得物相册里显示成黑格子，点它必弹「暂不支持的视频格式」。
 *
 * ★ 查不动时返回 ok:false 并把原因带回去 —— 不假装清干净了。清不干净是**静默错误**：
 *   选图步点前 N 格会点到上一条的图，发出去才发现。
 *
 * 返回 { ok, removed, files, error }
 */
async function clearMediaDir(serial, remoteDir) {
  const dir = toMediaPath(remoteDir).replace(/\/+$/, '') + '/';
  // ★★ 2026-10-04：路径匹配放宽成「两种写法都认」。
  //   设备上同一个文件在库里可能写成 /storage/emulated/0/DCIM/... 也可能写成 /sdcard/DCIM/...
  //   （实测两种都存在）⇒ 只比一种前缀会**漏掉一半**，那半个就是「删了但还在」的那半个。
  const dirs = [dir];
  const alt = String(remoteDir).replace(/\/+$/, '') + '/';
  if (alt !== dir) dirs.push(alt);
  const hit = [];
  let error = '';
  // ★ 表名放宽：video / images / audio / files 全扫一遍（老代码只扫前两张，漏掉的表里
  //   若挂着指向该目录的记录，得物相册照样能看见它）。
  for (const t of ['video', 'images', 'audio', 'files']) {
    const r = await shell(serial,
      'content query --uri content://media/external/' + t + '/media --projection _id:_data', { timeout: 30000 });
    if (!r.ok) {
      const e = String(r.stderr || '').trim() || ('content query(' + t + ') 执行失败');
      // files 表在部分机型上不可查 —— 不因它整体失败，但**记录在案**
      if (t === 'files' && /no such table|Invalid|Unknown|not found/i.test(e)) continue;
      if (!error) error = e;
      continue;
    }
    for (const line of String(r.stdout || '').split(/\r?\n/)) {
      const m = /_id=(\d+),\s*_data=(.+?)\s*$/.exec(line);
      if (!m) continue;
      if (!dirs.some(d => m[2].indexOf(d) === 0)) continue;
      hit.push({ table: t, id: m[1], file: m[2] });
    }
  }
  if (error) return { ok: false, removed: 0, files: hit.map(h => h.file), error };

  let removed = 0;
  for (const h of hit) {
    const r = await shell(serial, 'content delete --uri content://media/external/' + h.table + '/media/' + h.id, { timeout: 30000 });
    if (r.ok) removed++;
    else if (!error) error = String(r.stderr || '').trim() || ('content delete(' + h.id + ') 执行失败');
  }
  // ★★ 2026-10-04（第三十五轮）：按用户指令「全部删掉」，把目录**内容**清空到一条不剩。
  //   用户原话：「我跟你说全部删掉，你还考虑误杀什么？……我指令已经非常非常明确了」
  //   ⇒ 这里**不做任何"可能还有用"的保留判断**，凡在这个目录里的一律删掉。
  //   为什么以前清不干净（真机实测 2026-10-04 01:15，127.0.0.1:16384）：
  //     `ls -laR /sdcard/DCIM/Camera/bluev` 里躺着一条 10-02 23:28 的 mp4（38,919,318 B），
  //     而 `content query` 按 _data 前缀**匹配不到它**（库里没有对应记录 / 记录路径与磁盘路径
  //     写法不一致）⇒ 老代码报 `removed=0` 却**假装清干净了**，那条文件就一直留在目录里，
  //     下一条发布时得物相册里照样能看到它 ⇒ 用户看到的「第二条的相册里混着上一条的素材」。
  //   ⇒ 结论：**不能只依赖 MediaStore 记录**，必须直接对**磁盘目录**动刀（下面这步）。
  //   ★★ 2026-10-04 追加实测修正（很重要，差点踩坑）：
  //     一开始写的是 `rm -rf '<dir>'`（删目录本身），真机一跑就炸：
  //       `rm: /sdcard/DCIM/Camera/bluev: Text file busy`
  //     因为**得物 App 正停在发布页、它就打开着这个目录**。目录被占住时：
  //       rm 删不掉目录 → 接着那句 mkdir -p 也因为目录还在而"成功"得毫无意义
  //       → 如果这里判 ok，就等于**在素材最可能残留的时候假装清干净了**，比不删更糟。
  //     ⇒ 正确做法：**只删目录里的内容、绝不碰目录本身**（目录 inode 不动 ⇒ 被占也能删内容）。
  //   ★★★ 2026-10-04 第三次实测修正（引号坑，这次是真踩透了）：
  //     写成 `rm -rf '<dir>'/* '<dir>'/.[!.]*` 后 — 实测把 `ls -A` 的结果变成了**设备根目录 /
  //     的内容**（acct / apex / bin / data ... 全列出来了）。根因是 `shell()` 走 `execFile`
  //     数组传参：设备端最终执行 `sh -c '<我们拼的整串>'`，**里面的引号会被再解析一次**，
  //     我们精心写的 `'...'` 到设备端已被剥掉，`<dir>/*` 里的 `*` 就落到别的目录上了。
  //     ⇒ 结论：**不要再往设备端塞任何引号 / glob**。用 `find <dir> -mindepth 1 -delete`：
  //       路径不含空格（DCIM/Camera/bluev 全是安全字符），根本不需要引号；
  //       find 按路径递归删**内容**、不碰目录本体。
  //   ★★ 2026-10-04 第四次实测补充（重试是必需的，不是保险）：
  //     得物停在发布页时会**持有这个目录的句柄**，此时删目录内容会间歇性报
  //     `Text file busy`（实测：造一个空子目录 sub，连 `rm -rf sub`、`find -delete`、
  //     `rmdir sub` 全失败；等得物重新扫过目录后**同一句 `rmdir` 直接成功**）。
  //     ⇒ 锁是**短暂**的，不是永久的 ⇒ 删完若还有残留，**等一下重试**就能过。
  //     这解释了老代码为什么偶尔"清干净了"偶尔没有 —— 它只删一次，撞上锁就放弃了。
  //   ★★★ 2026-10-04 第五次实测修正（★ 这是最终方案，前面四次都被它取代）：
  //     实测发现 `Text file busy` **不是得物持有的** —— 把得物 `am force-stop` 掉之后
  //     同一个目录**照样报 Text file busy**（真机实测：force-stop 后 `rm -rf <dir>` 仍 rc=1）；
  //     而且报错里提到的子目录（`deep`）**其实早就不存在了** ⇒ 这是 MuMu 的
  //     sdcardfs/共享目录映射留下的**失效句柄（stale handle）**，等多久都不会自己好。
  //     ⇒ 死等重试解决不了它（实测等了 3s、60s 都照样失败）。
  //     ★ 真正有效的解法是 **`mv` 换名法**（实测同一时刻 `rm -rf` rc=1、`mv` rc=0）：
  //         把 `DCIM/Camera/bluev` 整个改名叫 `DCIM/Camera/bluev_trash_<时间戳>`，
  //         再 `mkdir` 一个新的 `bluev`。
  //       · 改名**不删任何 inode** ⇒ 不受失效句柄影响，一次就成功；
  //       · 换完之后「bluev 这个相册」里的内容 = **全新的空目录** ⇒ 得物相册下拉里的
  //         bluev 相册就是空的，正是用户要的「上一条的素材一条都不出现」；
  //       · 改名后的垃圾目录若删得掉就顺手删掉，删不掉也不影响正确性（它不在 bluev 名下，
  //         得物相册不会把它当成本工具素材；它是隐藏在外面的废目录）。
  //     ★ 顺序：先按记录删库（上面那段，能删多少删多少）→ 再 mv 换名 → 再 mkdir 新的。
  //       库记录必须先删：不然记录还指向 <dir>/xxx.mp4，而那个路径已经被换名了 ⇒ 僵尸记录。

  // ★★ 2026-10-04 第八次实测修正（这里原来也在犯「读不到 = 空的」这个错误）：
  //   原来写的是 `if (left)` —— **只看 stdout 非空、没看命令是否成功**。
  //   目录不存在时 `ls -A` 是**非零退出码 + 空输出** ⇒ `left=''` ⇒ 代码当成「目录是空的、
  //   已经干净」。判据必须和末尾那处一致：**命令成功（ok）且输出非空** 才算「有残留」。
  //   · 读不到 ≠ 没有；· 目录不存在 ≠ 目录是空的（虽然两者都算「这次不用换名」）。
  const hasLeftover = s => !!(s && s.ok && String(s.stdout || '').trim());
  // ★★ 非致命的备注（例：只剩几个清不掉的空目录残骸）—— 不阻断发布，但要如实带回去给人看。
  let dirNote = '';

  // 1) 先试「原地清内容」（绝大多数情况能过；只有 stale 句柄时才会失败）
  await shell(serial, 'find ' + dir + ' -mindepth 1 -delete 2>/dev/null', { timeout: 60000 });
  await shell(serial, 'rm -rf ' + dir + '/* ' + dir + '/.[!.]* 2>/dev/null', { timeout: 60000 });
  let stage = await shell(serial, 'ls -A ' + dir, { timeout: 30000 });
  let left = String(stage.stdout || '').trim();
  if (hasLeftover(stage)) {
    // 2) 原地清不掉（stale 句柄）⇒ mv 换名法，绕开它
    const trash = dir.replace(/\/+$/, '') + '_trash_' + Date.now();
    const mv = await shell(serial, 'mv ' + dir + ' ' + trash, { timeout: 60000 });
    if (mv.ok) {
      await shell(serial, 'mkdir -p ' + dir, { timeout: 30000 });
      // 垃圾目录能删就删（删不掉不影响正确性，留着也不进 bluev 相册）
      await shell(serial, 'rm -rf ' + trash + ' 2>/dev/null', { timeout: 60000 });
      stage = await shell(serial, 'ls -A ' + dir, { timeout: 30000 });
      left = String(stage.stdout || '').trim();
    } else {
      // ★★ 2026-10-04（第三十八轮）真机实测修正：**整个目录换名可能失败**。
      //   `mv /storage/emulated/0/DCIM/Camera <trash>` 回
      //     `mv: bad '.../DCIM/Camera/': Device or resource busy`
      //   —— Camera 是 sdcardfs 的**挂载点级目录**，它自己不能被改名（bluev 这种子目录才行）。
      //   但用户的诉求是「清空整个 Camera」，不能因为"整个换不了名"就整体放弃。
      //   ⇒ 退一步：**逐个子项处理**。每个子项自己试 `mv <child> <child>_trash_<ts>` ——
      //     子目录（bluev_trash_* 那些）能改名，改完就绕过了它的 stale 句柄；
      //     单个文件能 rm 就直接 rm。
      //   ★ 逐项循环有上限（防止目录里是垃圾海时无限跑）——上限内清不完就如实报 error，
      //     绝不假装干净。
      const kids = String(left || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      // ★★ 2026-10-04（第三十九轮）**判据矛盾修复 —— 这是「第二条起必失败」的真根因**。
      //   现象（真机复现，seq8 成功后 seq9/seq10 连续失败）：
      //     `没能清干净设备相册目录（/sdcard/DCIM/Camera）：目录里有 11 个子项清不掉也改不了名`
      //   而**同一时刻** `find /sdcard/DCIM/Camera -type f` = **0 个文件** ⇒ 相册里其实一条素材都没有。
      //   根因：这里把「清不掉的子项」（全是历次 `mv` 换名留下的**空目录残骸** `X_gone_TS…`）
      //   直接写进了 `error`；而函数末尾（另一个判据）又说「`find -type f` 为空 = 干净」。
      //   两个判据**自相矛盾**，而这里的 error 优先级更高 ⇒ 末尾那条正确的判据被它废掉了。
      //   更糟的是它**会累积**：每次发布都新增一个残骸 ⇒ 越跑越多 ⇒ 第 N 条之后**永远失败**。
      //   ⇒ 修正：**空目录残骸**只算「备注」不算失败；只有「里面真剩着文件」才是失败。
      //     判据统一成一句话：**递归找不到任何文件 = 干净**（得物相册只认文件，空目录不进相册）。
      const survivors = [];       // = 清不掉但**确认里面没有文件**的空目录残骸（只记 note）
      const withFiles = [];       // = 清不掉且**里面还有文件**的子项（真失败）
      for (let i = 0; i < kids.length && i < 200; i++) {
        const child = dir.replace(/\/+$/, '') + '/' + kids[i];
        // ★ 逐项最多试两轮：第一轮 rm（删内容 + 删空目录）；删不掉就换名绕开句柄；
        //   换名后的垃圾名再进下一轮（循环会重新 `ls -A` 拿到新名字）。
        const rmv = await shell(serial, 'rm -rf ' + child + ' 2>/dev/null', { timeout: 30000 });
        let probe = child;   // 探哪个路径：没换名 = 原名；换了名 = 新名（原路径已经不存在了）
        let stillThere = await shell(serial, 'ls -d ' + child + ' 2>/dev/null', { timeout: 20000 });
        if (String(stillThere.stdout || '').trim()) {
          // ★★★ 2026-10-04（第三十九轮）**不再对「空目录」换名 —— 换名是残骸的元凶**。
          //   真机实测：残骸目录名会**一路加后缀直到 255 字符**（Linux 文件名上限）——
          //   到那时 `mv` 必然报 `File name too long`、`rm` 又删不掉 ⇒ **永久卡死**。
          //   而它之所以会滚成那样，正是因为老代码「只要 rm 不掉就换名」：
          //   每次清相册都给残骸再加一截 `_gone_<ts>`，越滚越长、越多，还**每条发布都新增**。
          //   ⇒ 修正：**先看里面有没有文件**——
          //     · 没有文件（纯空目录残骸）⇒ 只试 `rm``rmdir`，**绝不换名**（换名只会把名字撑爆）；
          //     · 真有文件删不掉 ⇒ 这时才值得换名（文件必须先离开相册，名字长短无所谓）。
          const fin0 = await shell(serial, 'find ' + child + ' -type f 2>/dev/null', { timeout: 20000 });
          const childHasFiles = !!String(fin0.stdout || '').trim();
          if (childHasFiles) {
            const ctrash = child + '_gone_' + Date.now();
            const cmv = await shell(serial, 'mv ' + child + ' ' + ctrash, { timeout: 30000 });
            if (cmv.ok) {
              // 换名成功后，把垃圾名也顺手删一次（大多删不掉，但不影响正确性）
              await shell(serial, 'rm -rf ' + ctrash + ' 2>/dev/null', { timeout: 60000 });
              probe = ctrash;
              stillThere = await shell(serial, 'ls -d ' + ctrash + ' 2>/dev/null', { timeout: 20000 });
            }
          } else {
            // 空目录：补一次 rmdir（stale 句柄偶尔会被 rmdir 而不是 rm 放行，实测有效）
            await shell(serial, 'rmdir ' + child + ' 2>/dev/null', { timeout: 20000 });
            stillThere = await shell(serial, 'ls -d ' + child + ' 2>/dev/null', { timeout: 20000 });
          }
        }
        // ★ 换名也没清掉 ⇒ 看看它**里面到底还有没有文件**，按这个定性质（不是按「目录还在」定）。
        if (String(stillThere.stdout || '').trim()) {
          const fin = await shell(serial, 'find ' + probe + ' -type f 2>/dev/null', { timeout: 20000 });
          if (String(fin.stdout || '').trim()) withFiles.push(kids[i]);
          else survivors.push(kids[i]);
        }
        void rmv;
      }
      // ★ 反复扫到「没有变化」为止：换名会**造出新的垃圾目录名**（`X_gone_TS`），
      //   它们下一轮才会被看见 ⇒ 单趟扫不干净。最多 4 轮，每轮都要有进展，
      //   否则如实报 error（绝不假装干净）。
      for (let round = 0; round < 4; round++) {
        stage = await shell(serial, 'ls -A ' + dir, { timeout: 30000 });
        const now = String(stage.stdout || '').trim();
        if (!now) break;
        await shell(serial, 'find ' + dir + ' -mindepth 1 -delete 2>/dev/null', { timeout: 60000 });
        const after = await shell(serial, 'ls -A ' + dir, { timeout: 30000 });
        if (String(after.stdout || '').trim() === now) break;   // 没进展 ⇒ 停
      }
      stage = await shell(serial, 'ls -A ' + dir, { timeout: 30000 });
      left = String(stage.stdout || '').trim();
      // ★★ 只有「里面**真还有文件**」的子项才算清不干净（= 相册里可能还挂着素材 ⇒ 必须失败）。
      //   空目录残骸（stale 句柄锁着、改名也删不掉）**不算失败**，如实记进 note ——
      //   详见上面第三十九轮的说明：把空目录当失败，会让残骸累积到「第二条起永远发不出去」。
      if (withFiles.length && !error) {
        error = '目录里有 ' + withFiles.length + ' 个子项里面的文件删不掉（前几个：'
          + withFiles.slice(0, 3).join(' , ') + '）';
      }
      if (survivors.length && !dirNote) {
        dirNote = '另有 ' + survivors.length + ' 个清不掉的空目录残骸（stale 句柄锁着，不含任何素材）';
      }
    }
  }
  // 3) 兜底重试：换名后仍残留（极罕见）⇒ 再原地清两次
  for (let attempt = 1; attempt <= 2 && hasLeftover(stage); attempt++) {
    await new Promise(r => setTimeout(r, 800));
    await shell(serial, 'find ' + dir + ' -mindepth 1 -delete 2>/dev/null', { timeout: 60000 });
    stage = await shell(serial, 'ls -A ' + dir, { timeout: 30000 });
    left = String(stage.stdout || '').trim();
  }
  // ★★ 2026-10-04 第六次实测修正：目录**不存在**时也必须算「干净」并把它建出来。
  //   实测踩到：把 bluev 目录整个 mv 走了之后，`ls -A <dir>` 返回
  //     `ls: .../bluev/: No such file or directory` ⇒ 老判据会把它当成"校验失败"报 ok:false，
  //     于是**第一条内容永远发不出去**（每次都在清相册这步卡死）。这个坑比它看起来严重得多。
  //   ★★★ 2026-10-04 第七次实测修正（这一段先说 `ls`、**再** mkdir —— 顺序不能反）：
  //     第一版把它写成「先 `mkdir -p` 再 `ls -A`」⇒ 两个后果，都是真 bug：
  //       ① `missing` 分支变成**死代码**（mkdir 已经建好了，ls 永远不会报 No such file）
  //          ⇒ 反向验证时「删掉 missing 分支」一条测试都不红（假通过）；
  //       ② 更危险：ls 若因**别的原因**失败（权限、挂载掉了），会被 `left = ''` 当成
  //          「干净」放过去 —— 这就是在**假装清干净了**，正是我们的红线。
  //     ⇒ 正确顺序：**先 `ls -A` 定状态**（此时目录还没被 mkdir 造出来，missing 判据才有效），
  //       确认真需要建目录之后，再 `mkdir -p`；只有「明确 clean」才允许往下走。
  //   三态判据：① 目录不存在 = 干净（顺手建出来）；② 存在且 ls 空 = 干净；
  //            ③ 其余（含 ls 失败） = 不干净，如实报 error。
  const chk = await shell(serial, 'ls -A ' + dir, { timeout: 30000 });
  const chkOut = String(chk.stdout || '').trim();
  const missing = /No such file or directory|not found/i.test(chkOut + String(chk.stderr || ''));
  const needsMkdir = !chk.ok && missing;
  if (needsMkdir) {
    // 目录不存在 ⇒ 本来就干净，把它建出来（后面推素材要用）
    left = '';
  } else if (!chk.ok) {
    // ★ 不许在这里判「干净」：ls 读不出来时必须如实报错（读不到 ≠ 没有）
    if (!error) error = String(chk.stderr || '').trim() || 'ls -A 校验失败（读不到目录，不敢判干净）';
    left = '';
  } else {
    left = chkOut;
  }
  // 只有「这次真的需要建目录」时才建；正常存在的情况不动它（免得掩盖上面的读失败）
  if (needsMkdir) {
    const mk = await shell(serial, 'mkdir -p ' + dir, { timeout: 30000 });
    if (!mk.ok && !error) error = String(mk.stderr || '').trim() || '专属目录建不出来';
  }
  if (error) return { ok: false, removed: removed, files: hit.map(h => h.file), error };
  if (left) {
    // ★★★ 2026-10-04（第三十八轮）**判据修正：看「还有没有文件」，不是「目录 listing 空不空」**。
    //   真机实测（MuMu 12 / sdcardfs）：`mv` 换名法能把**内容**搬走、也造出了全新的空目录，
    //   但被换名的那批垃圾目录（`X_trash_TS`）**永远删不掉**（stale 句柄跟着 inode 走，
    //   改名后照样锁着）⇒ `ls -A` 永远非空、越清越多，父目录（Camera 根）**结构上就不可能空**。
    //   而 `find <dir> -type f` 实测**一个文件都没有**（`du -a` 每项 0 字节）——
    //   也就是**一个字节的媒体都没剩**。得物相册只认**文件**（空目录不进 MediaStore、相册里不显示格），
    //   所以「目录 listing 非空」≠「相册还有素材」。
    //   ⇒ 判据换成：**递归找不到任何文件 = 干净**；只剩空目录那堆残骸，记一条 warn 照常放行。
    //     （若不这么判，用户设备上积了几百个空垃圾目录之后，**每一条都发不出去** —— 那才是真误杀。）
    const fchk = await shell(serial, 'find ' + dir + ' -type f 2>/dev/null', { timeout: 30000 });
    const filesLeft = String(fchk.stdout || '').trim();
    if (!fchk.ok) {
      if (!error) error = String(fchk.stderr || '').trim() || 'find -type f 校验失败（读不到目录，不敢判干净）';
    } else if (filesLeft) {
      return { ok: false, removed: removed, files: hit.map(h => h.file),
        error: '目录里还有 ' + filesLeft.split(/\r?\n/).length + ' 个文件没删掉（前几个：'
          + filesLeft.split(/\r?\n/).slice(0, 3).join(' , ') + '）' };
    } else {
      // 只剩空目录残骸（stale 句柄锁着、改名也删不掉）⇒ 不影响相册，如实记一笔放行
      const n = left.split(/\r?\n/).length;
      const note = dirNote || ('只剩 ' + n + ' 个空目录残骸（stale 句柄锁着，删不掉但不含任何素材）');
      return { ok: true, removed: removed, files: hit.map(h => h.file), error: '', note };
    }
  }
  return { ok: true, removed: removed, files: hit.map(h => h.file), error: '', note: dirNote };
}

async function screencap(serial, outFile) {
  const r = await execAdb(withS(serial, ['exec-out', 'screencap', '-p']), { timeout: 20000, binary: true });
  if (!r.ok || !r.stdout.length) return null;
  return r.stdout;
}

/**
 * 媒体库里能不能看见这几个文件（= 得物相册里有没有它）。
 *
 * ★★ 2026-10-03 实测：得物相册**就是**读 MediaStore —— 同一条 mp4，没进库时相册里看不到，
 *   `scan_file` 索引进库后冷启动得物打开相册，它立刻出现在第 1 格。所以这一条是**硬判据**：
 *   `mediaScan()` 写完库必须在这里等到「真能看见」，否则得物那边根本选不到这条素材。
 * ★ 两张表一起查（video + images）：图文发的是图片，老版本只查 video 表会把图文判成失败。
 *
 * 查不动这条命令时返回 ok:false 并把原始输出带回去 —— 不假装看到、也不假装没看到。
 * 返回 { ok, waited(秒), rows, error }
 */
async function mediaVisible(serial, remoteFiles, { timeoutMs = 20000, pollMs = 800, onTick } = {}) {
  const want = (Array.isArray(remoteFiles) ? remoteFiles : [remoteFiles]).filter(Boolean);
  if (!want.length) return { ok: true, waited: 0, rows: '' };
  const t0 = Date.now();
  let rows = '';
  let lastErr = '';
  for (;;) {
    // 一条 shell 里查两张表，省一次往返
    const r = await shell(serial,
      'content query --uri content://media/external/video/media --projection _data; '
      + 'content query --uri content://media/external/images/media --projection _data', { timeout: 20000 });
    rows = String(r.stdout || '');
    lastErr = String(r.stderr || '').trim();
    if (r.ok && want.every(p => rows.includes(toMediaPath(p)) || rows.includes(p))) {
      return { ok: true, waited: +((Date.now() - t0) / 1000).toFixed(1), rows };
    }
    const waited = Date.now() - t0;
    if (waited >= timeoutMs) {
      return { ok: false, waited: +(waited / 1000).toFixed(1), rows, error: r.ok ? '' : (lastErr || 'content query 执行失败') };
    }
    if (onTick) onTick(Math.round(waited / 1000));
    await new Promise(res => setTimeout(res, pollMs));
  }
}

const DUMP_REMOTE = '/sdcard/bluev_window.xml';
/**
 * 系统动画开关（三个）。得物发布页上有一个跟随它运行的循环动画：
 * 实测 animator_duration_scale=1 时 uiautomator 永远等不到 idle（连续 60 次、约 10 分钟全失败），
 * 同一秒内只把它置 0 就能立刻抓到 —— 所以「关动画重试一次，抓完还原」是可行的兜底。
 */
const ANIM_KEYS = ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale'];

const sleepMs = ms => new Promise(res => setTimeout(res, Math.max(0, Number(ms) || 0)));

/** 读三个动画开关；读不齐就不动它们（宁可重试失败，也不猜着改回去） */
async function animGet(serial) {
  const r = await shell(serial, ANIM_KEYS.map(k => `settings get global ${k}`).join('; '));
  if (!r.ok) return null;
  const vals = String(r.stdout || '').trim().split(/\s+/);
  if (vals.length !== ANIM_KEYS.length) return null;
  return vals;
}

/** 关闭三个动画开关 */
async function animSet(serial, v) {
  return shell(serial, ANIM_KEYS.map(k => `settings put global ${k} ${v}`).join('; '));
}

/** 还原；原本「没设过」的要用 delete，别把字面量 "null" 写进去 */
async function animRestore(serial, vals) {
  const cmd = ANIM_KEYS
    .map((k, i) => (vals[i] === 'null' ? `settings delete global ${k}` : `settings put global ${k} ${vals[i]}`))
    .join('; ');
  return shell(serial, cmd);
}

/**
 * 抓一次，成功/失败都给出结构化结果 —— **绝不会返回上一次的旧内容**。
 *
 * 为什么要先 rm：uiautomator dump 失败时**不写文件**（实测「页面不 idle」失败后，
 * 目标文件仍是上一次的 47 字节哨兵，一字未动）。而旧实现是共用一个远端路径、
 * 抓完直接 cat，且不检查 dump 的返回 —— 失败时会把**上一个页面**的结构当成本页返回，
 * 调用方于是拿着旧页面的坐标去点新页面。这是「静默点错」，比报错危险得多。
 */
const DUMP_SPLIT = '___BLUEV_DUMP_SPLIT___';

async function dumpOnce(serial) {
  // ★ 2026-10-03 提速：rm / dump / cat 原来是**三次** adb 往返，每次固定 ~110-180ms
  //   ⇒ 每条内容 21 个点击步白花 ~4.6s。合成一条 shell 后只剩一次往返。
  //   失败判据（“没输出” vs “读不出来”）一字未改，只是从「看整体输出」改成「看标记前半段」。
  const r = await shell(serial,
    `rm -f ${DUMP_REMOTE}; uiautomator dump ${DUMP_REMOTE} 2>&1; echo ${DUMP_SPLIT}; cat ${DUMP_REMOTE} 2>&1`,
    { timeout: 40000 });
  const all = String(r.stdout || '');
  const cut = all.indexOf(DUMP_SPLIT);
  const head = (cut >= 0 ? all.slice(0, cut) : all).trim();
  const body = cut >= 0 ? all.slice(cut + DUMP_SPLIT.length) : '';
  if (!/dumped to/i.test(head)) {
    const last = head.split(/\r?\n/).map(s => s.trim()).filter(Boolean).pop() || '';
    // ★★ 2026-10-03 真机实测：得物发布页首屏（选素材相册）有时**一个字都不打印**，
    //   而不是报 “could not get idle state”。症状不同、病因一样（页面永远不 idle）。
    //   旧判据只认 “idle state” ⇒ 「临时关动画重试」那条路根本不会走，
    //   直接掉到 dumpsys 备用通道（那条拿不到文字）。
    //   实测：关掉三个系统动画开关后，同一屏一次就抓到（85 个节点）。
    const looksIdle = /idle state/i.test(head) || !head;
    return { ok: false, idle: looksIdle, why: last || 'uiautomator dump 没有任何输出' };
  }
  if (!r.ok || !/</.test(body)) return { ok: false, idle: false, why: 'dump 已写出，但内容读不出来' };
  return { ok: true, xml: body.replace(/^\s*[\s\S]*?<\?xml/, '<?xml').trim() };
}

/**
 * dump 的详细版：拿不到时告诉调用方**为什么**（是页面不 idle，还是设备不在线）。
 * 返回 { ok, xml?, why, idle, animOff }
 */
async function dumpEx(serial, { retries = 1, retryMs = 1200, allowAnimOff = true, pkg = '', preferAnimOff = false } = {}) {
  let last = { ok: false, idle: false, why: '未尝试' };
  // ★★ 2026-10-03 提速：已经知道「这一屏不会 idle」时，**直接走关动画那条路**，
  //   不再先白等一次 uiautomator 的 idle 超时。
  //   真机实测（MuMu 12 / 得物相册页）：裸 dump 连打 3 次 11230/11136/11127 ms 全部
  //   `could not get idle state`；同一张屏关掉系统动画后 2036ms 就抓到。
  //   ⇒ 那 ~11 秒纯粹是白等。批量发布里同一条屏每条内容都要经过一次，
  //     所以由调用方（publisher）按**步骤**记住它，本批第 2 条起直接从这里进。
  //   动画开关照旧**抓完立刻还原**（finally），不把用户设备留在改过的状态。
  if (preferAnimOff && allowAnimOff) {
    const before0 = await animGet(serial);
    if (before0) {
      await animSet(serial, 0);
      try {
        const r0 = await dumpOnce(serial);
        if (r0.ok) return { ok: true, xml: r0.xml, why: '', animOff: true, via: 'uiautomator' };
        last = Object.assign({ animOff: true }, r0);
      } finally {
        await animRestore(serial, before0);
      }
    }
  }
  for (let i = 0; i <= retries; i++) {
    const r = await dumpOnce(serial);
    if (r.ok) return { ok: true, xml: r.xml, why: '', animOff: false, via: 'uiautomator' };
    last = r;
    if (i < retries) await sleepMs(retryMs);
  }
  if (last.idle && allowAnimOff) {
    const before = await animGet(serial);
    if (!before) {
      last = Object.assign({}, last, {
        why: last.why + '（想临时关掉系统动画重试，但读不到设备的动画开关，所以没动它）'
      });
    } else {
      await animSet(serial, 0);
      try {
        const r = await dumpOnce(serial);
        if (r.ok) return { ok: true, xml: r.xml, why: '', animOff: true, via: 'uiautomator' };
        last = Object.assign({ animOff: true }, r, { why: r.why || last.why });
      } finally {
        // 无论成功还是抛错都还原：不能把用户设备的设置留在改过的状态
        await animRestore(serial, before);
      }
    }
  }
  // ★★ 最后一道：uiautomator 对这个页面彻底没辙时，退到 dumpsys（**不等 idle**）。
  //    只在 uiautomator 全败时才走这条路 ⇒ 能正常抓的页面行为一点不变。
  if (pkg) {
    const v = await dumpViaDumpsys(serial, pkg);
    if (v.ok) return { ok: true, xml: v.xml, why: '', animOff: false, via: 'dumpsys', noText: true };
    last = Object.assign({}, last, { why: last.why + '（dumpsys 备用通道也没抓到：' + v.why + '）' });
  }
  return Object.assign({ animOff: false, via: 'uiautomator' }, last);
}

/**
 * ★★ 备用抓取通道：`dumpsys activity top`。
 *
 * 为什么需要它：`uiautomator dump` 要等窗口 idle，而**持续动画的页面永远等不到** ——
 * 得物发布页首屏（选素材的相册）实测连试十几次、`--compressed`、关系统动画、静置 15 秒
 * 全部报 `could not get idle state`（2026-10-02 实机）。而 dumpsys **不等 idle**，
 * 它直接打印各 task 的 View Hierarchy。
 *
 * 代价（如实说明，不美化）：
 *   · **拿不到 text** —— 只有 class / resource-id / bounds / clickable；
 *   · 给的是**整棵树**（含滚出屏幕的节点）⇒ 靠 `V` 标志 + bounds 非零过滤；
 *   · 坐标是**相对父节点**的 ⇒ 按缩进还原层次后逐级累加。
 *     已与 uiautomator 结果交叉验证：2026-10-02 同一屏 43 个同名控件坐标完全一致（±2px）。
 */

/** dumpsys View Hierarchy 的一行：`<缩进><类名>{<hash> <flags> <bounds> [#<idhex> <resource-id>]}`
 *  flags 第 0 位 V=可见；第 6 位 C=clickable（View.toString 的固定次序） */
const VH_LINE = /^(\s*)([A-Za-z0-9_.$]+)\{([0-9a-f]+)\s+([^}]*?)\s*(\d+,\d+-\d+,\d+)(?:\s+#([0-9a-f]+)(?:\s+(\S+))?)?\}$/;

/** 把 `dumpsys activity top` 的输出里**目标包**那一段 View Hierarchy 转成 uiautomator 风格的 XML */
function vhToXml(txt, pkg) {
  const lines = String(txt || '').split(/\r?\n/);
  let want = false, inVh = false;
  const vh = [];
  for (const ln of lines) {
    if (/^TASK /.test(ln)) { want = ln.includes(pkg); inVh = false; continue; }
    if (!want) continue;
    if (!inVh) { if (ln.trim() === 'View Hierarchy:') inVh = true; continue; }
    const ind = ln.length - ln.replace(/^\s+/, '').length;
    if (ln.trim() && ind <= 4) break;          // 已经走出这一段
    if (ln.trim()) vh.push(ln);
  }
  if (!vh.length) return null;

  const out = [];
  const stack = [];                            // [indent, 绝对x, 绝对y]
  for (const ln of vh) {
    const m = VH_LINE.exec(ln);
    if (!m) continue;                          // `DecorView@2bc4ef[Activity]` 这种没有 bounds，跳过
    const ind = m[1].length;
    const cls = m[2];
    const flags = m[4] || '';
    const rid = m[7] || '';
    const b = m[5].split(/[,\-]/).map(Number); // x1,y1,x2,y2（相对父节点）
    while (stack.length && stack[stack.length - 1][0] >= ind) stack.pop();
    const p = stack.length ? stack[stack.length - 1] : null;
    const px = p ? p[1] : 0, py = p ? p[2] : 0;
    const x1 = px + b[0], y1 = py + b[1], x2 = px + b[2], y2 = py + b[3];
    stack.push([ind, x1, y1]);
    if (flags[0] !== 'V' || x2 <= x1 || y2 <= y1) continue;   // 不可见 / 没布局 → 不收
    const id = rid ? rid.replace(/^app:id\//, pkg + ':id/') : '';
    out.push('<node class="' + cls + '" resource-id="' + id + '" package="' + pkg
      + '" clickable="' + ((flags[6] || '') === 'C') + '" text=""'
      + ' content-desc="" bounds="[' + x1 + ',' + y1 + '][' + x2 + ',' + y2 + ']" />');
  }
  if (!out.length) return null;
  return "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n<hierarchy rotation=\"0\">\n  "
    + out.join('\n  ') + '\n</hierarchy>\n';
}

/** 走 `dumpsys activity top` 抓一屏。失败返回 { ok:false, why } */
async function dumpViaDumpsys(serial, pkg) {
  if (!pkg) return { ok: false, why: '没给包名，不知道抠哪一段' };
  const r = await shell(serial, 'dumpsys activity top', { timeout: 30000 });
  if (!r.ok) return { ok: false, why: 'dumpsys activity top 跑不起来' };
  const xml = vhToXml(String(r.stdout || ''), pkg);
  if (!xml) return { ok: false, why: 'dumpsys 里没有「' + pkg + '」的 View Hierarchy' };
  return { ok: true, xml };
}


let lastDump = null;
/** uiautomator dump → XML；抓不到返回 null（保持老调用方的契约）。要原因用 dumpEx。 */
async function dump(serial, opts) {
  lastDump = await dumpEx(serial, opts);
  return lastDump.ok ? lastDump.xml : null;
}

/** 最近一次 dump 的详情，供日志/界面说明「为什么抓不到」 */
function lastDumpInfo() {
  return lastDump;
}

async function tap(serial, x, y) {
  return shell(serial, `input tap ${Math.round(x)} ${Math.round(y)}`);
}

/**
 * ★ 一次 shell 里连点多个坐标（2026-10-03 加速）。
 *
 * 实测（MuMu 12 / Android 12，1080x1920）：
 *   · 每条 `adb shell` 固定 ~120ms（进程启动 + 往返），设备端 `input` 本身几乎不耗时；
 *   · 3 次点击**分三条**发 ~380ms，**合一条**发只要 ~127ms。
 * ⇒ 多点步骤一律走这里，省掉 N-1 次往返。gapMs>0 时在**设备端** `sleep`（小数秒），
 *   仍然只发一条 shell —— 别改回「JS 侧 sleep + 逐条发」，那样两个开销都躲不掉。
 * 坐标非法一律返回 ok:false（**不静默跳过**：少点一格＝少选一张图，发出去才发现，最难查）。
 */
async function tapSeq(serial, points, gapMs = 0) {
  const pts = (Array.isArray(points) ? points : [])
    .filter(p => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)));
  if (!pts.length) return { ok: false, stdout: '', stderr: 'tapSeq：没有可点的坐标' };
  const gap = Math.max(0, Number(gapMs) || 0);
  const sec = (gap / 1000).toFixed(2);
  const cmd = pts.map((p, i) =>
    ((i && gap > 0) ? `sleep ${sec}; ` : '') + `input tap ${Math.round(Number(p.x))} ${Math.round(Number(p.y))}`
  ).join('; ');
  return shell(serial, cmd, { timeout: 20000 + pts.length * (gap + 1000) });
}

async function keyevent(serial, code) {
  return shell(serial, `input keyevent ${code}`);
}

const IME_COMPONENT_DEFAULT = 'com.android.adbkeyboard/.AdbIME';

/** 设备「已启用」的输入法里有没有 ADBKeyboard（返回组件名，没有则空串） */
async function adbKeyboardIme(serial) {
  const r = await shell(serial, 'ime list -s');
  if (!r.ok) return '';
  return String(r.stdout || '').split(/\r?\n/).map(s => s.trim()).find(s => /adbkeyboard/i.test(s)) || '';
}

/** 设备当前默认输入法组件名（用来分辨「装了但没启用」） */
async function defaultIme(serial) {
  const r = await shell(serial, 'settings get secure default_input_method');
  return r.ok ? String(r.stdout || '').trim() : '';
}

/**
 * 设备现在**真的能用 ADBKeyboard 打中文**吗。
 *
 * ★ 判据只有一个：**它是不是设备当前的输入法**（`settings get secure default_input_method`）。
 *   注意三种状态别混：① 没装 ② 装了但没 `ime enable` ③ 启用了但不是当前输入法 ——
 *   ②③ 两种下 `ADB_INPUT_TEXT` 广播都**没有接收者**（接收器是跟着 AdbIME 服务动态注册的，
 *   实测 `cmd package query-receivers -a ADB_INPUT_TEXT` 回 `No receivers found`）。
 *
 * ★ 故意**不做缓存**：一次发布里输入步骤也就几条，多出来的是一次 `settings get`（几十毫秒），
 *   而缓存会带来「用户刚点了装输入法、前几秒还被判为没启用」这种假失败 —— 不值得。
 *   读不到就重试一次；仍读不到按「不可用」处理（宁可不发，也不发一条没标题的帖子）。
 */
async function keyboardReady(serial) {
  let current = await defaultIme(serial);
  if (!current) current = await defaultIme(serial);
  return { active: /adbkeyboard/i.test(current), current };
}

/**
 * 往当前焦点输入框里打字。
 *
 * ★★ 这一条踩过两个坑，都是实测出来的（2026-10-02，MuMu 12 / Android 12，
 *    拿 Chrome 地址栏当靶子，截图取证）：
 *
 *   ① **`input text` 注不进中文。** `input text "中文标题"` 打完之后地址栏**纹丝不动**
 *      （同一流程里 `input text "abc"` 正常进框），而这条命令**退出码是 0、标准输出为空** ——
 *      光看返回值发现不了。⇒ 中文只有 `ADB_INPUT_TEXT` 广播这一条路，没有"退而求其次"。
 *
 *   ② **广播的返回码也不能当成功依据。** `am broadcast -a ADB_INPUT_TEXT` 在「有人接」
 *      和「没人接」两种情况下返回**一模一样**（都是 `Broadcast completed: result=0`）。
 *      ⇒ 旧实现拿 `result=0` 当"打进去了"，等于给「中文压根没进去」盖了个合格的章；
 *        更早的实现则把这条判断整个交给了配置项 `publish.adbKeyboard`，而这个键
 *        **全仓没有任何地方会写它**（界面没开关、默认配置里也没有）⇒ 恒为假
 *        ⇒ 中文永远走 `input text` ⇒ 标题/正文永远是空的，流程却一路报「发布成功」。
 *
 * 所以这里改成：**先问设备真实状态，再决定怎么发**；中文打不进去就**明确失败**，
 * 让上层如实报错，绝不静默退化去 `input text` 假装成功。
 */
async function inputText(serial, text) {
  const s = String(text == null ? '' : text);
  const esc = s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/ /g, '%s');
  const asciiOnly = /^[\t\n\r\x20-\x7E]*$/.test(s);

  // 纯 ASCII：`input text` 实测可用，而且不依赖设备上的输入法状态，优先用它
  if (asciiOnly) return shell(serial, `input text "${esc}"`);

  const kbd = await keyboardReady(serial);
  if (!kbd.active) {
    const short = s.length > 12 ? s.slice(0, 12) + '…' : s;
    return {
      ok: false, code: 'ime-not-active', stdout: '',
      stderr: `要输入的内容「${short}」里有中文（或其它非 ASCII 字符），这类字符只有 ADBKeyboard 能打进去，`
        + `而设备上它现在不是当前输入法（当前是 ${kbd.current || '未知'}）—— 广播没有人接收，一个字也进不去。`
        + '（不要去改「用 input text 硬打」：实测它对中文无效，却照样返回成功，会把没标题没正文的帖子发出去。）'
        + '处理：到「模拟器发布」页点一次「一键装上中文输入法」，再重新发布。'
    };
  }
  return shell(serial, `am broadcast -a ADB_INPUT_TEXT --es msg "${esc}"`);
}

/**
 * 一键装上内置的中文输入法。★ **三步缺一不可**：
 *   ① `adb install -r ADBKeyboard.apk`
 *   ② `ime enable <组件>` —— 只装了不启用，`ADB_INPUT_TEXT` 广播没人接
 *   ③ `ime set <组件>`    —— 不设成当前输入法，中文仍然打不进输入框
 *
 * ★ 副作用必须说清：设成默认输入法后，**在模拟器里手动点输入框不会弹出键盘**
 *   （ADBKeyboard 就是个"给脚本用的"输入法，这是它的正常表现）。
 *   所以这一步**只由用户点按钮触发，绝不自动做**。
 */
async function installKeyboard(serial) {
  const apk = bundledApk;
  if (!apk) return { ok: false, step: 'apk', error: '这个安装包里没有内置中文输入法（ADBKeyboard.apk）' };
  if (!fs.existsSync(apk)) return { ok: false, step: 'apk', error: `内置的 ${path.basename(apk)} 找不到：${apk}` };

  const inst = await execAdb(withS(serial, ['install', '-r', apk]), { timeout: 180000 });
  const instText = String(inst.stdout || '') + String(inst.stderr || '');
  if (!inst.ok || !/Success/i.test(instText)) {
    return { ok: false, step: 'install', error: instText.trim() || `adb install 退出码 ${inst.code}`, raw: instText.trim() };
  }

  const comp = (await adbKeyboardIme(serial)) || IME_COMPONENT_DEFAULT;
  const en = await shell(serial, `ime enable ${comp}`);
  const st = await shell(serial, `ime set ${comp}`);
  const after = await defaultIme(serial);
  const nowDefault = /adbkeyboard/i.test(after);
  return {
    ok: nowDefault, step: nowDefault ? 'done' : 'ime', apk, component: comp, defaultIme: after,
    error: nowDefault ? '' : `输入法装好了，但没能设成默认（现在默认的是 ${after || '未知'}）—— 原始输出：`
      + (String(en.stdout || '') + String(st.stdout || '') + String(st.stderr || '')).trim(),
    raw: (instText + '\n' + en.stdout + '\n' + st.stdout).trim()
  };
}

async function packages(serial, filter) {
  const r = await shell(serial, 'pm list packages');
  if (!r.ok) return [];
  return r.stdout.split(/\r?\n/).map(l => l.replace('package:', '').trim()).filter(Boolean)
    .filter(p => !filter || p.includes(filter));
}

/**
 * 当前抢焦点的窗口 / Activity 原文。
 *
 * 用途只有一个：dump 抓不到时，告诉用户**当时停在哪一屏**。
 * 实测（2026-10-02）：同一个得物发布页（TotalPublishProcessActivity），卡住时连续 4 次
 * `could not get idle state`（连临时关掉系统动画都救不了）；把 App 切到后台再回前台之后，
 * 同一页同一窗口 id **8/8 全部抓到**。所以「抓不到」是**跟当前这一屏的状态有关**的，
 * 不写清停在哪一屏，用户只会以为工具坏了。
 */
async function currentFocus(serial) {
  const r = await shell(serial, 'dumpsys window | grep mCurrentFocus');
  const s = String(r.stdout || '').trim();
  // ★★ 2026-10-04 实测修正：`mCurrentFocus` 有两种**真实**写法，老正则只认一种：
  //   · 发布页这类：`com.shizhuang.duapp/media.publish.activity.TotalPublishProcessActivity`（全类名）
  //   · 首页这类：  `com.shizhuang.duapp/.modules.home.ui.HomeActivity`（**短类名**，斜杠后有点）
  //   老正则写成 `\/[A-Za-z0-9_.$]+`，斜杠后**不许有点** ⇒ 首页被解析成空串 ⇒
  //   「回主线」守卫每次都以为「读不到前台」⇒ 每条都白拉一次 App（实测白等十几秒）。
  //   ⇒ 放宽成 `/\.?[A-Za-z0-9_.$]+`（斜杠后允许一个可选的前导点）。
  const m = s.match(/mCurrentFocus=Window\{[^}]*?\s([A-Za-z0-9_.]+\/\.?[A-Za-z0-9_.$]+)\}/);
  return m ? m[1] : '';
}

/**
 * ★★ 2026-10-04 新增：`dumpsys activity top` 里**栈顶**那个 Activity（整栈 dump，必须只取第一条）。
 *
 * 为什么不用 `currentFocus` 就够：两者取的是不同来源 —— `mCurrentFocus` 是窗口焦点，
 * 有些转场/无窗口场景读不到；`dumpsys activity top` 是整栈 dump。实测两者互补。
 * ★ 坑：`dumpsys activity top` 会**把整个 task 栈打出来**（多个 `ACTIVITY ` 行），
 *   只有**第一行**是栈顶。老写法直接 `grep ACTIVITY` 会拿到底下那个（上一屏）⇒ 判错。
 *   ⇒ 用 `grep -m1` 在**设备端**先筛（既取第一行、又省传输）。
 */
async function frontActivity(serial) {
  const r = await shell(serial, 'dumpsys activity top | grep -m1 "ACTIVITY "');
  const s = String(r.stdout || '').trim();
  return s;
}

/** `dumpsys activity top` 里含指定 Activity 名的**栈顶**那条（名字先消毒，避免拼进 shell） */
async function topActivityMatching(serial, want) {
  const safe = String(want || '').replace(/[^A-Za-z0-9_.$]/g, '');
  if (!safe) return '';
  const r = await shell(serial, 'dumpsys activity top | grep -m1 "' + safe + '"');
  return r.ok ? String(r.stdout || '').trim() : '';
}

/** focus 字符串是不是属于某个 Activity 名（`pkg/全名` 与 `pkg/.短名` 都认） */
function isFocusOf(focus, activity) {
  const a = String(activity || '').replace(/^\//, '');
  if (!a) return false;
  const f = String(focus || '');
  if (!f) return false;
  // 去掉包名前缀后再比：pkg/.modules.home.ui.HomeActivity → .modules.home.ui.HomeActivity
  const cls = f.replace(/^[^/]*\//, '');
  const shortA = a.replace(/^.*\.([A-Za-z0-9_$]+)$/, '$1');
  const shortF = cls.replace(/^.*\.([A-Za-z0-9_$]+)$/, '$1');
  return cls === a || cls.replace(/^\./, '') === a || shortF === shortA
    || cls.indexOf(a) >= 0 || (!!shortA && shortF === shortA);
}

/**
 * ★★ 2026-10-04 新增：**把 App 拉回指定的一屏，并确认它真的到了**。
 *
 * 为什么非做不可（真机实测）：一条内容发完之后，得物停在哪儿是**不确定的**
 *   （个人主页 / 相册页 / 发布成功页），而下一条的第一步是「底部点『我』」那个**固定坐标**
 *   —— 只有 App 在首页时它底下才是底部导航。停在别处时那个坐标点下去就是乱点（实测点空、
 *   甚至点到别的入口）⇒ 用户看到的「第二条永远拉不起来」。
 *
 * 行为：
 *   ① 先轮询前台，若**已经在 want 那一屏** ⇒ 直接返回 {ok:true, started:false}（**一次都不拉**，
 *      不白花十几秒冷启动 —— 这是实测里最大的提速点）；
 *   ② 读不到前台（`mCurrentFocus` 空）时，改用 `dumpsys activity top` 兜底判断；
 *   ③ 需要拉时用 `am start -n <pkg>/<activity>`（**Activity 名前导点必须原样保留**，
 *      去掉点真机报 `Error type 3 / Activity class does not exist`）；
 *   ④ 拉完**再轮询确认真的到了** want 那一屏，等不到就**如实失败**（绝不硬点）；
 *   ⑤ 报 `Error type N / does not exist` 时**点名**是哪个 Activity 不存在，绝不退回 monkey
 *      （monkey 是"随便开个入口"，会掩盖配置错误）；只有压根没给 activity 才退回 monkey。
 *
 * @returns {{ok:boolean, focus:string, started:boolean, why:string}}
 */
async function ensureApp(serial, { pkg, activity, want, judge, timeoutMs = 30000 } = {}) {
  const t0 = Date.now();
  const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : 30000;
  const isWant = (focus) => {
    if (!want) return !!focus;
    if (typeof judge === 'function') { try { return !!judge(focus); } catch (e) { return false; } }
    return isFocusOf(focus, want);
  };
  const readFocus = async () => {
    let f = await currentFocus(serial);
    if (!f && want) {
      const top = await topActivityMatching(serial, want);
      const m = /ACTIVITY\s+([^\s]+)/.exec(top);
      if (m) f = m[1];
    }
    return f;
  };

  // ① 已经在目标屏 ⇒ 不拉
  //   ★★ 转场瞬间的容错（真机实测）：`mCurrentFocus=null` 会**偶发一瞬间**（窗口焦点交接中）。
  //   这不是「App 不在前台」⇒ 若这一刻直接 `am start` 就是**瞎启动**（打断正在进行的转场）。
  //   ⇒ 判据：
  //     · 起手**一次就读得干净**、且不是目标屏 ⇒ 明确知道它停在别处 ⇒ 该拉（走 ③）；
  //     · 起手**读不到**（空）⇒ 说明正处在转场/未知态 ⇒ **不在这一瞬瞎启动**：
  //         继续轮询等待它就位 —— 等到是目标屏就放行；等到读得出来却是别屏 ⇒ 也不瞎拉，
  //         直接往下走（后续每一步自己的屏幕守卫仍会拦住乱点）；一直读不到 ⇒ 超时如实失败。
  let focus = await readFocus();
  const firstReadEmpty = !focus;
  if (!focus) {
    for (let i = 0; i < 4 && !focus; i++) {
      await sleepMs(300);
      focus = await readFocus();
    }
    if (!focus) {
      // 起手一直读不到 ⇒ 等到超时就如实失败（读不到 ≠ 知道自己在哪一屏）
      for (;;) {
        focus = await readFocus();
        if (isWant(focus)) return { ok: true, focus, started: false, from: '', why: '' };
        if (Date.now() - t0 >= timeout) {
          const waited = ((Date.now() - t0) / 1000).toFixed(1);
          return { ok: false, focus: '', started: false, from: '',
            why: `等了 ${waited}s，连「当前前台是哪个窗口」都读不到 —— 读不到就不许猜着点，先确认设备是不是掉线了` };
        }
        await sleepMs(300);
      }
    }
  }
  if (isWant(focus)) return { ok: true, focus, started: false, from: '', why: '' };
  // ★ 起手那次是「读不到」⇒ 这一趟**不启动 App**（不知道自己在哪一屏时，am start 是瞎启动）。
  //   直接放行：后续每一步自己的 `whenOn/whenNotOn` 屏幕守卫仍会在真错屏上拦住乱点。
  if (firstReadEmpty) return { ok: true, focus, started: false, from: '', why: '' };
  const before = focus;

  // ③ 需要拉：先试 am start（带前导点）；报 does not exist 就点名报错
  let started = false;
  let lastErr = '';
  if (activity) {
    const r = await shell(serial, 'am start -n ' + pkg + '/' + activity);
    const blob = String(r.stdout || '') + String(r.stderr || '');
    if (/Error type \d+|does not exist|Activity class \{/.test(blob)) {
      return { ok: false, focus: before, started: false, from: before,
        why: '启动命令失败了：' + blob.trim().split(/\r?\n/).slice(0, 2).join(' / ')
          + `（要启动的是「${pkg}/${activity}」—— Activity 名对不对？前导点不能丢）` };
    }
    if (!r.ok && !/Warning/i.test(blob)) lastErr = blob.trim();
    started = true;
  } else {
    const r = await shell(serial, 'monkey -p ' + pkg + ' -c android.intent.category.LAUNCHER 1');
    if (!r.ok) lastErr = String(r.stderr || '').trim();
    started = true;
  }

  // ④ 轮询确认真的到了
  for (;;) {
    focus = await readFocus();
    if (isWant(focus)) return { ok: true, focus, started, from: before, why: '' };
    if (Date.now() - t0 >= timeout) {
      const waited = ((Date.now() - t0) / 1000).toFixed(1);
      return { ok: false, focus, started, from: before,
        why: focus
          ? `等了 ${waited}s，得物还是停在「${focus}」，不是要等的「${want || '(任一前台)'}」`
          : `等了 ${waited}s，连「当前前台是哪个窗口」都读不到 —— 读不到就不许猜着点，先确认设备是不是掉线了`
            + (lastErr ? `（最近一次报错：${lastErr}）` : '') };
    }
    await sleepMs(300);
  }
}

/**
 * 设备检查：把「能不能真的发」拆成可验证的几条。
 *
 * ★ 返回体里同时带两套说法，别混用：
 *   · `notes` —— 给**排查问题的人**看的技术原文（命令输出、原始报错）
 *   · `fix`   —— 给**普通用户**看的：{ level:'bad'|'warn', title, how }
 *     title = 「现在卡在哪」，how = 「下一步点哪里」。界面上只显示这一套，
 *     notes 收进折叠区。以前界面上直接摆 7 行术语，用户看到「不满足」也不知道该干什么。
 */
async function probe(serial) {
  const act = active();
  const apkPath = bundledApk;
  const out = {
    serial, ts: Date.now(),
    adbPath: act.path, adbSource: act.source, adbConfigured: adbBin,
    adbBundled: bundledAdbPath() || null, adbConfiguredMissing: act.configuredMissing,
    imeApkBundled: apkPath || null, imeApkExists: !!(apkPath && fs.existsSync(apkPath)),
    adb: null, device: null, resolution: null,
    appPackage: null, adbKeyboard: false, adbKeyboardIme: '', adbKeyboardActive: false,
    adbKeyboardCurrent: '', focus: null,
    tools: {}, notes: [], fix: []
  };
  const say = (level, title, how, act2) => out.fix.push(act2 ? { level, title, how, act: act2 } : { level, title, how });

  // 只有「真的退了回去」才说"已自动改用X"。三种来源全不可用时不报这条 ——
  // 那种情况下面那条「没找到 adb」才是正主，这里再说一遍等于让用户以为有备胎。
  if (act.configuredMissing && act.source !== 'configured-missing') {
    const toWhat = act.source === 'bundled' ? '程序内置的 adb' : '系统 PATH 里的 adb';
    out.notes.push(`手填的 adb 路径「${adbBin}」不存在，已自动退回${act.source === 'bundled' ? '内置' : 'PATH'}：${act.path}`);
    say('warn', `你填的 adb 路径不存在，已自动改用${toWhat}`,
      `在「设置 → 高级设置」的「adb 路径」里填的是「${adbBin}」，这个文件找不到。`
      + `现在用的是${toWhat}（不影响使用）。`
      + '建议把那一格清空（留空=自动：优先内置、再退系统），或者把路径改对。');
  }

  out.adb = await version();
  if (!out.adb) {
    // 现在正常情况下这里是**不会**出现的：包里有内置 adb。真报出来，只可能是安装包不完整、
    // 或者用户手填了一个不存在的路径又没清掉。
    out.notes.push(`没检测到 adb（解析结果：path=${act.path} source=${act.source}`
      + (act.configuredMissing ? ` · 手填的「${adbBin}」不存在` : '') + '）');
    const hint = '★ 也可以临时在「设置 → 高级设置」的「adb 路径」里，指定模拟器自带的那个'
      + '（MuMu 默认在 D:\\MUMU\\MuMuPlayer\\nx_main\\adb.exe），填完立刻生效，再点一次上面的「检查能不能发布」。';
    say('bad', '没找到 adb —— 它是电脑跟模拟器之间的“对讲机”',
      (act.configuredMissing ? `你在「高级设置 → adb 路径」里填的「${adbBin}」不存在 —— 先把它清空（留空=自动）。` : '')
      + (bundledAdbPath()
        ? `程序内置的那份也没找到（应该在 ${bundledAdbPath()}）—— 多半是安装包不完整，重新装一次本工具最省事。`
        : '这台机器上没有内置的 adb。')
      + hint);
    return out;
  }

  out.device = await online(serial);
  if (!out.device) {
    const list = await devices();
    // 这一条是「整张表都报错」最常见的原因：serial 填错。
    // MuMu 的「网络桥接地址」（127.0.0.1:16385 这类）和 adb 侧真正认到的 serial
    // （emulator-5554）经常不是同一个 —— 填错就每一项都失败，看起来像设备坏了，其实只是名字不对。
    const usable = list.filter(d => d.state === 'device');
    // ★★ 没选设备时**不许点名任何设备**：用户看到界面里冒出个设备名，分不清那是真名还是写死的。
    //    只有「已经选了、但它掉线了」才值得把真名说出来 —— 那种情况他需要知道掉的是哪一台。
    out.notes.push(list.length
      ? (serial
        ? `设备 ${serial} 不在线。adb 现在认到的是：${list.map(d => `${d.serial}(${d.state})`).join('、')}`
          + (usable.length ? ` —— 上面「设备」那一栏请选「${usable[0].serial}」。模拟器重启后端口/名字可能变，别照抄上一次的。` : '')
        : `还没选设备。adb 现在认到 ${list.length} 台设备（其中在线可用 ${usable.length} 台）`
          + ' —— 点「扫描设备」从列表里选一台「加入并使用」即可，不用手抄名字。')
      : 'adb 在线但一个设备都没有：先把模拟器启动起来，并在模拟器设置里打开 ADB 调试');
    say('bad', serial ? `你选的设备「${serial}」没连上` : '还没选设备（但检测到你有模拟器在线）',
      usable.length
        // ★★ 这段正文里**一个设备名都不许出现** —— 连动态拼进去的也不许。
        //    用户看到界面上冒出一串英文数字，根本分不清那是「模拟器真名」还是「程序写死的」。
        //    他真正要做的只有一件事：点「扫描设备」→ 点那一行的「加入并使用」。
        ? '检测到有模拟器在线，但它还没被加进本程序的设备列表。'
          + '点「设备管理」里的「扫描设备」，列表里会出现它，点那一行的「加入并使用」就选上了 —— '
          + '不用抄设备名，也不用知道它叫什么。'
          + '★ 模拟器每次重启，设备名可能变 —— 所以永远用「扫描设备」现扫，别照抄上一次的。'
        : '三步：① 先把模拟器启动起来；② 确认模拟器设置里打开了「ADB 调试」；'
          + '③ 回来点「扫描设备」，从列出来的设备里点「加入并使用」。');
    return out;
  }

  const sz = await shell(serial, 'wm size');
  if (sz.ok) out.resolution = (sz.stdout.match(/(\d+x\d+)/) || [])[1] || null;
  out.tools.input = (await shell(serial, 'input')).ok;
  out.tools.screencap = (await screencap(serial)).length > 0;
  // ★★ 包名要先拿到：备用通道（dumpsys）得靠它才能从整份层级里挑出得物那一段。
  const pkgs = await packages(serial);
  out.appPackage = pkgs.find(p => /shizhuang|duapp|poizon|dewu/i.test(p)) || null;

  out.tools.uiautomator = !!(await dump(serial));
  if (out.tools.uiautomator) {
    const d = lastDumpInfo();
    if (d && d.animOff) out.notes.push('自检时页面一直不 idle，已临时关掉系统动画才抓到结构（已还原）');
  } else {
    // ★★ 「uiautomator 这一下没抓到」≠「正式通道不能用」：得物发布页是**动画页**，
    //    而程序本来就内置了 dumpsys 备用通道（runStep 用的 dumpEx 会自动退过去）。
    //    这里把备用通道**单独验一次**、如实记下来 —— 否则「模拟器正停在发布页」这个**正常状态**
    //    会被判成「不能发布」，`connect()` 就会把发布通道**改写成模拟通道**，
    //    用户点「开始发布」一路「模拟成功」、设备上什么都没发生（2026-10-03 实测踩到）。
    const v = await dumpViaDumpsys(serial, out.appPackage || 'com.shizhuang.duapp');
    out.tools.dumpsys = !!(v && v.ok);
    if (out.tools.dumpsys) {
      out.notes.push('当前这一屏 uiautomator 抓不到（发布页是动画页），但**备用通道（dumpsys）可用**'
        + ' ⇒ 发布不受影响，程序会按屏自动选通道（走备用通道那一屏**拿不到文字**，按文字找的步骤在那屏用不了）');
    }
  }
  out.adbKeyboard = pkgs.some(p => p.includes('com.android.adbkeyboard'));
  if (out.adbKeyboard) {
    // 装了 ≠ 能用：必须「已启用」且「是当前输入法」，否则 ADB_INPUT_TEXT 广播打不进字
    out.adbKeyboardIme = await adbKeyboardIme(serial);
    const kbd = await keyboardReady(serial);
    out.adbKeyboardActive = kbd.active;
    out.adbKeyboardCurrent = kbd.current;
  }

  // ★ 只有**两条通道都不行**才算「抓不到界面」；备用通道能用时它只加了一条 note（上面那条）。
  if (!out.tools.uiautomator && !out.tools.dumpsys) {
    const d = lastDumpInfo() || {};
    const on = await currentFocus(serial);
    out.focus = on;
    out.notes.push((d.idle
      ? `uiautomator dump 失败：当前页面一直不 idle（得物发布页会这样），拿不到界面结构 —— 原始输出「${d.why || ''}」`
      : `uiautomator dump 失败：拿不到界面结构，无法定位发布按钮${d.why ? ` —— 原始输出「${d.why}」` : ''}`)
      + (on ? ` · 当时停在这一屏：${on}` : ''));
    // ★ 这一条**只是"此刻这一屏抓不动"，不代表 adb / uiautomator 坏了**（实测：同一台设备
    //   切到桌面就能抓到，几秒后回到同一页也能抓到）。所以文案里必须把这两件事分开说，
    //   否则用户会以为要重装 / 换工具。
    say('bad', '现在这一屏抓不到界面（发布时会找不到按钮）',
      (on ? `刚才是停在「${on.split('/').pop()}」这一屏上。` : '')
      + '① 把得物退到首页、或切到桌面再点一次「检查能不能发布」（实测这一步就能恢复）；'
      + '② 还不行就把模拟器里其他占着画面的应用关掉、确认没锁屏。'
      + '得物自己的发布页本来就偶发抓不动，这是已知情况，不是 adb 坏了。');
  } else {
    out.focus = await currentFocus(serial);
  }
  if (!out.tools.screencap) {
    out.notes.push('screencap 失败：失败时截不了图');
    say('warn', '能发，但发布失败时截不了图（以后排查会麻烦些）',
      '一般是模拟器权限问题：重启模拟器，再点一次「检查能不能发布」。');
  }
  if (!out.adbKeyboard || !out.adbKeyboardActive) {
    const canInstall = out.imeApkExists;
    out.notes.push(!out.adbKeyboard
      ? '未装 ADBKeyboard：中文标题/正文输入会失败（ASCII 不受影响）'
      : `ADBKeyboard 已装但没设成当前输入法（ime list 里是「${out.adbKeyboardIme || '没找到'}」，`
        + `当前输入法是「${out.adbKeyboardCurrent || '未知'}」）—— 广播没有接收者，中文一个字也进不去`);
    // ★ 为什么是 bad 而不是 warn：得物的标题/正文/话题几乎全是中文，而**中文只有 ADBKeyboard
    //   这一条通道**（实测 `input text` 对中文无效，却照样返回 0）。没有它，发布会直接在这几步
    //   失败（改之前更糟：会静默发出一条没标题没正文的帖子）。所以这不是"影响体验"，是"发不出去"。
    say('bad',
      out.adbKeyboard ? '中文发不出去（输入法装了，但不是当前输入法）' : '中文标题和正文发不出去（没装中文输入法）',
      (!out.adbKeyboard ? '得物的标题、正文、话题都是中文，中文只有 ADBKeyboard 这一条输入通道，'
        + '`input text` 是打不进的（实测）。只发英文和数字不受影响。' : '')
      + (canInstall
        ? '点下面的按钮一键搞定（装进模拟器 + 启用 + 设成当前输入法），完事再点一次「检查能不能发布」。'
          + '★ 注意：「程序内置了输入法」= 安装包自带这个 apk，不等于已经装进模拟器并启用 —— 这一步必须做一次。'
        : '这台机器的安装包里没有内置输入法，需要自己装一个 ADBKeyboard（包名 com.android.adbkeyboard）。'),
      canInstall ? { act: 'pub:installIme', label: '一键装上中文输入法' } : null);
  }
  if (!out.appPackage) {
    out.notes.push('设备里没找到得物 App 包名，请确认已安装登录');
    say('bad', '模拟器里没找到「得物」',
      '确认这台模拟器装的是得物并且已经登录，再点一次「检查能不能发布」。');
  }
  return out;
}

module.exports = {
  execAdb, version, devices, online, shell, push, mediaScan, mediaVisible, clearMediaDir, filesMissing, screencap,
  dump, dumpEx, lastDumpInfo, dumpViaDumpsys, vhToXml, tap, tapSeq, keyevent, inputText, packages, probe,
  setAdbPath, getAdbPath, setBundledAdbDir, getBundledAdbDir, bundledAdbPath,
  setBundledApkPath, getBundledApkPath, resolveAdbChoice, getActiveAdb, bundledStatus,
  installKeyboard, adbKeyboardIme, defaultIme, keyboardReady, currentFocus,
  ensureApp, isFocusOf, frontActivity, topActivityMatching
};
