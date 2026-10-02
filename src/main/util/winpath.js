'use strict';
/**
 * Windows 文件系统适配层
 * PRD 里点名的三个 Windows 坑，都收敛在这里：
 *   1) 长路径：扁平化后「货号+颜色+序号」变长，容易撞 MAX_PATH(260) → 统一加 \\?\ 前缀
 *   2) 硬链接：同卷建链接（元数据操作，秒级）；跨卷只能实体复制
 *   3) 占用阻塞：网盘同步 / 看图软件 / 资源管理器预览会锁目录 → 改名与删除要重试
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const IS_WIN = process.platform === 'win32';

const MEDIA_EXT = ['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.bmp', '.tif', '.tiff'];
const VIDEO_EXT = ['.mp4', '.mov', '.m4v', '.avi', '.webm', '.mkv'];
const JUNK_NAME = ['.ds_store', 'thumbs.db', 'desktop.ini', '.localized', 'ehthumbs.db'];
const JUNK_DIR = ['__macosx', '.ipynb_checkpoints', 'system volume information', '$recycle.bin'];

function isWin() { return IS_WIN; }

/** Windows 下加 \\?\ 长路径前缀（UNC 走 \\?\UNC\） */
function toLong(p) {
  if (!IS_WIN || !p) return p;
  const abs = path.resolve(p);
  if (abs.startsWith('\\\\?\\')) return abs;
  if (abs.startsWith('\\\\')) return '\\\\?\\UNC\\' + abs.slice(2);
  return '\\\\?\\' + abs;
}

/** 去掉长路径前缀，用于界面展示 */
function toDisplay(p) {
  if (!p) return p;
  let s = String(p);
  if (s.startsWith('\\\\?\\UNC\\')) return '\\\\' + s.slice(8);
  if (s.startsWith('\\\\?\\')) return s.slice(4);
  return s;
}

/** 长度超限预警（Windows MAX_PATH 260，留 40 字符余量给文件名） */
function pathRisk(p) {
  if (!IS_WIN) return null;
  const len = path.resolve(p).length;
  if (len > 200) return 'long';
  return null;
}

function sameVolume(a, b) {
  if (!IS_WIN) return true;
  const ra = path.parse(path.resolve(a)).root.toLowerCase();
  const rb = path.parse(path.resolve(b)).root.toLowerCase();
  return ra === rb;
}

const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'UNKNOWN']);

async function retry(fn, { tries = 6, delay = 350, factor = 1.7, onRetry = null } = {}) {
  let lastErr = null;
  let wait = delay;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      if (!RETRY_CODES.has(e && e.code)) throw e;
      if (onRetry) onRetry(e, i + 1);
      if (i < tries - 1) await new Promise(r => setTimeout(r, wait));
      wait = Math.round(wait * factor);
    }
  }
  throw lastErr;
}

async function mkdirp(dir) {
  await fs.promises.mkdir(toLong(dir), { recursive: true });
}

/** 「文件被别的程序占着」这类可重试的锁错误（WPS/Excel 打开着发布单时就是这种） */
const LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE']);
/**
 * 判断异常是不是「被占用」。
 * 用途：结果回写时，**只有**这类错误才该「整批暂存、下次再试」；
 * 像「报告表头缺列」这种逻辑错误重试一万次也不会好，必须原样报出来 ——
 * 否则会把不可恢复的错误伪装成「仍被占用」，让人以为关掉 Excel 就能补写。
 */
function isFileLockError(e) {
  const code = String((e && e.code) || '');
  if (LOCK_CODES.has(code)) return true;
  const msg = String((e && e.message) || '');
  return /EBUSY|EPERM|EACCES|being used by another process|permission denied|the process cannot access|cannot access the file|被占用|正在使用|拒绝访问/i.test(msg);
}

