'use strict';
/**
 * ADB 驱动层：只做「确实能做到」的真实动作，做不到就明确报错，绝不假装成功。
 *   - 设备在线 / 分辨率 / 包是否安装 / 工具可用性：真实探测
 *   - 推图 + 触发媒体扫描：真实命令
 *   - 界面结构抓取（uiautomator dump）+ 点击 / 输入：真实命令
 *   - 中文输入依赖 ADBKeyboard（com.android.adbkeyboard）—— apk 随包内置，
 *     设备检查与发布前会自动补齐安装、启用和当前输入法配置
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

async function devices({ strict = false } = {}) {
  const r = await execAdb(['devices']);
  if (!r.ok && strict) throw new Error('内置设备连接服务执行失败：' + (r.stderr || r.code || '无法启动 ADB'));
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

/** 设备端 sh 的单引号包裹（路径都是我们自己拼的，不会含单引号） */
function shq(p) { return `'${String(p)}'`; }

/**
 * ★★★ 2026-10-05 新增：**把指定那张设成「这一组里时间最新的」**。
 *
 * 为什么必须有它（得物相册第 1 格 = 内容主图，而第 1 格只认文件时间的倒序）：
 *   真机三步实验（127.0.0.1:16384 / MuMu 12，全部可复算，见交付文档 `主图顺序-方案-20261005.md`）：
 *     ① 4 张纯色图，把「文件名顺序 / adb push 顺序 / 文件时间」三个键**故意做成互相矛盾** ⇒
 *        相册第一屏顺序**只与文件时间倒序吻合**（文件名、推送顺序都被否掉）；
 *     ② 只改文件时间、**不重扫媒体库** ⇒ 相册顺序**纹丝不动**（得物读的是库里的缓存值）；
 *     ③ 改完文件时间再 `scan_file` ⇒ 顺序立刻跟着变（闭环）。
 *   ⇒ 想指定主图，唯一可行操作 = **推完之后、入库之前**在设备端 `touch` 那张，再重扫它。
 *     调用方（publisher）先 makeNewest 再 mediaScan，**两步缺一不可**。
 *
 * ★ 为什么**不在本地**改文件时间（所以这一步必须落在设备端）：
 *   素材整理出来的扁平副本是**硬链接**（真机素材实测链接数 = 4）⇒ 本地 utimes 会把用户的**原图**
 *   一起改掉。设备端 touch 只动设备上那一份。
 * ★ 为什么不做在 push 上（"最后推它就行"）：相册不看推送顺序（实验①已否掉）。
 * ★ 为什么不用 `now`：只要比这一组里其他文件都新就够了。用「组内最大时间 + 2 秒」既不依赖主机与
 *   设备时钟一致，也天然满足「秒级、至少隔 1 秒」这条（实测 date_modified 是秒级，同一秒不分先后）。
 *
 * @param {string} serial
 * @param {string} target 要置顶的那个远端文件
 * @param {string[]} others 同一组里的其它文件（算「最大时间」用）
 * @returns {{ok:boolean, at?:number, maxOther?:number, error?:string}}
 */
async function makeNewest(serial, target, others) {
  const t = toMediaPath(target);
  if (!t) return { ok: false, error: '没给要置顶的文件路径' };
  const all = [];
  for (const p of [t].concat(Array.isArray(others) ? others : [others])) {
    const m = toMediaPath(p);
    if (m && all.indexOf(m) < 0) all.push(m);
  }
  const st = await shell(serial, 'stat -c %Y ' + all.map(shq).join(' '), { timeout: 30000 });
  if (!st.ok) {
    return { ok: false, error: `读文件时间失败：${((st.stderr || '') + (st.stdout || '')).trim() || 'stat 返回非 0'}` };
  }
  const nums = String(st.stdout || '').trim().split(/\s+/).filter(s => /^\d+$/.test(s)).map(Number);
  if (nums.length !== all.length) {
    // ★ 读不到就**不许往下走**：少读一个 ⇒ 算出来的"最新"可能是错的 ⇒ 主图会排错
    return { ok: false, error: `读文件时间没读全（要读 ${all.length} 个，只回了 ${nums.length} 个）` };
  }
  const max = Math.max.apply(null, nums);
  const at = max + 2;
  const tr = await shell(serial, `touch -d @${at} ${shq(t)}`, { timeout: 30000 });
  if (!tr.ok) {
    return { ok: false, error: `设置文件时间失败：${((tr.stderr || '') + (tr.stdout || '')).trim() || 'touch 返回非 0'}` };
  }
  // 设完当场回读文件系统：读到别的值就当失败（touch 在权限不足时也可能"安静地没生效"）
  const back = await shell(serial, `stat -c %Y ${shq(t)}`, { timeout: 30000 });
  const got = Number(String(back.stdout || '').trim());
  if (!back.ok || got !== at) {
    return { ok: false, error: `设置后回读不是刚设的值（回读「${String(back.stdout || '').trim() || '(空)'}」，应为 ${at}）` };
  }
  return { ok: true, at, maxOther: max };
}

/**
 * ★★★ 2026-10-05 新增：回读 MediaStore 里这几个文件的 `date_modified`，判**哪个是最新的**。
 *
 * 为什么不拿 makeNewest 的回读当结论：那一步读的是**文件系统**的时间，而得物相册读的是
 * **媒体库里缓存的值**（实验②：只改文件时间不重扫库，界面顺序不动）。所以"排成没排成"必须以
 * 库里的值为准 —— 这也正好是**独立于 touch 那条代码路径**的一次复查。
 *
 * 读不到（命令失败 / 有文件在库里查不到）一律 `ok:false` + 原因，**不假装知道顺序**。
 *
 * @returns {{ok:boolean, newest?:string, times?:object, want?:string[], error?:string}}
 */
