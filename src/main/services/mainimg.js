'use strict';
/**
 * 主图挑选（**纯逻辑，不碰设备、不碰文件** —— 所以能直接喂输入单测）
 *
 * 背景（2026-10-05 真机定论，全部可复算）：
 *   · 得物发图文时**取相册第 1 格作内容主图**（用户口径）；
 *   · 而相册第 1 格 = 设备上文件时间（MediaStore `date_modified`）**最新的那张**——
 *     4 张纯色图把「文件名顺序 / 推送顺序 / 文件时间」三个键**故意做成互相矛盾**，
 *     相册第一屏顺序只与文件时间倒序吻合；只改时间不重扫库顺序不动；改完时间再扫库顺序立刻跟着变。
 *   · ⇒ 「哪张当主图」= 「让哪张的时间最新」，由 publisher 在设备端落实（见 adb.makeNewest）。
 *
 * 本模块只回答一个问题：**这一组图里该挑哪张当主图**。
 *
 * ★ 为什么默认挑「第 1 张」而不是「最后一张」：
 *   现在的实际行为就是「最后拍的那张当主图」（相册时间倒序、最新的排第 1 格），
 *   而用户真实素材是**正面先拍、背面后拍** ⇒ 主图老是背面图（用户报的原话：
 *   「不然老是放一些人物的背面图在主图上」）。用他的素材实测 3 个叶子：
 *   `S26408002+黑色` 第 1 张=正面全身 / 最后一张=背面侧转；`D26187013+蓝色` 第 1 张=正面 / 最后一张=纯背面；
 *   `S26393005+咖色` 第 1 张=侧脸正面 / 最后一张=侧面站姿 ⇒ **「第 1 张」3/3 都合格**。
 *   （文件名里的时间戳与拍摄顺序同序，readdir 出来的顺序就是时间升序 ⇒ 「第 1 张」= 最早拍/最早收到的那张。）
 *
 * ★ 命名标记：**名字以 `1` 开头**就指定它当主图（用户拍板「标记用数字1」）。
 *   · `1_微信图片_2026-10-05_031033_240.jpg` / `1封面.jpg` / `1.jpg` 都算；
 *   · **`10.jpg` / `12.jpg` 不算** —— 用负向断言 `(?![0-9])` 把「数字编号」排除掉，
 *     否则一个用 1..N 编号的叶子会把 `10` 也当成标记（真按编号命名时那是第 10 张，不是主图）。
 *   · 只在**开头**认：`微信图片_1.jpg` 里的 `1` 是名字的一部分，不算标记。
 *   ⇒ 用户一次只动一个叶子的一张图（1000 张图 × 每叶子 4~6 张，只有出问题的叶子才需要动手）。
 *
 * ★ 多个都带标记时：取**排在最前的那个**，并把 `why` 标成 `marker-many` ——
 *   调用方据此提醒用户「这个叶子里有 N 个都带 1」，但不能因此不发（宁可发一条好主图的帖子）。
 */

/** 名字以 `1` 开头、且 `1` 后面**不是数字** ⇒ 视为「主图标记」。 */
const MAIN_MARK = /^1(?![0-9])/;

/** 这个文件名带主图标记吗（会自动 trim 首尾空白）。 */
function isMainMarked(name) {
  return MAIN_MARK.test(String(name == null ? '' : name).trim());
}

/** publisher 挑主图时用的口径 —— 必须与它 filter 出来的图片清单一致（否则下标会错位）。 */
function isImageFile(f) {
  return !!(f && f.type === 'image' && f.name);
}

/**
 * 从一条素材的文件清单里挑主图。
 *
 * @param {Array<{name:string,type:string}>} files 一个叶子的文件清单（含图片以外的类型，本函数只认图片）
 * @returns {{ main: object|null, why: 'only'|'marker'|'marker-many'|'first'|'none', marked: string[], index: number, count: number }}
 *   `index` 是**图片清单内**的下标（调用方按同一个 predicate 过滤后用它取远端路径）；
 *   `count` 是图片张数；一张图片都没有时 `main=null`、`why='none'`。
 */
function pickMainImage(files) {
  const imgs = (Array.isArray(files) ? files : []).filter(isImageFile);
  if (!imgs.length) return { main: null, why: 'none', marked: [], index: -1, count: 0 };
  if (imgs.length === 1) return { main: imgs[0], why: 'only', marked: [], index: 0, count: 1 };
  const marked = imgs.filter(f => isMainMarked(f.name));
  if (marked.length === 1) {
    return { main: marked[0], why: 'marker', marked: marked.map(f => f.name), index: imgs.indexOf(marked[0]), count: imgs.length };
  }
  if (marked.length > 1) {
    return { main: marked[0], why: 'marker-many', marked: marked.map(f => f.name), index: imgs.indexOf(marked[0]), count: imgs.length };
  }
  return { main: imgs[0], why: 'first', marked: [], index: 0, count: imgs.length };
}

/** 给界面/日志用的一句话（不参与判定，改文案不会影响行为）。 */
function whyText(pick) {
  if (!pick || !pick.main) return '没有可用的图片';
  switch (pick.why) {
    case 'only': return '只有这一张图';
    case 'marker': return '名字以 1 开头（你指定的主图）';
    case 'marker-many': return `有 ${pick.marked.length} 张图名字都以 1 开头（${pick.marked.join('、')}），取了排在最前的那张`;
    case 'first': return '没有 1 标记，按第 1 张（最先拍到/收到的那张）';
    default: return String(pick.why);
  }
}

module.exports = { MAIN_MARK, isMainMarked, isImageFile, pickMainImage, whyText };