async function readdirSafe(dir) {
  try {
    return await fs.promises.readdir(toLong(dir), { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EACCES') return [];
    throw e;
  }
}

async function statSafe(p) {
  try { return await fs.promises.stat(toLong(p)); } catch (e) { return null; }
}

async function exists(p) {
  try { await fs.promises.access(toLong(p)); return true; } catch (e) { return false; }
}

/** 建硬链接；跨卷或不支持时自动退化为实体复制 */
async function linkOrCopy(src, dst, { force = false } = {}) {
  const s = toLong(src), d = toLong(dst);
  await mkdirp(path.dirname(dst));
  if (!force) { const st = await statSafe(dst); if (st) return 'skip'; }
  if (sameVolume(src, dst)) {
    try {
      await retry(() => fs.promises.link(s, d));
      return 'link';
    } catch (e) {
      if (e.code !== 'EXDEV' && e.code !== 'ENOSYS' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
    }
  }
  await retry(() => fs.promises.copyFile(s, d));
  return 'copy';
}

async function copyFile(src, dst) {
  await mkdirp(path.dirname(dst));
  await retry(() => fs.promises.copyFile(toLong(src), toLong(dst)));
}

/** 目录改名：网盘/预览占用会失败，重试并回传是哪一层被占用 */
async function renameDir(src, dst, onRetry) {
  return retry(() => fs.promises.rename(toLong(src), toLong(dst)), { onRetry });
}

async function moveFile(src, dst) {
  await mkdirp(path.dirname(dst));
  try {
    await retry(() => fs.promises.rename(toLong(src), toLong(dst)));
  } catch (e) {
    await retry(() => fs.promises.copyFile(toLong(src), toLong(dst)));
    await fs.promises.unlink(toLong(src)).catch(() => {});
  }
}

function isJunk(name, isDir) {
  const n = String(name).toLowerCase();
  if (isDir) return JUNK_DIR.includes(n);
  return JUNK_NAME.includes(n) || n.startsWith('~$') || n.startsWith('.');
}

function ext(name) { return path.extname(String(name)).toLowerCase(); }
function isMedia(name) { return MEDIA_EXT.includes(ext(name)); }
function isVideo(name) { return VIDEO_EXT.includes(ext(name)); }

/**
 * 报告「内容类型」列 → 'video' / 'image' / ''（认不出）。
 * 为什么需要它：一个叶子目录里可能同时有图和视频（达人两种素材都拍了），
 * 这时只能以运营在报告里标的内容类型为准；「按目录里有什么」会在这种素材上做错事。
 * 认不出时返回空串，交给调用方按目录内容推断 —— 只有「两边都有、又没标」才真的判不了。
 */
function contentKind(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s) return '';
  if (/视频|短片|video|mp4/i.test(s)) return 'video';
  if (/图文|图片|照片|image|photo/i.test(s)) return 'image';
  return '';
}

function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * 秒级、带 `T` 的时间戳：`2026-10-02T23-45-01`。
 * 用在哪：AI 内容报告的文件名（对齐上游那份 `KIDS_AI内容报告_2026-08-26T10-41-02.xlsx`）。
 * ★ 为什么不用 `stamp()`：那是**分钟**级，同一分钟内跑两个批次会撞名互相覆盖；
 *   而且文件名里要能一眼看出是哪一天哪一刻，秒级才够。
 * ★ 为什么冒号换成 `-`：Windows 文件名不许有 `:`。
 */
function stampISO(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function humanSize(b) {
  if (b == null) return '—';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/** 默认目录：Windows 落在 C:\Users\<你>\素材 这类位置 */
function defaultPaths() {
  const home = os.homedir();
  // ★ 2026-10-02：素材位置不再预设 —— 素材目录每次现场选（选择结果存 project.sourceDir），
  //   出厂不指向任何目录。这里只留「输出目录」与「隔离目录」两个真在用的默认值。
  return {
    output: path.join(home, '输出', '得物'),
    rejected: path.join(home, '素材', '_rejected')
  };
}

module.exports = {
  isWin, toLong, toDisplay, pathRisk, sameVolume, retry, isFileLockError,
  mkdirp, readdirSafe, statSafe, exists, linkOrCopy, copyFile, renameDir, moveFile,
  isJunk, ext, isMedia, isVideo, contentKind, stamp, stampISO, humanSize, defaultPaths,
  MEDIA_EXT, VIDEO_EXT
};