async function mediaNewest(serial, remoteFiles) {
  const want = [];
  for (const p of (Array.isArray(remoteFiles) ? remoteFiles : [remoteFiles])) {
    const m = toMediaPath(p);
    if (m && want.indexOf(m) < 0) want.push(m);
  }
  if (!want.length) return { ok: false, error: '没给要比的文件' };
  const r = await shell(serial, 'content query --uri content://media/external/images/media --projection _data:date_modified', { timeout: 30000 });
  if (!r.ok) {
    return { ok: false, error: `回读媒体库失败：${((r.stderr || '') + (r.stdout || '')).trim() || 'content query 返回非 0'}` };
  }
  const times = {};
  for (const line of String(r.stdout || '').split('\n')) {
    const m = line.match(/_data=(.+?),\s*date_modified=(\d+)/);
    if (m) times[m[1].trim()] = Number(m[2]);
  }
  const missing = want.filter(p => !(p in times));
  if (missing.length) {
    return { ok: false, error: `媒体库里回读不到这几个文件的入库时间：${missing.map(p => p.split('/').pop()).join('、')}` };
  }
  let best = want[0];
  for (const p of want) if (times[p] > times[best]) best = p;
  return { ok: true, newest: best, times, want };
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
 * ★★ 2026-10-04 新增：**把 App 强行停掉**（`am force-stop <pkg>`）。
 *
 * 为什么必须有这一条（本轮真机实测，推翻了以前「stale 句柄跟 adb 服务有关」的归因）：
 *   得物停在**发布页 / 相册页**时，它自己**正拿着 `DCIM/Camera/bluev` 里那些 mp4 的硬解码句柄**。
 *   此时在同一台设备上：
 *     · `rm -f <file>`          → `Text file busy`（rc=1）
 *     · `rm -rf <dir>`          → `Text file busy`（rc=1）
 *     · `find <dir> -mindepth 1 -delete` → **rc=0 却根本没删**（★ 静默假成功，最坑的一种）
 *     · `mv <dir> <trash>`      → `Operation not permitted`（rc=1）
 *     · **`am force-stop com.shizhuang.duapp` 之后再执行同一句** ⇒ rc=0、**立刻删掉**
 *   ⇒ 锁**在 App 进程里**，不在 adb 服务里。这也解释了老代码里「kill-server 解不开」的现象。
 *
 * ★ 一点必须说清的边界：force-stop **不是万能**。设备上另有一类**真的 stale 句柄**
 *   （MuMu 的 sdcardfs 映射留下的、跟某个已经消失的 inode 走）—— 那种 force-stop 也解不开，
 *   只能靠 mv 换名绕开或重启模拟器。两类现象长得很像，所以调用方**两条路都要留着**。
 */
async function forceStop(serial, pkg) {
  const p = String(pkg || '').trim();
  if (!p) return { ok: false, error: '没给包名' };
  // 包名只允许字母数字点下划线（不往设备端塞任何引号/特殊字符）
  if (!/^[A-Za-z0-9_.]+$/.test(p)) return { ok: false, error: '包名不合法：' + p };
  const r = await shell(serial, 'am force-stop ' + p, { timeout: 20000 });
  return { ok: !!r.ok, out: String(r.stdout || '').trim(), error: r.ok ? '' : (String(r.stderr || '').trim() || 'force-stop 执行失败') };
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
 * @param {object} [opts]
 *   · `forceStopPkg` —— 清不掉时**允许**把哪个 App 强停掉再重试（真机实测它持有解码句柄）。
 *                       不传就完全不碰 App（默认行为与以前一字不差）。
 * 返回 { ok, removed, files, error, note, forceStopped }
 */
async function clearMediaDir(serial, remoteDir, opts = {}) {
  const forceStopPkg = String((opts && opts.forceStopPkg) || '').trim();
  // ★ 「这次是不是把 App 强停过」—— 调用方要据此决定「得物现在是不是死的、要不要重新拉起来」。
  let forceStopped = false;
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
  if (error) return { ok: false, removed: 0, files: hit.map(h => h.file), error, forceStopped };

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
  //   ★★★ 2026-10-04 第十四次实测修正（上面第五次那段**归因错了，别照它推理**）：
  //     第五次结论说「force-stop 掉得物之后照样 Text file busy ⇒ 是 MuMu 的 stale 句柄」。
  //     本轮重做同一个实验，结果**相反**：force-stop 之后**同一句 rm 立刻成功**、目录立刻空。
  //     两次都在真机上做的，差别在于**当时锁在谁手里**：
  //       · 得物**正在跑**、停在发布页/相册页 ⇒ 锁在**得物进程**里 ⇒ force-stop 能解；
  //       · 得物**早就退出/被杀**、锁却还在   ⇒ 才是 MuMu sdcardfs 的 stale 句柄 ⇒ force-stop 解不开。
  //     两类现象长得一模一样（都是 `Text file busy`），但解法不同
  //     ⇒ 所以现在**两手都留着**：先 force-stop 重试（见上面 1b 段，能过就不造残骸），
  //       过不了再 mv 换名（对付真 stale）。

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
  // ★★★ 2026-10-05（第四十二轮）★ 先数「还有没有文件」——没有就**立刻收工**，别为空气做功。
  //   用户原话：「检查有没有图片就行，空目录有什么关系？」
  //
  //   为什么必须提前（真机实测，可复算）：得物相册 = MediaStore，**只认文件**；
  //   空目录（哪怕里面套着 sub/deep）一条都进不去 ⇒「目录 listing 非空」根本不代表「相册还有素材」。
  //   而这块设备上躺着 8 个**删不掉**的超长残骸空目录（`rm -rf` 撞 `Text file busy`；
  //   `adb kill-server` 解不开，**重启模拟器也解不开** —— 实测 Android uptime 75s 后照样在）。
  //   ⇒ 按老流程，这 8 个残骸会让**每一条内容**都必然走完下面这一整套：
  //     强停得物 → 重删 → mv 换名（Camera 是 sdcardfs 挂载点，必失败）→ 逐子项循环
  //     （每个子项 4~6 次 shell）→ 4 轮扫描 → 兜底 2 轮（含 1.6s 纯 sleep）→ reapLongTrashDirs
  //   实测这一段 **15.3s**，而它想删的东西（文件）**一个都不存在**。
  //   ★ 更糟的连带损失：白白把得物**强停**掉 ⇒ 发布流程后面还要再花 4.4s 把它重新拉回首页。
  //
  //   ⇒ 判据：只要 `find <dir> -type f` 数出来是 **0 个文件**，就地判干净
  //     —— **不强停得物、不换名、不 reap**，直接返回。
  //   ★★ 红线不变（不许为了快而造假）：**读不到 ≠ 空**。`find` 自身失败时**不放行**，
  //     照样往下走原流程（原流程会去 `ls`、会如实报错）。有文件时行为与以前一字不差。
  if (hasLeftover(stage)) {
    const fchk0 = await shell(serial, 'find ' + dir + ' -type f 2>/dev/null', { timeout: 30000 });
    const filesNow0 = String(fchk0.stdout || '').trim();
    if (fchk0.ok && !filesNow0) {
      const n0 = String(stage.stdout || '').trim().split(/\r?\n/).length;
      return {
        ok: true, removed: removed, files: hit.map(h => h.file), error: '', forceStopped: false,
        note: dirNote || ('只剩 ' + n0 + ' 个删不掉的空目录残骸（find -type f 数出来 '
          + '0 个文件，不含任何素材）—— 得物相册只认文件 ⇒ 不强停得物、不换名、直接放行')
      };
    }
  }
  if (hasLeftover(stage)) {
    // ★★★ 1b) 2026-10-04 第十四次实测修正（★ 本轮用户报的「第 2/3 篇直接提示没能清干净」的真解）：
    //   先别急着 mv 换名 —— **先看清是什么在锁**。
    //   真机上这两条命令的差别是决定性的（同一秒、同一台设备）：
    //     `rm -rf /sdcard/DCIM/Camera/bluev`            → rc=1  `Text file busy`
    //     `am force-stop com.shizhuang.duapp` 之后再执行 → **rc=0，目录立刻空**
    //   根因：**得物自己正停在发布页/相册页、拿着这批 mp4 的硬解码句柄**（这跟「MuMu 的 stale
    //   句柄」是两回事 —— 那种 force-stop 也解不开，所以才要把 mv 换名法留在后面当第二手）。
    //   ★ 顺序很重要：**先强停、再重试原地删**，成功了就**不进换名那条路**——
    //     换名会造出 `X_trash_<ts>` 残骸，残骸会一直堆在相册目录里（老代码吃过这个亏）。
    //   ★ 只在调用方明确给了包名（`forceStopPkg`）时才做 —— 默认一个 App 都不碰。
    if (forceStopPkg && !forceStopped) {
      const st = await forceStop(serial, forceStopPkg);
      if (st.ok) {
        forceStopped = true;
        await sleepMs(500);   // 等系统把句柄收回去（实测 force-stop 后立刻 rm 也能过，留点余量）
        await shell(serial, 'find ' + dir + ' -mindepth 1 -delete 2>/dev/null', { timeout: 60000 });
        await shell(serial, 'rm -rf ' + dir + '/* ' + dir + '/.[!.]* 2>/dev/null', { timeout: 60000 });
        stage = await shell(serial, 'ls -A ' + dir, { timeout: 30000 });
        left = String(stage.stdout || '').trim();
      } else if (!dirNote) {
        dirNote = '想强停 ' + forceStopPkg + ' 腾出文件句柄，但没停掉（' + (st.error || '未知原因') + '）';
      }
    }
    // ★ 到这里还没清掉 ⇒ 才走 mv 换名法（对付 force-stop 也解不开的那种 stale 句柄）
  }
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
  if (error) return { ok: false, removed: removed, files: hit.map(h => h.file), error, forceStopped };
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
      return { ok: false, removed: removed, files: hit.map(h => h.file), forceStopped,
        error: '目录里还有 ' + filesLeft.split(/\r?\n/).length + ' 个文件没删掉（前几个：'
          + filesLeft.split(/\r?\n/).slice(0, 3).join(' , ') + '）' };
    } else {
      // 只剩空目录残骸（stale 句柄锁着、改名也删不掉）⇒ 不影响相册，如实记一笔放行。
      // ★★ 2026-10-04：顺手**尽力清一次「超长垃圾目录」**（老版本换名法滚出来的那批，
      //   名字一路加后缀到 255 字符）。清得掉最好；清不掉就把它「有多严重」如实并进 note
      //   （而不是留一句含糊的"空目录残骸"让人猜）。
      const n = left.split(/\r?\n/).length;
      let note = dirNote || ('只剩 ' + n + ' 个空目录残骸（stale 句柄锁着，删不掉但不含任何素材）');
      try {
        const rp = await reapLongTrashDirs(serial, remoteDir);
        if (rp.tried) {
          note = rp.ok
            ? `已顺手清掉 ${rp.before} 个历史遗留的超长垃圾目录；` + note
            : `另有 ${rp.after} 个历史遗留的超长垃圾目录清不掉（${rp.why}）；` + note;
        }
      } catch (e) { /* 尽力而为：清残骸失败绝不能影响发布 */ }
      return { ok: true, removed: removed, files: hit.map(h => h.file), error: '', note, forceStopped };
    }
  }
  return { ok: true, removed: removed, files: hit.map(h => h.file), error: '', note: dirNote, forceStopped };
}

/**
 * ★★★ 2026-10-04（真机实测新增）：把设备**整个相册**清到一条不剩 —— 判据是「MediaStore 里
 *   除了本条要推的，没有别的素材」。这是用户口径「发布某条素材时，调出相册只能看到他的图/视频」
 *   的**唯一靠得住的落点**。
 *
 * 为什么 clearMediaDir 不够（真机对照实验，可复算）：
 *   得物相册顶部那个「所有照片」是个**全盘聚合视图**。把一条 mp4 放进 `/sdcard/Movies`
 *   （**不在** DCIM/Camera 下），它照样出现在得物相册里，和专属目录里的并排显示、次序按时间排。
 *   ⇒ 只清 DCIM/Camera 时，设备上任何**别处**的素材都会混进这一屏，选素材那一步就会点到它。
 *
 * 与 clearMediaDir 的分工（两条都要留着，判据不同）：
 *   · clearMediaDir —— 按**目录**清：把 DCIM/Camera（含 bluev）清干净，能顺带把物理文件删掉；
 *   · clearAlbum     —— 按**媒体库**清：不管素材落在哪个目录，只要相册里看得见的就清掉。
 *
 * 实现：扫 4 张表拿到所有 _id/_data ⇒ 先 `rm -f` 物理文件（不删文件的话，下一次 scan_volume
 *   会把残留**重新扫进库**、又冒出来）⇒ 再按 _id `content delete`（按 id 删不需要引号）⇒
 *   `scan_volume` ⇒ **复查**；还有残留就 `am force-stop` 一次再重来。
 *
 * ★ 不假装清干净：`ok` 只在**复查时四张表都为空**时给出，否则把「还剩几条、前几个是谁」如实带回。
 *   清不干净是**静默错误** —— 表现是「内容看着发成功了，配图却是别人的」，最难查。
 *
 * @param {object} [opts]
 *   · `forceStopPkg` —— 清不掉时**允许**把哪个 App 强停掉再重试（真机实测它持有解码句柄）。
 *                       不传就完全不碰 App。
 * 返回 { ok, removed, files, left, error, note, forceStopped }
 */
async function clearAlbum(serial, opts = {}) {
  const forceStopPkg = String((opts && opts.forceStopPkg) || '').trim();
  // 表名与 clearMediaDir 保持一致（file 表在部分机型不可查，单独容忍）
  const TABLES = ['video', 'images', 'audio', 'files'];
  let forceStopped = false;

  const scanAll = async () => {
    const hit = []; let error = '';
    for (const t of TABLES) {
      const r = await shell(serial,
        'content query --uri content://media/external/' + t + '/media --projection _id:_data', { timeout: 30000 });
      if (!r.ok) {
        const e = String(r.stderr || '').trim() || ('content query(' + t + ') 执行失败');
        if (t === 'files' && /no such table|Invalid|Unknown|not found/i.test(e)) continue;
        if (!error) error = e;
        continue;
      }
      for (const line of String(r.stdout || '').split(/\r?\n/)) {
        const m = /_id=(\d+),\s*_data=(.*?)\s*$/.exec(line);
        if (m) hit.push({ table: t, id: m[1], file: m[2] });
      }
    }
    return { hit, error };
  };

  const removeAll = async (hit) => {
    let removed = 0;
    for (const h of hit) {
      // ① 物理文件先删：记录删了但文件还在时，scan_volume 会把它重新索引回来。
      //    路径不含空格时才拼裸路径（不往设备端塞引号 —— 引号会被 `adb shell` 再解析一次吃掉）。
      if (h.file) {
        if (/\s/.test(h.file)) {
          // 含空格的路径没法安全地走 shell ⇒ 交给下面按 _id 删记录，物理文件留给「按目录清」那条路。
        } else {
          await shell(serial, 'rm -f ' + h.file, { timeout: 20000 });
        }
      }
      // ② 按 _id 删记录（`content delete --uri .../<id>` 完全不需要引号）
      const rd = await shell(serial, 'content delete --uri content://media/external/' + h.table + '/media/' + h.id, { timeout: 30000 });
      if (rd.ok) removed++;
    }
    return { removed };
  };

  const reScan = async () => {
    await shell(serial, 'content call --uri content://media --method scan_volume --arg external_primary', { timeout: 60000 });
    return scanAll();
  };

  let s = await scanAll();
  if (s.error) return { ok: false, removed: 0, files: [], left: s.hit.length, error: s.error, note: '', forceStopped };
  if (!s.hit.length) return { ok: true, removed: 0, files: [], left: 0, error: '', note: '', forceStopped };

  const all = s.hit.slice();
  let r = await removeAll(s.hit);
  let chk = await reScan();

  // 还有残留 ⇒ 多半是句柄锁着（App 正解码）⇒ 强停一次再重来
  if (chk.hit.length && forceStopPkg) {
    const fsr = await forceStop(serial, forceStopPkg);
    if (fsr.ok) {
      forceStopped = true;
      await sleepMs(800);
      const r2 = await removeAll(chk.hit);
      r.removed += r2.removed;
      chk = await reScan();
    }
  }

  const left = chk.hit.length;
  const note = left
    ? ('还有 ' + left + ' 条清不掉（前几个：' + chk.hit.slice(0, 3).map(h => h.file || (h.table + '/' + h.id)).join('、') + '）')
    : '';
  return {
    ok: left === 0,
    removed: r.removed,
    files: all.map(h => h.file).filter(Boolean),
    left,
    error: left ? (forceStopPkg ? '把得物强停之后仍然清不掉：' + note : note) : '',
    note, forceStopped
  };
}

/**
 * ★★ 尽力清掉「历史遗留的超长垃圾目录」（stale 句柄锁死、rm/rmdir 都报 `Text file busy`）。
 *
 * 为什么必须单独有这么一条（真机实测 / MuMu 12）：
 *   老版本清理逻辑「只要 rm 不掉就 mv 换名」，于是每清一次相册就给残骸再加一截 `_gone_<ts>`，
 *   层层叠加**直到撞上 Linux 文件名上限 255 字符**。到那时：
 *     · `mv` 报 `File name too long`（改不了名）；
 *     · `rm -rf` 报 `Text file busy`（stale 句柄锁着 inode，改名也甩不掉）。
 *   ⇒ 就**永久卡死**在那儿，而且每跑一条内容还会新增。实测设备上已经有 9 个（7 个 255 字符）。
 *   ★ 它们**不含任何素材**（`find -type f` 递归为空），所以**不影响发布正确性**
 *     （得物相册只认文件，空目录不进 MediaStore）；但会一直堆在相册目录里，且让人以为出问题了。
 *
 * 唯一可行的解法（实测有效）：**重启 adb 服务**（`adb kill-server` + `start-server`）——
 *   这把设备端 uiautomator / 文件句柄那一摊**全部释放**，stale 锁就没了，之后再 `rm -rf` 能删掉。
 *   ★ 只在**真的发现有超长残骸**时才做（否则每次都重启 adb 服务、白白拖慢每条内容）。
 *   ★ 删不掉就如实返回「还剩几个」—— 绝不假装清干净（那是本项目的红线）。
 *
 * @returns {{ok:boolean, tried:boolean, before:number, after:number, why:string}}
 */
async function reapLongTrashDirs(serial, remoteDir, { minLen = 180, restart = false } = {}) {
  const ls1 = await shell(serial, `ls ${remoteDir} 2>/dev/null`, { timeout: 30000 });
  if (!ls1.ok) return { ok: false, tried: false, before: -1, after: -1, why: '读不到目录 listing' };
  const names = String(ls1.stdout || '').replace(/\r/g, '').split('\n').map(s => s.trim()).filter(Boolean);
  // 只盯「长得离谱」的那些（正常目录名远不到 180 字符），不去碰正常素材目录。
  const longOnes = names.filter(n => n.length >= minLen);
  if (!longOnes.length) return { ok: true, tried: false, before: 0, after: 0, why: '' };

  const delOnce = async () => {
    // ★★ 2026-10-04 真机实测修正：**别只用 `rm -rf`**。
    //   实测 `rm -rf <残骸>` 报的是 `rm: deep: Text file busy` / `rm: sub: …` / `rm: locked: …`
    //   —— 注意报的是**最深处那几个短名**，说明 `rm -rf` 递归到 `sub/deep` 时就撞上了锁
    //   （那批残骸里其实嵌着 `sub` / `deep` / `locked` 这种子目录）。
    //   ⇒ 先 `find -depth -delete`（**自底向上逐项删**，能把「深层被锁、浅层能删」分开处理），
    //     再兜一次 `rm -rf`。
    //   名字可能含特殊字符 ⇒ 用 JSON.stringify 生成**双引号** shell 参数。
    const script = longOnes
      .map(n => {
        const p = remoteDir + '/' + n;
        return `find ${JSON.stringify(p)} -depth -delete 2>/dev/null; rm -rf ${JSON.stringify(p)} 2>/dev/null`;
      })
      .join('; ');
    await shell(serial, script, { timeout: 180000 });
  };
  await delOnce();
  let names2 = (await shell(serial, `ls ${remoteDir} 2>/dev/null`, { timeout: 30000 })).stdout || '';
  let leftNames = String(names2).replace(/\r/g, '').split('\n').map(s => s.trim()).filter(n => n.length >= minLen);
  if (!leftNames.length) return { ok: true, tried: true, before: longOnes.length, after: 0, why: '' };

  // ★ 缺省**不再自动 kill-server**：真机实测（MuMu 12）它**解不开**这把锁
  //   （锁在 MuMu 宿主进程里，不在 adb 服务里），却要白花 ~2s 重启服务 + 1.5s 等待。
  //   ⇒ 只如实回报「还剩几个、以及唯一可行的解法（重启模拟器）」，交给上层决定要不要提示用户。
  if (!restart) {
    return { ok: false, tried: true, before: longOnes.length, after: leftNames.length,
      why: `${leftNames.length} 个超长残骸删不掉（stale 句柄锁在模拟器宿主进程里，`
        + `实测 kill-server 解不开）—— 要彻底清掉得**重启模拟器**；它们不含任何素材、不影响发布` };
  }
  // 显式要求时才试重启 adb 服务（保留这条路，万一某些环境下它有效）
  await execAdbOnce(['kill-server'], { timeout: 20000 });
  await execAdbOnce(['start-server'], { timeout: 30000 });
  if (NET_SERIAL.test(String(serial || ''))) await execAdbOnce(['connect', serial], { timeout: 20000 });
  await new Promise(r => setTimeout(r, 1200));
  await delOnce();
  names2 = (await shell(serial, `ls ${remoteDir} 2>/dev/null`, { timeout: 30000 })).stdout || '';
  leftNames = String(names2).replace(/\r/g, '').split('\n').map(s => s.trim()).filter(n => n.length >= minLen);
  return {
    ok: leftNames.length === 0, tried: true,
    before: longOnes.length, after: leftNames.length,
    why: leftNames.length ? `重启 adb 服务后仍有 ${leftNames.length} 个超长残骸删不掉（需重启模拟器）` : ''
  };
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
 * ★★ 2026-10-04 提速：裸 `uiautomator dump` 的**上限（秒）**。
 *   为什么需要：在「永不 idle」的屏上，裸 dump 会先死等 ~11.5s 的 idle 超时才肯失败
 *   （真机实测：得物相册页 / 草稿箱那几屏），而那 11s 里什么都没干 —— 之后 dumpEx 才回退去
 *   关动画重抓（~2s），单步合计 13.5s。给裸 dump 加上限后，超时即被杀、直接走回退链，
 *   把 11.5s 压到 4s（健康页面裸 dump 实测 ~2.06s ⇒ 留了约 2× 余量，正常屏一点不受影响）。
 *   走设备自带的 `timeout`（MuMu / Android 6+ toybox 都有；真机实测 `timeout 2 sleep 5` → 124）。
 */
const DUMP_IDLE_CAP_S = 4;
/**
 * ★★ 2026-10-04：设备上**没有 `timeout`** 时 sh 的报错（真机形态：`/system/bin/sh: timeout: inaccessible or not found`）。
 *   命中 ⇒ `dumpOnce` 去掉上限原样再抓一次（老设备行为与改之前一字不差，绝不静默退到无文字的 dumpsys 通道）。
 */
const NO_TIMEOUT_RE = /timeout[^\n]*not found/i;
/**
 * 系统动画开关（三个）。得物发布页上有一个跟随它运行的循环动画：
 * 实测 animator_duration_scale=1 时 uiautomator 永远等不到 idle（连续 60 次、约 10 分钟全失败），
 * 同一秒内只把它置 0 就能立刻抓到 —— 所以「关动画重试一次，抓完还原」是可行的兜底。
 */
const ANIM_KEYS = ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale'];

const sleepMs = ms => new Promise(res => setTimeout(res, Math.max(0, Number(ms) || 0)));

/** 读三个动画开关；读不齐就不动它们（宁可重试失败，也不猜着改回去） */
async function animGet(serial) {
  // ★ 命令形式保持老样子（三条 `settings get` 用 `;` 连写）—— 真机实测它的输出就是
  //   **一行一个值**（健在 ⇒ 值；不存在 ⇒ 字面量 `null`）。
  //   ★ 别改成 `$()` + `printf`：那会（a）与测试夹具的命令正则脱节、
  //     （b）把一个本来正确的路径复杂化（我 2026-10-04 试过，13 条桩测试当场撞红）。
  const r = await shell(serial, ANIM_KEYS.map(k => `settings get global ${k}`).join('; '));
  if (!r.ok) return null;
  // ★★ 2026-10-04 真机复测修正（先记一次**误判**，免得后人再踩）：
  //   我曾把这里判成「`.trim().split(/\s+/)` 永远 return null」的大 Bug —— **那是错的**。
  //   当时看到的 `"\r\n\r\n\r\n"`（三个空行）是**设备 offline 期间**的残留输出，
  //   与代码无关。把设备连回来复测，同一条命令稳定返回：
  //      三个键都不存在 → "null\nnull\nnull"
  //      window=1、另两个不存在 → "1\nnull\nnull"
  //   ⇒ 老写法 `trim().split(/\s+/)` 对这串本来就能得到 3 个元素、**校验是过的**。
  //   （教训：一次异常环境下的读数，不能当成系统性 Bug 的证据；要连回复测。）
  //   ★ 这里仍改成**逐行**读，理由只有一个、且是硬的：`\s+` 会把「值里本来就有空格」的
  //     情形也切碎（settings 的值理论上可以是任意字符串），逐行才是 `settings get` 的真语义。
  const lines = String(r.stdout || '').replace(/\r/g, '').split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();   // adb 尾部空行不算
  if (lines.length !== ANIM_KEYS.length) return null;
  return lines.map(s => (s.trim() === 'null' ? null : s.trim().replace(/^"|"$/g, '')));
}

/** 关闭三个动画开关 */
async function animSet(serial, v) {
  return shell(serial, ANIM_KEYS.map(k => `settings put global ${k} ${v}`).join('; '));
}

/**
 * 还原；原本**不存在**的键要用 `settings delete`，别把字面量 `"null"` 写进去。
 *
 * ★ 实测语义：`settings put global <k> ""` 会 **`Bad arguments`**（空串写不进去），
 *   所以「读不到值」只有一条正确还原路径 —— `settings delete`。
 */
async function animRestore(serial, vals) {
  const cmd = ANIM_KEYS
    .map((k, i) => {
      const v = vals[i];
      return (v == null || v === 'null' || v === '')
        ? `settings delete global ${k}`
        : `settings put global ${k} ${v}`;
    })
    .join('; ');
  return shell(serial, cmd);
}

const DUMP_SPLIT = '___BLUEV_DUMP_SPLIT___';

/**
 * ★★ 把「读回 → 关闭 → 抓 → 还原」压成**一条 adb 往返**（批量关动画抓专用）。
 *
 * 为什么值得单开一条：实测「关动画抓一张屏」那条路上，光 `animGet` + `animSet` +
 * `animRestore` 就是 **3 次 adb 往返**（每次 shell 往返 150~190ms），
 * 而真正抓屏那次 `dumpOnce` 本来也只有一次往返。
 * 在「按步骤学习、同一屏每条内容都要抓」的场景里（相册页这类永不 idle 的屏），
 * 这笔固定税每条内容都要交一遍。
 *
 * 设备端 `settings` 的**实测语义**（真机 / MuMu 12 / Android 12，可复算）：
 *   · 键**不存在** ⇒ `settings get` 打印字面量 `null`；`settings list` 里不出现该键；
 *     这时 `settings put global <k> ""` 会 **`Bad arguments`**（空串写不进去）；
 *   · ⇒ 还原唯一正确的做法：**读到 `null` 就 `settings delete`**，否则 `put` 原值。
 *   · 这套设备上 `window_animation_scale` / `transition_animation_scale` 本来就处于
 *     「不存在」状态（**系统默认**，`settings list` 里显示成 `key=` 的空值），
 *     所以这一路**必须**走 delete，否则等于什么都没还原。
 *
 * ★★ 2026-10-04：**一条 shell 干完**（原来是读/写两次往返）。
 *   读回来的三个值**由我这里在 JS 里解析**，然后把「还原命令」以**定值**形式拼进同一条 shell ——
 *   不经过设备端的 shell 变量。为什么偏要绕开变量：
 *     · 夹具 `tools/fakeadb/adb.js` 按 `;` 逐条解析命令，且用
 *       `/^settings (get|put|delete) global (\S+)(?:\s+(\S+))?$/` 模拟真机（**要求以 key 结尾**）；
 *     · `A1=$(settings get …)` / `printf` / `if [ "$A1" = null ]` 这类它全认不出
 *       ⇒ 第一版就这么写，一次撞红 13 条桩测试。（夹具认不出 ≠ 夹具错：
 *         夹具那种写法恰好对应「settings 是独立命令、get 输出就是行文本」这个真机事实。）
 *   ⇒ 采**两段式**：第 1 段 `GETS; echo SPLIT; PUT0…; rm; dump; echo SPLIT; cat; echo SPLIT`，
 *      一次往返取回「读到的值 + dump 输出」；第 2 段只发**还原**（`delete` + 按需 `put` 定值，
 *      一条 shell、不含 dump）。全程不引用 shell 变量。
 *
 * ★ 还原命令的构造口径（与夹具 storage 语义严格对齐，实测过）：
 *     读到 `null`（键不存在）⇒ 只发 `delete <k>` —— 这样夹具里该键仍是「不存在」；
 *     读到 `0`/`1`        ⇒ `delete <k>` + `put <k> <值>` —— 值落回原位。
 *   （`delete` 对不存在的键幂等安全，所以「先删再放」不会出错。）
 *   ★ **不写成 `put <k> ""`**：真机上那是 `Bad arguments`（空串写不进去）。
 *
 * 安全性一字不降（与原来的 animGet/animSet/animRestore 逐条等价，只是换了条路送）：
 *   · **先读、读不齐就不动** —— 用**行数**校验（不存在也打印字面量 `null` 占一行，行数恒定 = 键数）；
 *     对不上就直接返回、连 `put 0` 都不会执行（不猜着改回去）。
 *   · 抓完**一定还原**；万一 dump 失败/超时，还原那条 shell 仍旧照发（不在 finally 里依赖 dump 结果）。
 *   · 读回与抓屏之间插 `echo ${DUMP_SPLIT}`；dump 之后先 `echo ${DUMP_SPLIT}` 再 `cat`
 *     —— 中段就是 dump 自己的输出（「是否成功」只在这一段里判），后段才是 XML 正文。
 *
 * 返回：{ ok, xml?, why?, idle? } —— ok=false 时 xml 一定不存在（**绝不返回上一次的旧内容**）。
 */
async function dumpAnimOff(serial) {
  const GETS = ANIM_KEYS.map(k => `settings get global ${k}`).join('; ');
  const PUT0 = ANIM_KEYS.map(k => `settings put global ${k} 0`).join('; ');

  // 第 1 段（一条 shell）：读回 → 关动画 → 抓 → 回传 XML。
  //   注意这里**先读再写**：读到的值马上要用来拼第 2 段的还原命令，所以读必须在抓之前完成。
  const r = await shell(serial,
    `${GETS}; echo ${DUMP_SPLIT}; ${PUT0}; rm -f ${DUMP_REMOTE}; uiautomator dump ${DUMP_REMOTE} 2>&1;`
    + ` echo ${DUMP_SPLIT}; cat ${DUMP_REMOTE} 2>&1; echo ${DUMP_SPLIT}`,
    { timeout: 60000 });

  const all = String(r.stdout || '').replace(/\r/g, '');
  const seg = all.split(DUMP_SPLIT);
  // seg[0] = 三个动画开关的值（一行一个）；seg[1] = dump 自己的输出；seg[2] = XML 正文。
  const rawVals = String(seg[0] || '').split('\n');
  while (rawVals.length && rawVals[rawVals.length - 1] === '') rawVals.pop();
  const clean = rawVals.map(s => s.trim());

  // ★ 读不齐：**什么都不动**（连 put 0 都没发出——它在同一条 shell 的后半段，但那半段没被解析就不会拼还原）；
  //   这里如实说明，不假装抓到了。
  if (seg.length < 3 || clean.length !== ANIM_KEYS.length) {
    // 万一第 1 段跑到了写那一步（设备上其实改了），也得把它放回去 —— 用**能读到的**部分尽力还原。
    await restoreAnimBestEffort(serial, clean);
    return {
      ok: false, idle: false,
      why: `读不到设备的动画开关（期望 ${ANIM_KEYS.length} 个、读到 ${clean.length} 个）`
        + '，所以没靠关动画抓这一屏'
    };
  }

  const mid = String(seg[1] || '').trim();
  const body = String(seg[2] || '');

  // 第 2 段：还原（无论抓成没成，都发）。
  const restoreCmd = animRestoreCmd(clean);
  await shell(serial, restoreCmd, { timeout: 30000 });

  if (!/dumped to/i.test(mid)) {
    const last = mid.split('\n').map(s => s.trim()).filter(Boolean).pop() || '';
    return { ok: false, idle: /idle state/i.test(mid) || !mid, why: last || 'uiautomator dump 没有任何输出' };
  }
  if (!/</.test(body)) return { ok: false, idle: false, why: 'dump 已写出，但内容读不出来' };
  return { ok: true, xml: body.replace(/^\s*[\s\S]*?<\?xml/, '<?xml').trim(), animOff: true, via: 'uiautomator' };
}

/**
 * 由「读到的三个值」拼出还原命令（**定值**，不引用 shell 变量）。
 * 读到 `null`/空 ⇒ 该键本来就不存在 ⇒ 只 `delete`；否则 `delete` + `put 原值`。
 */
function animRestoreCmd(clean) {
  return ANIM_KEYS.map((k, i) => {
    const v = clean[i];
    return (v == null || v === '' || v === 'null')
      ? `settings delete global ${k}`
      : `settings delete global ${k}; settings put global ${k} ${v}`;
  }).join('; ');
}

/**
 * 「读不齐」时的尽力还原：只对**确实读到值**的那些键动手，读不到的一个都不碰。
 * （宁可少还原一个，也不把用户的设置改成一个我猜的值。）
 */
async function restoreAnimBestEffort(serial, clean) {
  const parts = [];
  ANIM_KEYS.forEach((k, i) => {
    const v = clean[i];
    if (v == null || v === '') return;                       // 没读到：不动
    parts.push(v === 'null' ? `settings delete global ${k}` : `settings put global ${k} ${v}`);
  });
  if (!parts.length) return { ok: true, skipped: true };
  try { return await shell(serial, parts.join('; '), { timeout: 20000 }); }
  catch (e) { return { ok: false, why: String(e && e.message || e) }; }
}

/**
 * 抓一次，成功/失败都给出结构化结果 —— **绝不会返回上一次的旧内容**。
 *
 * 为什么要先 rm：uiautomator dump 失败时**不写文件**（实测「页面不 idle」失败后，
 * 目标文件仍是上一次的 47 字节哨兵，一字未动）。而旧实现是共用一个远端路径、
 * 抓完直接 cat，且不检查 dump 的返回 —— 失败时会把**上一个页面**的结构当成本页返回，
 * 调用方于是拿着旧页面的坐标去点新页面。这是「静默点错」，比报错危险得多。
 */

async function dumpOnce(serial) {
  // ★ 2026-10-03 提速：rm / dump / cat 原来是**三次** adb 往返，每次固定 ~110-180ms
  //   ⇒ 每条内容 21 个点击步白花 ~4.6s。合成一条 shell 后只剩一次往返。
  //   失败判据（“没输出” vs “读不出来”）一字未改，只是从「看整体输出」改成「看标记前半段」。
  // ★★ 2026-10-04 提速（用户投诉「还是慢」的真凶之一，真机实测）：
  //   「永不 idle」的屏（得物相册页 / 草稿箱那几屏）上，裸 `uiautomator dump` 会**先死等
  //   约 11.5 秒** idle 超时才失败，之后 dumpEx 才回退去关动画重抓（~2s）⇒ 单步 **13.5s**，
  //   其中 11s 是纯白等、没有任何有效动作。
  //   ⇒ 用设备自带的 `timeout`（MuMu / Android 6+ toybox 都有；真机实测
  //     `timeout 2 sleep 5` → 退出码 124）给裸 dump 加上限：超时就杀掉，当作「没抓到」，
  //     照旧走原有回退链（关动画 → dumpsys）。11.5s 白等 ⇒ 4s
  //     （健康页面裸 dump 实测 ~2.06s，留了 ~2× 余量）。
  const send = (prefix) => shell(serial,
    `rm -f ${DUMP_REMOTE}; ${prefix}uiautomator dump ${DUMP_REMOTE} 2>&1; echo ${DUMP_SPLIT}; cat ${DUMP_REMOTE} 2>&1`,
    { timeout: 40000 });
  const parse = (r) => {
    const all = String((r && r.stdout) || '');
    const cut = all.indexOf(DUMP_SPLIT);
    return {
      ok: !!(r && r.ok),
      head: (cut >= 0 ? all.slice(0, cut) : all).trim(),
      body: cut >= 0 ? all.slice(cut + DUMP_SPLIT.length) : ''
    };
  };

  let r = await send(`timeout ${DUMP_IDLE_CAP_S} `);
  let p = parse(r);
  // ★★ 2026-10-04：设备上**没有 `timeout`**（老的 / 精简过的系统）⇒ 去掉上限、原样再抓一次。
  //   为什么不干脆当「没抓到」：再往下会退到 dumpsys 备用通道，而那条**没有文字**
  //   ⇒ 定位表里按文字找的步骤会一起失效（静默的行为退化，最难查）。宁可多一次往返，
  //   也要抓回带文字的结构。这样做出来，老设备上的行为与改之前**一字不差**。
  if (NO_TIMEOUT_RE.test(p.head)) {
    r = await send('');
    p = parse(r);
  }
  const head = p.head;
  const body = p.body;
  if (!/dumped to/i.test(head)) {
    const last = head.split(/\r?\n/).map(s => s.trim()).filter(Boolean).pop() || '';
    // ★★ 2026-10-03 真机实测：得物发布页首屏（选素材相册）有时**一个字都不打印**，
    //   而不是报 “could not get idle state”。症状不同、病因一样（页面永远不 idle）。
    //   旧判据只认 “idle state” ⇒ 「临时关动画重试」那条路根本不会走，
    //   直接掉到 dumpsys 备用通道（那条拿不到文字）。
    //   实测：关掉三个系统动画开关后，同一屏一次就抓到（85 个节点）。
    //   ★ 2026-10-04：`timeout` 上限被杀时，sh 同样**一个字都不打印** ⇒ 也走这条回退。
    const looksIdle = /idle state/i.test(head) || !head;
    return { ok: false, idle: looksIdle, why: last || 'uiautomator dump 没有任何输出' };
  }
  if (!p.ok || !/</.test(body)) return { ok: false, idle: false, why: 'dump 已写出，但内容读不出来' };
  return { ok: true, xml: body.replace(/^\s*[\s\S]*?<\?xml/, '<?xml').trim() };
}

/**
 * dump 的详细版：拿不到时告诉调用方**为什么**（是页面不 idle，还是设备不在线）。
 * 返回 { ok, xml?, why, idle, animOff }
 */
async function dumpEx(serial, { retries = 1, retryMs = 1200, allowAnimOff = true, pkg = '', preferAnimOff = false } = {}) {
  let last = { ok: false, idle: false, why: '未尝试' };
  // ★★ 2026-10-04 提速：已经知道「这一屏不会 idle」时，**直接走关动画那条路**，
  //   不再先白等一次 uiautomator 的 idle 超时。
  //   真机实测（MuMu 12 / 得物相册页）：裸 dump 连打 3 次 11230/11136/11127 ms 全部
  //   `could not get idle state`；同一张屏关掉系统动画后 2036ms 就抓到。
  //   ⇒ 那 ~11 秒纯粹是白等。批量发布里同一条屏每条内容都要经过一次，
  //     所以由调用方（publisher）按**步骤**记住它，本批第 2 条起直接从这里进。
  //   动画开关照旧**抓完立刻还原**（finally），不把用户设备留在改过的状态。
  if (preferAnimOff && allowAnimOff) {
    // ★★ 2026-10-04 提速：这条路原来是 animGet + animSet + dumpOnce + animRestore
    //   = **4 次 adb 往返**（实测每次 shell 往返 150~190ms，光固定税就近 0.7s）。
    //   「读回→关闭→抓→还原」压成一条 shell（见 dumpAnimOff），只花 1 次往返。
    //   还原仍在那条 shell 的**最后一步** ⇒ 抓失败/超时也照样还原，语义与原来逐条一致。
    const r0 = await dumpAnimOff(serial);
    if (r0.ok) return r0;
    last = Object.assign({ animOff: true }, r0);
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
 * ★★ 给**失败信息**加一句「设备是不是掉线了」——**只在调用方已经决定要抛错时**调一次。
 *
 * 为什么需要它（真机实测 / `adb.exe: device offline`）：
 *   设备掉线时 uiautomator dump 一个字都不打印、`dumpsys activity top` 也跑不起来，
 *   于是调用方看到的是这一串 ——
 *     「拿不到界面结构：uiautomator dump 没有任何输出（想临时关掉系统动画重试，但读不到设备的
 *        动画开关，所以没动它）（dumpsys 备用通道也没抓到：dumpsys activity top 跑不起来）」
 *   通篇在讲 dump 通道，**一个字都没提设备掉线**。而处置完全不同：
 *     「页面不 idle」⇒ 等一等 / 关动画；「设备离线」⇒ 重连 / 重启模拟器。
 *   ⇒ 排查会被带偏很远（2026-10-04 真机上就这么被骗了一次）。
 *
 * ★★★ 为什么**绝不能塞进 `dumpEx` 内部**（我第一版就是塞里面，把 adbtest 里 13 条桩测试全撞断了）：
 *   adbtest 用**桩 adb**（假 serial `127.0.0.1:5555` + 一组桩文件）来验真实逻辑，
 *   桩**不实现 `get-state`** ⇒ 一旦 dumpEx 内部探状态，就会：
 *     ① 判成"离线"而**改变解题路径**（桩序列错位，测的就不再是真实逻辑了）；
 *     ② 那次探测调用**写进 calls.log**，把「dump 次数」「settings 调用序列」这类
 *        **计数型断言**全部打乱。
 *   ⇒ 这条诊断只能是**纯附加信息**：由调用方在**已经决定要抛错**的那一刻调用，
 *     成功/失败都**不改变任何控制流**，只往 why 里多贴一句。
 *
 * @returns {string} 空串 = 设备在线（或读不出结论 —— 那就什么都不说，不猜）
 */
async function offlineHint(serial) {
  try {
    // ★ 用 `devices` 而不是 `get-state`：两者真机都能判，但 `devices` 兼容面更广。
    const r = await execAdbOnce(['devices'], { timeout: 8000 });
    if (!r.ok) return '';
    const rows = String(r.stdout || '').replace(/\r/g, '').split('\n').slice(1)
      .map(l => l.trim()).filter(Boolean).map(l => l.split(/\s+/));
    const me = rows.find(x => x[0] === serial);
    if (me && me[1] === 'device') return '';   // 在线 ⇒ 什么都不说（不打扰）
    const state = me ? me[1] : '没出现在 adb devices 里';
    return ` ★ 另外：这台设备现在**不在线**（adb devices 里是「${state}」）——`
      + ' 如果上面那串「抓不到结构」看着不像页面问题，先 `adb connect` 重连、或重启模拟器。';
  } catch (e) { return ''; }
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
  // ★★ 2026-10-04 实测修正：这里原来只写 `'dumpsys activity top 跑不起来'`，
  //   **把 adb 自己给的 stderr 整个丢掉了**。真机踩到的后果：
  //   设备掉线（`adb.exe: device offline`）时，报错会退化成
  //     「拿不到界面结构：uiautomator dump 没有任何输出（想临时关掉系统动画重试，但读不到
  //       设备的动画开关，所以没动它）（dumpsys 备用通道也没抓到：dumpsys activity top 跑不起来）」
  //   —— 通篇在说 dump 通道，**一个字都没提设备离线**。而真因就是设备离线，
  //   与「页面不 idle / 备用通道不行」是**完全无关的两件事**，排查会被带偏很远。
  //   ⇒ 把 stderr 带出来（有 stderr 就是 adb 层的错，优先说清楚）。
  if (!r.ok) {
    const err = String(r.stderr || r.stdout || '').trim();
    return { ok: false, why: 'dumpsys activity top 跑不起来' + (err ? '：' + err.split(/\r?\n/)[0] : '') };
  }
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

/** dump 出来的 text 属性里可能带 XML 实体（得物的 emoji 就是 `&#127863;`）⇒ 回读时必须还原成真字符 */
function unxml(s) {
  return String(s == null ? '' : s)
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * ★★★ 2026-10-04 新增：**回读某个输入框里现在到底是什么**。
 *
 * 为什么非有不可：得物的输入框空着的时候，`text` 属性就是**占位符**（「添加标题」「添加作品描述」），
 * ⇒「填进去了没有」在**截图和日志上都看不出来**（空框与没填长得一模一样）。今晚真机实测就有两个
 * 静默失败都栽在这上面 —— 而它们都会被记成「发布成功」：
 *   · 空格被改写成字面 `%s` 打进标题（见 inputText 的注释，已修）；
 *   · 中文一个字没进去（输入法不是 ADBKeyboard 时，广播没人接），而广播照样返回成功。
 * ⇒ 判据只能来自「输入完之后**再读一次这个框**」。
 *
 * 读不到（节点不存在 / dump 失败）**既不算通过也不算失败**：如实返回 `ok:false` + `why`，
 * 由调用方决定怎么处置（本项目口径：「读不到 ≠ 成功」，见 publisher 里的处理）。
 *
 * @returns {Promise<{ok:boolean, text?:string, why?:string}>}
 */
async function readTextOf(serial, id, { pkg = '' } = {}) {
  const want = String(id || '').trim();
  if (!want) return { ok: false, why: '没给要回读的 resource-id' };
  const d = await dumpEx(serial, { pkg, retries: 0 });
  if (!d.ok) return { ok: false, why: d.why || '读不到界面结构（所以无法确认填进去没有）' };
  const esc = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp('<node[^>]*resource-id="' + esc + '"[^>]*>').exec(d.xml);
  if (!m) return { ok: false, why: `这一屏上找不到「${want}」这个节点` };
  const t = /text="([^"]*)"/.exec(m[0]);
  return { ok: true, text: unxml(t ? t[1] : '') };
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
 *
 * ★★ 2026-10-04 真机实测（这次是**用户反馈**逼出来的，必须记死）：
 *    症状 = `输入失败：/system/bin/sh: no closing quote`，**两条视频全挂**，正文一个字都没进去。
 *
 *    根因 = **换行之后紧跟 `#`（或反引号）**。得物的正文是「4~5 行短句 + 若干 `#话题`」，
 *    而话题**自带行首 `#`** ⇒ 每一篇正常文案都命中。设备端 `sh` 把行首 `#` 当**注释**嚼掉，
 *    连带把命令末尾那个收尾的双引号一起吃掉 ⇒ sh 报「引号没闭合」，广播根本没发出去。
 *
 *    逐条实测（内置 adb 37.0.1 / MuMu 12 / Android 12，可复算）：
 *      `#TW男装`（单行）            → 通过（行首就在命令开头，shell 不把它当续行注释）
 *      `"a\n#TW男装"`               → **失败 no closing quote**
 *      `"a\n##TW"`                  → **失败**（`#` 开头都算）
 *      `"a\n`b"`                    → **失败**（反引号触发命令替换）
 *      `"a #TW男装"`（# 不在行首）   → 通过
 *      `"a\n #TW男装"`（前面有空格） → 通过
 *      `"a\n$X"` / `"a\n;b"` / `"a\n&b"` / `"a\n"b"` / `"a\n\\b"` → 全通过
 *    （`$` `;` `&` 之所以没事，是因为它们在**双引号里**本来就不展开、或展开后无副作用；
 *      `#` `\`` 是双引号里唯二会真的改变解析结果的。）
 *
 *    修法 = 把 `#` 与反引号**逐字转义**（`#` → `\#`、`` ` `` → `` \` ``）。
 *    这两个反斜杠在双引号内会被 sh 剥掉 ⇒ **送进输入框的是原字符**，内容一字不改。
 *    （放在最后一步做，因为前面的 `%s`/`"`/`\` 转义会引入新的反斜杠，顺序反了会重复转义。）
 *    ★ 也顺带把 `$` 转义了 —— 双引号里 `$` 会展开，`$X` 变成空串会**静默丢字符**（不报错，更难查）。
 */
/**
 * ★★ 2026-10-04 —— 这里踩过一次「修了个不存在的 bug，还把内容改坏了」，记死：
 *
 * 一度以为「行首 `#` 会被设备端 sh 当注释 ⇒ 吃掉收尾双引号 ⇒ no closing quote」，
 * 于是加了这个函数去转义 `#` / 反引号 / `$`（还连反斜杠一起转）。
 * **真机复核结论：那个诊断是错的。**
 *   - 逐条真机实验（`echo` 走与 inputText 逐字相同的命令构造）：
 *     行首 `#TW`、`##TW`、`# TW`、tab 后 `#`、多行正文 …… **没有一条炸**。
 *     连 `#TW` 单行都不炸。
 *   - 真正的 `no closing quote` 只由 **未转义的双引号** 引起（本次唯一真会炸的字符）。
 *   - 更糟的是：那个「修法」把**反斜杠真的写进了用户正文**（真机 dump 读回
 *     `\#TW男装`），发布出去就是一篇带反斜杠的错文案 —— 静默改坏内容比报错严重得多。
 *   - 当时之所以"看起来修好了"，是因为夹具（tools/fakeadb/adb.js）里那条判据
 *     `/(^|\n)(#|`)/` **是我自己写的**，不是设备行为 ⇒ 夹具和"修法"互相印证，
 *     形成闭环假通过（见「反向验证的假通过坑」⑨：**验的是自己的假设，不是真机**）。
 *
 * ⇒ 现在的口径：**只转义真正会破坏 shell 双引号语义的字符**，其余一律原样。
 *   在双引号里能改变解析的只有三样：`"`（结束字符串）、`` ` ``（命令替换）、`$`（变量/命令替换）。
 *   `#` 在双引号里**没有特殊含义**（注释只在词首、且必须在引号外）—— 不动它。
 *   ★ 反斜杠也**不转**：`am broadcast --es msg "..."` 这条路上，反斜杠会被 Android 的
 *     参数解析原样带进文本 ⇒ 转了就等于往正文里加字符（实测泄漏为 `\#`）。
 *     若将来要支持「正文里真的含反斜杠」，不能靠加转义，得换一条不经过 shell 的通道
 *     （例如 `adb push` 一个文件再让设备端读），否则无解。
 */
function shellQuoteForInputText(s) {
  return String(s)
    .replace(/(["`$])/g, '\\$1');  // 只动这三样：结束引号 / 命令替换 / 变量替换
}

async function inputText(serial, text) {
  const s = String(text == null ? '' : text);
  const asciiOnly = /^[\t\n\r\x20-\x7E]*$/.test(s);

  // 纯 ASCII：`input text` 实测可用，而且不依赖设备上的输入法状态，优先用它。
  //   ★ 这里把空格换成 `%s` 是**对的** —— `input text` 认这个写法，不换的话整串会被拆成多个参数。
  if (asciiOnly) {
    const esc = shellQuoteForInputText(s).replace(/ /g, '%s');
    return shell(serial, `input text "${esc}"`);
  }

  const kbd = await keyboardReady(serial);
  if (!kbd.active) {
    const short = s.length > 12 ? s.slice(0, 12) + '…' : s;
    return {
      ok: false, code: 'ime-not-active', stdout: '',
      stderr: `要输入的内容「${short}」里有中文（或其它非 ASCII 字符），这类字符只有 ADBKeyboard 能打进去，`
        + `而设备上它现在不是当前输入法（当前是 ${kbd.current || '未知'}）—— 广播没有人接收，一个字也进不去。`
        + '（不要去改「用 input text 硬打」：实测它对中文无效，却照样返回成功，会把没标题没正文的帖子发出去。）'
        + '程序会在设备连接/检查时自动重试内置输入法配置；配置完成前发布会被拦住。'
    };
  }
  // ★★★ 2026-10-04 真机实测修掉的一个**静默改写用户文案**的 bug：
  //   原来这里也是 `am broadcast -a ADB_INPUT_TEXT --es msg "${esc}"`，而 `esc` 里的空格已被
  //   换成了 `%s`。`input text` 认 `%s`，**广播这条通道不认** ⇒ 空格原样变成字面的 `%s` 打进输入框。
  //   现场证据：报告里标题「酒红调长袖T恤 氛围感拉满🍷」（含一个空格）→ 发布页 dump 回读到的
  //   `etTitle` 是「酒红调长袖T恤%s氛围感拉满🍷」；三条里只有这一条带空格，也只有它中招。
  //   ⇒ 改成走 ADBKeyboard 的 **ADB_INPUT_B64**（内置 APK 实测含这个 action）：
  //     传的是**原始 UTF-8 字节的 base64**，字母表只有 A-Za-z0-9+/=（没有空格、引号、$、反引号、
  //     中文、换行）⇒ 设备端再怎么解析引号都不可能坏，空格/emoji/换行全部原样进去。
  //   （`am broadcast ... --es msg <base64>` 里 base64 不含特殊字符 ⇒ 连引号都不需要。）
  const b64 = Buffer.from(s, 'utf8').toString('base64');
  return shell(serial, `am broadcast -a ADB_INPUT_B64 --es msg ${b64}`);
}

/**
 * 自动配置随包内置的中文输入法。★ **三步缺一不可**：
 *   ① `adb install -r ADBKeyboard.apk`
 *   ② `ime enable <组件>` —— 只装了不启用，`ADB_INPUT_TEXT` 广播没人接
 *   ③ `ime set <组件>`    —— 不设成当前输入法，中文仍然打不进输入框
 *
 * ★ 设备连接或发布前由程序自动补齐这三步，不要求用户单独操作。
 *   设成默认输入法后，模拟器里的手动输入不会弹出系统键盘；发布器用 ADBKeyboard 广播写入文本。
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

  const installed = await packages(serial);
  if (!installed.some(p => p === 'com.android.adbkeyboard')) {
    return { ok: false, step: 'verify-install', error: 'adb install 返回成功，但设备回读不到 com.android.adbkeyboard' };
  }
  const comp = (await adbKeyboardIme(serial)) || IME_COMPONENT_DEFAULT;
  const en = await shell(serial, `ime enable ${comp}`);
  const st = await shell(serial, `ime set ${comp}`);
  const after = await defaultIme(serial);
  const enabled = await adbKeyboardIme(serial);
  const nowDefault = /adbkeyboard/i.test(after);
  const ready = !!(en.ok && st.ok && /adbkeyboard/i.test(enabled) && nowDefault);
  return {
    ok: ready, step: ready ? 'done' : 'ime', apk, component: comp, defaultIme: after,
    error: ready ? '' : `输入法已安装但未通过启用状态校验（启用命令=${en.ok ? '成功' : '失败'}，设置默认=${st.ok ? '成功' : '失败'}，当前=${after || '未知'}，已启用=${enabled || '无'}）—— 原始输出：`
      + (String(en.stdout || '') + String(st.stdout || '') + String(st.stderr || '')).trim(),
    raw: (instText + '\n' + en.stdout + '\n' + st.stdout).trim()
  };
}

const keyboardSetupByDevice = new Map();
/** 确保设备可用中文输入；检查当前状态，缺失时自动装入并启用随包内置版本。 */
async function ensureKeyboard(serial) {
  if (keyboardSetupByDevice.has(serial)) return keyboardSetupByDevice.get(serial);
  const task = (async () => {
    const installed = await packages(serial);
    if (!installed.some(p => /shizhuang|duapp|poizon|dewu/i.test(p))) {
      return { ok: false, step: 'device', error: '设备里没有检测到得物；为避免修改其它设备，未安装或切换输入法' };
    }
    const before = await keyboardReady(serial);
    if (before.active) return { ok: true, alreadyReady: true, defaultIme: before.current };
    const result = await installKeyboard(serial);
    return Object.assign({ alreadyReady: false }, result);
  })();
  keyboardSetupByDevice.set(serial, task);
  try { return await task; }
  finally { keyboardSetupByDevice.delete(serial); }
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
 * ★★★ 2026-10-04 新增：**当前点击坐标系**下的屏幕尺寸（就是 `input tap` 与 dump `bounds` 共用的那个空间）。
 *
 * 为什么不能拿 `wm size` 代替（本机 MuMu 12 实测，两个数**不相等**）：
 *   · `wm size` 报的是**物理/自然方向**尺寸：`Physical size: 1080x1920` —— 它**不随旋转变**；
 *   · `dumpsys window displays` 里 `init=1080x1920 … cur=1920x1080` —— **`cur=` 才是当前坐标系**；
 *   · 实测同一次会话里三处数字互相印证：MuMu 桌面（横屏）时 `cur=1920x1080`，
 *     `screencap` 得到的 PNG 也是 1920x1080，`uiautomator dump` 的 bounds 最大 x=1920 / y=1080；
 *     把得物拉到前台（它是竖屏锁定的）后同一命令立刻变成 `cur=1080x1920`。
 *   ⇒ 拿 `wm size` 去校验坐标会**判反**：横屏时它会说 1080x1920，而真实坐标系是 1920x1080。
 *
 * 为什么非要读它：`input tap x y` 对**越界坐标不会报错**（实测 `input tap 945 1869` 在
 * 1920x1080 的屏上 rc=0，一个字都不说，什么都没点到）。定位表里的 `tapXY` 是写死的绝对值，
 * 一旦抓表时的坐标系和当下不一致（换设备 / 改过模拟器分辨率 / 前台应用方向变了），
 * 每一步都会**安静地点偏**，而日志上一条错都没有 —— 这正是「有具体坐标却老点偏」的机制。
 *
 * @returns {{known:boolean, w:number, h:number, initW:number, initH:number,
 *            landscape:boolean, portrait:boolean, rotated:boolean, raw:string}}
 *   known=false 表示**没读到**（老版本 dumpsys 格式不同 / 命令失败）—— 调用方必须**当不知道处理**，
 *   绝不许拿一个猜出来的尺寸去判「坐标越界」（那是拿幻觉当判据）。
 */
async function uiSize(serial) {
  const out = { known: false, w: 0, h: 0, initW: 0, initH: 0, landscape: false, portrait: false, rotated: false, raw: '' };
  const r = await shell(serial, 'dumpsys window displays');
  const s = String(r.stdout || '');
  if (!r.ok || !s) return out;
  const cur = s.match(/\bcur=(\d+)x(\d+)/);
  if (!cur) return out;
  const init = s.match(/\binit=(\d+)x(\d+)/);
  out.w = Number(cur[1]); out.h = Number(cur[2]);
  if (init) { out.initW = Number(init[1]); out.initH = Number(init[2]); }
  out.landscape = out.w > out.h;
  out.portrait = out.w < out.h;
  // 旋转过 = 当前坐标系与自然方向**不平行**（竖屏设备转成横屏，或反过来）
  out.rotated = !!(init) && ((out.initW > out.initH) !== (out.w > out.h));
  out.known = out.w > 0 && out.h > 0;
  out.raw = (cur[0] || '') + (init ? ' ' + init[0] : '');
  return out;
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
  //   ★★★ 2026-10-04 新增「深错屏」硬恢复 —— 这是真机实测出来的**「第二条永远拉不起来」的根因**：
  //     得物**还活着**、但停在**它自己的另一个页面**（实测是草稿箱 `DraftActivity`；发布流程页同理）时，
  //     `am start -n <pkg>/<launchActivity>` 是**无效的** —— 那个 Activity 已经在任务栈里，
  //     启动它只会把**原来那一页**顶到前台，于是「等了 30s，得物还是停在 DraftActivity」。
  //   ⇒ 判据与处置：等了一个窗口（min(8s, timeout/3)）之后**仍停在得物自己的非目标页** ⇒
  //     先 `am force-stop` 把它整个停掉，再 `am start` 一次（**只做一次**），然后继续轮询到超时。
  //     ★ 只在「前台确实是本 App、且不是要等的那一屏」时才这么做 ⇒ 不会误伤「别的 App 在前台」的情况，
  //       也不会在「读不到前台」时瞎启动（那两种情况各自有上面的分支处理）。
  const hardAfterMs = Math.min(8000, Math.max(3000, timeout / 3));
  let hardTried = false;
  for (;;) {
    focus = await readFocus();
    if (isWant(focus)) return { ok: true, focus, started, from: before, why: '' };
    if (!hardTried && focus && isFocusOf(focus, pkg) && Date.now() - t0 >= hardAfterMs) {
      hardTried = true;
      await forceStop(serial, pkg);
      await sleepMs(700);
      if (activity) {
        const r2 = await shell(serial, 'am start -n ' + pkg + '/' + activity);
        if (/Error type \d+|does not exist/.test(String(r2.stdout || '') + String(r2.stderr || ''))) {
          return { ok: false, focus, started, from: before,
            why: `得物停在「${focus}」拉不动，强制重启它也失败了：`
              + String(r2.stdout || '').trim().split(/\r?\n/)[0] };
        }
      } else {
        await shell(serial, 'monkey -p ' + pkg + ' -c android.intent.category.LAUNCHER 1');
      }
      started = true;
      continue;
    }
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
  let pkgs = await packages(serial);
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
  // 发布所需输入法随安装包提供；设备在线后由程序自动安装、启用并设为当前输入法。
  // 设备上没有中文输入法时，依赖失败必须明确阻断发布，不能要求用户另行下载。
  if (!out.adbKeyboardActive && out.imeApkExists) {
    out.imeSetup = await ensureKeyboard(serial);
    if (out.imeSetup.ok) {
      pkgs = await packages(serial);
      out.adbKeyboard = pkgs.some(p => p.includes('com.android.adbkeyboard'));
      out.adbKeyboardIme = await adbKeyboardIme(serial);
      const kbd = await keyboardReady(serial);
      out.adbKeyboardActive = kbd.active;
      out.adbKeyboardCurrent = kbd.current;
      out.notes.push(out.imeSetup.alreadyReady
        ? '内置中文输入法已就绪'
        : '已自动安装并启用内置中文输入法');
    } else {
      out.imeSetupError = `自动配置内置中文输入法失败（${out.imeSetup.step}）：${out.imeSetup.error}`;
      out.notes.push(out.imeSetupError);
    }
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
    const setupError = out.imeSetupError || '';
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
      + (out.imeApkExists
        ? (setupError ? `${setupError}。重新连接设备后程序会自动重试。` : '程序已自动尝试配置内置输入法；连接设备后会自动重试。')
        : '程序安装包缺少内置 ADBKeyboard.apk，请修复或重新安装本工具；不需要用户另行下载。'));
  }
  if (!out.appPackage) {
    out.notes.push('设备里没找到得物 App 包名，请确认已安装登录');
    say('bad', '模拟器里没找到「得物」',
      '确认这台模拟器装的是得物并且已经登录，再点一次「检查能不能发布」。');
  }
  return out;
}

module.exports = {
  execAdb, version, devices, online, shell, push, mediaScan, mediaVisible, clearMediaDir, clearAlbum, reapLongTrashDirs, filesMissing, screencap, forceStop,
  makeNewest, mediaNewest, toMediaPath,
  dump, dumpEx, lastDumpInfo, dumpViaDumpsys, vhToXml, tap, tapSeq, keyevent, inputText, packages, probe,
  readTextOf, unxml,
  dumpAnimOff, animRestoreCmd, shellQuoteForInputText, offlineHint,
  setAdbPath, getAdbPath, setBundledAdbDir, getBundledAdbDir, bundledAdbPath,
  setBundledApkPath, getBundledApkPath, resolveAdbChoice, getActiveAdb, bundledStatus,
  installKeyboard, ensureKeyboard, adbKeyboardIme, defaultIme, keyboardReady, currentFocus,
  uiSize,
  ensureApp, isFocusOf, frontActivity, topActivityMatching
};
