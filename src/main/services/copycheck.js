'use strict';
/**
 * ⑥ 文案一致性核对 —— 生成完立刻跑，结果写进「AI 内容报告」的「文案核对」列
 *
 * 为什么必须有这一步：文案是模型看图写的，**没有人复核就发出去**。
 * 这一列要做的是「让人一眼看出哪几条要回头看」，不是替人下结论。
 *
 * 查六件事：
 *   ⓪ 报告里的货号 / 颜色有没有填 —— 空着的话「文案对不对」这件事根本无从谈起
 *   ① 货号/款号混进了标题正文 —— 「26FTW75 的细节」这种，正是「一看就是 AI 做的」的痕迹
 *   ② 本地模板（F01~F10）的套话 —— 模型写出这些说明它在套模板、没在看图
 *      （2026-10-02 用户实测反馈：「你现在都是根据货号和颜色生成的标题，一看就是 ai 做的，不真实」）
 *   ③ 颜色对不对得上：文案里写的颜色 vs 货号声明的颜色 vs 图里实取的主色
 *   ④ 标题是不是「商品描述」—— 款式特征词堆了 3 个以上就是（2026-10-03 加）
 *   ⑤ 标题里出现了拼接符号「+」—— 那只是「哪类词跟哪类词合并」的示意图，不是标题的字
 *   ⑥ 标题是不是「热词 + 单品」直接贴出来的标签串（＝用户说的「有语病」）
 *      实测反例「少年感灰针织毛衣」；正例「少年感灰针织毛衣太帅了」「军绿调穿搭夹克 松弛感拉满」
 *      （2026-10-03 第八次会话加）
 *   ⑦ 正文是不是「4~5 行短句」—— 行数 / 单行长度 / emoji 个数（2026-10-03 第九次会话加）
 *      用户拿 CABBEEN 官号的实发笔记定格式：一行一句、8~16 字、行尾少量 emoji、最后话题。
 *
 * ★ 另有一条**批级**判据不在 check() 里（单条看不到「上一条」）：见 checkBatch ——
 *   相邻两条的标题 / 正文是不是**完完全全一样**。用户 2026-10-03 拍板的口径：
 *   只看**相邻**两条、**换了 emoji 就算不同**、跨品牌复用同一句没关系。
 *
 * 判据分级（**不误杀**）：
 *   bad  —— 客观错，没什么可争的（混进货号、套话）
 *   warn —— 不一致 / 需要人看一眼（颜色对不上、超字数、没 emoji）
 *   判不了的（色名不在词表里、图取不到主色）一律写「需人工确认」，**绝不替人下结论**
 */
const colors = require('../util/colors');
// ★ 2026-10-03：⑧⑨ 两条判据要用到内置热词库（判断「哪些词是热词」）
const hotwords = require('./hotwords');

/**
 * 本地模板留下的句式。这些词单独看都不算错，**但整句就是模板的壳** ——
 * 模型看图写的时候不该产出它们（system 里也明确禁了，这里是事后复核）。
 */
const BANNED = [
  '的细节，真的顶', '谁懂啊', '被治愈', '面料会说话', '入选本周清单',
  '这个价太实在', '怎么搭都不出错', '上身效果', '细节质感', '场景代入'
];

/** 标题字数上限（品牌提示词与程序约束都是 15 字；emoji / 空格不计入） */
const TITLE_MAX = 15;
/**
 * 正文的合理区间。
 * ★★ 2026-10-03 改口径：正文从「80~100 字的一段」改成「**4~5 行短句**」
 *   （用户拿 CABBEEN 官号的实发笔记来定格式：每行一句、8~16 字、行尾少量 emoji）。
 *   4~5 行 × 8~16 字 ⇒ 全文 35~70 字 —— 旧的 60 下限会把**正常的**新格式正文全判成「太短」。
 */
const BODY_MIN = 30;
const BODY_MAX = 110;

/** 正文该写几行（用户 2026-10-03 明确要求 4~5 行） */
const BODY_LINES_MIN = 4;
const BODY_LINES_MAX = 5;
/**
 * 行数上限的**容忍值**：多写一行不标黄。
 * ★ 为什么不按 4~5 死卡：这一列的意义是「一眼看出哪几条要回头看」，
 *   6 行读起来没问题，卡死只会让整列变黄 ⇒ 全黄 = 没人看。
 *   真正要抓的是「又写成一整段」（1~3 行），那条不受容忍值影响。
 */
const BODY_LINES_SOFT_MAX = 6;
/** 单行超过这么多字 = 又写成一整段了（一行一句短句，8~16 字） */
const BODY_LINE_MAX = 26;
/** 正文 emoji 个数的上限（用户要「少量 emoji」，官号实测 1~3 个） */
const BODY_EMOJI_MAX = 4;

/** emoji / 符号 / 变体选择符 / 零宽连接符：算字数时都要排除，否则「字数」忽大忽小 */
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{FE0F}\u{200D}\u{2122}\u{00A9}\u{00AE}]/gu;

function stripEmoji(s) { return String(s == null ? '' : s).replace(EMOJI_RE, ''); }
/**
 * ★★ 2026-10-03 修一个**潜伏**的判错：`EMOJI_RE` 带 `g`，而带 `g` 的正则用 `.test()` 会推进
 *   `lastIndex` —— 同一条标题**连续判两次就会一真一假**（实测 `true false true false`；
 *   10 条真机标题都带 emoji，连判一遍报出「4 条没有 emoji」）。
 *   现在恰好没露头：`check()` 里 `hasEmoji` 前面刚调过 `textLen()`，
 *   而 `replace(带 g 的正则)` 会把 `lastIndex` 归零 —— 但这是**定时炸弹**，
 *   任何新调用点连判两次就会判错（`tools/copytest.js` 有正反两条断言钉着）。
 *   ⇒ 判「有没有」改用**不带 g 的副本**（`stripEmoji` 继续用带 g 的做替换）。
 */
const EMOJI_TEST_RE = new RegExp(EMOJI_RE.source, 'u');
function hasEmoji(s) { return EMOJI_TEST_RE.test(String(s == null ? '' : s)); }
/**
 * 数一段文字里有几个 emoji。
 * ★ **必须新起一个带 `g` 的正则**：直接拿 `EMOJI_RE.match()` 虽然按规范会把 lastIndex 归零，
 *   但同一份正则只要还有一个 `.test()` 调用点（`hasEmoji`）在别的时机跑，就会互相踩。
 *   自己 new 一个，谁也别影响谁。
 */
function emojiCount(s) {
  const m = String(s == null ? '' : s).match(new RegExp(EMOJI_RE.source, 'gu'));
  return m ? m.length : 0;
}
/** 标题/正文的「字数」= 去掉 emoji 与所有空白之后的字符数 */
function textLen(s) { return stripEmoji(s).replace(/\s+/g, '').length; }

/**
 * 色名 → 基础色系。★ 词表里没有「冠军白 / 樱花粉 / 光子灰」这类**电商叫法**，
 *   直接拿 colors.coarseOfName 会一律返回 null ⇒ 每一条都变成「只能人工看」，
 *   那一列就废了。所以先精确匹配，再退一步认它**含哪几个基础色词**（最长优先）。
 *   还是认不出（如「花灰色（加绒）」以外的怪名）才返回 null，交给人工。
 */
function coarseOf(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s) return null;
  const exact = colors.coarseOfName(s);
  if (exact) return exact;
  const words = colors.LEXICON.map(([n]) => n).filter(Boolean).sort((a, b) => b.length - a.length);
  for (const w of words) if (s.includes(w)) return colors.coarseOfName(w);
  return null;
}

/**
 * 从一段文字里找出「说到的颜色词」。
 * ★ 长词优先：先认「燕麦色」「勃艮第红」，别被同一个串里的「红」「色」抢先 ——
 *   否则「勃艮第红」会被读成「红」，颜色系判定就跟着偏。
 */
function colorWordsIn(text) {
  const s = String(text == null ? '' : text);
  const words = colors.LEXICON
    .map(([n]) => n)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const hit = [];
  for (const w of words) {
    if (s.includes(w) && !hit.some(h => h.includes(w))) hit.push(w);
  }
  return hit;
}

/**
 * 单品词。只有「颜色词紧挨着它」时，那个颜色才算**在声明这件衣服的颜色**。
 * ★ 不要把「穿搭 / 风格 / 氛围」放进来 —— 它们不是单品，
 *   否则「蓝调穿搭」会被当成在说衣服是蓝的（实测会误杀）。
 */
const GARMENTS = [
  '羽绒服', '羽绒马甲', '羽绒', '棉服', '冲锋衣', '夹克', '外套', '大衣', '风衣', '西装', '马甲',
  '卫衣', '毛衣', '针织衫', '开衫', '衬衫', 'T恤', 'polo衫', 'polo', '背心', '工装', '牛仔',
  '裤', '半裙', '裙', '套装'
];

/** 颜色词后面紧跟这几个字 = 氛围写法（「蓝调穿搭」「灰系氛围」），不算在说这件衣服的颜色 */
const COLOR_TAIL_SKIP = ['调', '系', '感'];

/**
 * 款式特征词。★ 这不是「禁词」，是**计数**用的：堆到 3 个以上，标题就变成商品描述了。
 * （2026-10-03 用户实测反馈：「你这个标题就是纯描述产品是什么，我要的是产品+热门词」，
 *   被打回的原话是「蓝灰横向绗缝立领羽绒，左胸刺绣」——正好 4 个。）
 */
const DESCRIPTORS = [
  '绗缝', '横向', '立领', '翻领', '连帽', '刺绣', '拉链', '口袋', '圆领', '包边', '走线', '五金',
  '拼接', 'logo', '印花', '字母', '条纹', '格纹', '收口', '罗纹', '加厚', '防风', '防水',
  '直筒', '阔腿', '修身', '宽松', '短款', '长款', '中长', '廓形', '版型', '克重', '绒面', '磨毛',
  '系带', '抽绳', '按扣', '纽扣', '左胸', '袖口', '下摆'
];

/** 标题里堆几个款式特征词就该提醒 */
const DESCRIPTOR_MAX = 2;

/**
 * 标题里**不该出现**的拼接符号。
 * ★★ 2026-10-03（第八次）用户原话：「我的 + 号是为了让你知道什么类型和什么类型合并，
 *   **不是让你直接加进标题里**」。`+` 只是示意图，标题必须是念得通的一句话。
 */
const PASTE_SYMBOLS = ['+', '＋', '﹢', '&', '|', '｜', '·', '•'];

/**
 * 「成句的迹象」—— 标题里出现这些，说明词与词之间是**连成话**的，不是硬贴。
 * ★ 只用来判「像不像标签串」，**不追求穷尽**：判不出来的宁可不报（不误杀）。
 *   故意不收「搭」（「简约百搭」「穿搭」里都有它，收了就漏判，不如不收）。
 */
const LINKERS = ['的', '是', '才', '就', '穿', '配', '带', '入', '在', '和', '与', '很', '超',
  '太', '真', '能', '要', '有', '会', '让', '给', '把', '自', '也', '都', '可', '好'];

/** 标点 / 分隔符也算成句的迹象（「军绿调穿搭夹克 松弛感拉满」就是靠空格断句的） */
const PASTE_SEP = /[，。、；：！？,.;:!?\s—～~·•/]/;

/** 「前缀热词」= 这些组里的词贴在标题最前面，最容易变成标签串 */
const PREFIX_GROUPS = ['风格', '氛围', '色感', '人群', '情绪', '季节', '场景'];

/**
 * 拆出来的前缀热词（`{色}` 模板留着没意义，剔掉）。
 *
 * ★★ 2026-10-03：从「模块加载期算好的常量」改成**函数**。词库现在可在「热词库」页编辑，
 *   常量只在 `require` 时算一次 ⇒ 改完词库**不重启就不生效**：标题用了用户新加的词，
 *   这里还拿旧表去判 ⇒ **误报「像标签串」或漏报**，且界面全绿。所以改成每次现取。
 * ★ 末尾那个按词长倒序的 `sort` **只为了输出稳定好排查**（调用方是 `.some()`，顺序不影响判定结果）。
 */
function prefixWords() {
  return hotwords.currentGroups()
    .filter(g => PREFIX_GROUPS.indexOf(g.key) >= 0)
    .reduce((a, g) => a.concat(g.words.filter(w => w.indexOf('{色}') < 0)), [])
    .sort((a, b) => b.length - a.length);
}

/** 太短的标题（如「学院风夹克」5 字）本来就是正常名词短语，不判标签串 */
const PASTE_MIN_LEN = 6;

/**
 * 标题是不是「热词 + 单品」直接贴出来的标签串（＝用户说的「有语病」那种）。
 *
 * ★★ 2026-10-03（第八次）用户实测：「你生成的『少年感灰针织毛衣』…
 *   如果能变成『少年感灰针织毛衣太帅了』」—— 病根就是**热词直接贴在单品前、句子没有收尾**。
 *   三条同时成立才算（宁可不报也不误杀）：
 *     ① 标题以「前缀热词」开头；
 *     ② 标题以单品词结尾；
 *     ③ 整条标题里没有任何连接字 / 标点空格（＝没有成句的迹象）。
 *   ⇒ 用户自己给的两个正例都因为 ③ 不成立而**不会**被点名（有「太」、有空格）。
 */
function looksLikeWordPaste(title) {
  const t = stripEmoji(String(title == null ? '' : title)).trim();
  if (!t) return false;
  if (textLen(t) < PASTE_MIN_LEN) return false;
  if (!prefixWords().some(w => t.startsWith(w))) return false;
  if (!GARMENTS.some(g => t.endsWith(g))) return false;
  if (LINKERS.some(c => t.includes(c))) return false;
  if (PASTE_SEP.test(t)) return false;
  return true;
}

/**
 * 从标题里找出「在声明这件衣服颜色」的颜色词。
 *
 * ★★ 2026-10-03 重写。旧实现把标题里**所有**颜色词都当成声明，
 *   新标题写法是词包（「羽绒服+灰色慵懒风」「蓝调穿搭+羽绒服」），旧判据会把
 *   「蓝调」这种**氛围词**当成「这件衣服是蓝的」，于是整列标黄。
 *   现在收紧成两条，**宁可不报也不误杀**：
 *     ① 颜色词前后 4 个字符以内必须出现**单品词**（「燕麦色圆领毛衣」算、「蓝调穿搭」不算）；
 *     ② 颜色词后面紧跟「调 / 系 / 感」的一律不算（氛围写法）。
 */
function declaredColorsIn(title) {
  const s = String(title == null ? '' : title);
  const words = colors.LEXICON.map(([n]) => n).filter(Boolean).sort((a, b) => b.length - a.length);
  const out = [];
  for (const w of words) {
    if (out.some(h => h.includes(w))) continue;
    let from = 0;
    for (;;) {
      const i = s.indexOf(w, from);
      if (i < 0) break;
      from = i + w.length;
      if (COLOR_TAIL_SKIP.includes(s.charAt(i + w.length))) continue;
      const around = s.slice(Math.max(0, i - 4), i + w.length + 4);
      if (GARMENTS.some(g => around.includes(g))) { out.push(w); break; }
    }
  }
  return out;
}

/**
 * 话题行的样式：整行只有 `#话题`（可以在一行里连着好几个）。
 * ★ 判据与 `copywriter.stripTrailingTopics` **同一套**：`#` + 汉字/字母/数字，**遇到标点就停**
 *   （写成「`#` 后面直到空白」会把「#小故事，讲给你听。」整段当成话题）。
 */
const TOPIC_LINE = /^\s*(#[^\s#，。！？、：；,.;:!?()（）\[\]【】"'“”‘’…—\-]+\s*)+$/;

/**
 * 把**文案末尾由程序追加的话题行**剔掉，只留正文。
 *
 * ★★ 为什么要这一步（2026-10-03 用户拍板「话题并进文案、一个话题一行」之后）：正文的
 *   「4~5 行 / 字数 / 单行长度 / emoji 个数」四条判据数的都是**模型写的正文**；
 *   话题是程序按计划追加的样板，一起数进去 ⇒ 每条都变成 9~10 行，**整列全黄**，
 *   这一列就没人看了（「全黄 = 没人看」见下面 BODY_LINES_SOFT_MAX 的注释）。
 * ★ 只剔**末尾**的：正文中间出现 `#` 是正常的（「这条有个 #小故事」），不许误伤。
 */
function bodyWithoutTrailingTopics(body) {
  const lines = String(body == null ? '' : body).split(/\r?\n/);
  while (lines.length && (!lines[lines.length - 1].trim() || TOPIC_LINE.test(lines[lines.length - 1]))) lines.pop();
  return lines.join('\n');
}

/**
 * 核对一条文案。
 * @param {{title:string, body:string}} row
 * @param {{goods?:Array<{sku:string,color:string}>, imageColor?:string, from?:string}} opts
 *        imageColor：图片实取主色的中文名（verify/imaging 给的），取不到就传空
 * @returns {{level:'ok'|'warn'|'bad', text:string, issues:Array}}
 */
function check(row, opts = {}) {
  const title = String((row && row.title) || '');
  const body = String((row && row.body) || '');
  const both = title + '\n' + body;
  const issues = [];
  const add = (level, text) => issues.push({ level, text });
  const goods = (opts.goods || []).filter(g => g && g.sku);

  // ⓪ 货号 / 颜色有没有填（2026-10-03 加）
  //   为什么放在最前：货号空着，这一行发布时**关联不到商品**；颜色空着，多色货号只能选到第一件。
  //   这两件事都不是「文案好不好」的问题，而是「这条根本发不了 / 发错」的问题，必须先说出来。
  if (!goods.length) add('bad', '这一条没填货号（发布时关联不到商品）');
  else if (!String(goods[0].color || '').trim()) add('warn', `货号「${goods[0].sku}」没填颜色（多色货号发布时只会选第一件商品）`);

  // ① 货号 / 款号混进文案
  const hitSku = goods.map(g => String(g.sku).trim()).filter(Boolean).filter(s => both.includes(s));
  if (hitSku.length) add('bad', `文案里出现了货号 ${hitSku.join(' / ')}（标题正文都该只有人话）`);

  // ② 模板套话
  const hitPhrase = BANNED.filter(p => both.includes(p));
  if (hitPhrase.length) add('bad', `用了模板套话「${hitPhrase.join('、')}」，像是套模板不是看图写的`);

  // ③ 标题长度 / emoji
  const tl = textLen(title);
  if (tl > TITLE_MAX) add('warn', `标题 ${tl} 字，超过 ${TITLE_MAX} 字`);
  if (title && !hasEmoji(title)) add('warn', '标题没有 emoji');
  if (!title.trim()) add('bad', '标题是空的');

  // ④ 正文长度 + **行数 / 单行长度 / emoji 个数**
  //   ★★ 2026-10-03：用户拿官号实发笔记来定正文格式 ——「4-5 行，每段简单描述卖点/氛围感/感受等
  //     + 少量 emoji，最后加入话题。每行均需换行」。所以「行数」比「字数」更能说明问题：
  //     字数够但挤成一行，发到得物就是一整段（用户投诉的正是这个）。
  // ★★ 2026-10-03：话题已并进文案末尾（一个话题一行）⇒ 这四条判据一律用**剔掉话题行**的正文，
  //   否则 4~5 行正文 + 5 行话题 = 9~10 行，整列全黄（见 bodyWithoutTrailingTopics）。
  const bodyCore = bodyWithoutTrailingTopics(body);
  const bl = textLen(bodyCore);
  const lines = bodyCore.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  if (bl && (bl < BODY_MIN || bl > BODY_MAX)) add('warn', `正文 ${bl} 字，超出 ${BODY_MIN}~${BODY_MAX} 字`);
  if (lines.length && (lines.length < BODY_LINES_MIN || lines.length > BODY_LINES_SOFT_MAX)) {
    add('warn', `正文只写了 ${lines.length} 行（要求 ${BODY_LINES_MIN}~${BODY_LINES_MAX} 行：一行一句短句，行与行之间真的换行）`);
  }
  const longest = lines.reduce((m, x) => Math.max(m, textLen(x)), 0);
  if (longest > BODY_LINE_MAX) {
    add('warn', `正文有一行 ${longest} 字，太长了（一行写一句短句，建议不超过 20 字）`);
  }
  const be = emojiCount(bodyCore);
  if (bl && !be) add('warn', '正文没有 emoji');
  else if (be > BODY_EMOJI_MAX) add('warn', `正文有 ${be} 个 emoji，偏多（建议 1~3 个，放在行尾）`);

  // ⑤ 文案里的颜色 ↔ 货号声明的颜色
  // ★ 只看**标题**里说的颜色，不看正文：正文里出现别的颜色是**正常的**
  //   （「黑色小熊刺绣」「搭一条浅蓝牛仔裤」——刺绣和裤子本来就不是这件衣服的颜色）。
  //   实测踩过：按正文全扫，一条完全正常的文案被误判成「颜色不一致」。
  //   标题才是「这件衣服是什么颜色」的声明（参考写法：燕麦色圆领毛衣 / 军绿毛领棉服）。
  const declared = goods[0] ? String(goods[0].color || '').trim() : '';
  const said = declaredColorsIn(title);
  if (declared) {
    const dc = coarseOf(declared);
    if (said.length) {
      const okOne = said.some(w => { const wc = coarseOf(w); return !dc || !wc || wc === dc; });
      if (!okOne) {
        add('warn', `标题里的颜色「${said.join('、')}」与货号声明的「${declared}」不是同一色系，需人工确认`);
      }
    }
    // ★★ 2026-10-03 **删掉**「标题里没提到颜色 ⇒ warn」这一条。
    //   新标题写法是「产品词 + 热门词」（羽绒服+简约百搭 / 冬日神器+羽绒服），
    //   大多数**好**标题本来就不带颜色 —— 留着这条会把一整列都标黄，
    //   而这一列存在的意义就是「让人一眼看出哪几条要回头看」，全黄 = 没人看。
    //   颜色不是必须出现在标题里；真正要防的是**写错颜色**，那条上面已经查了。
    if (!dc) add('warn', `声明颜色「${declared}」不在色名词表里，只能人工看`);
  }

  // ⑥ 图里实取的主色 ↔ 声明的颜色
  const ic = String(opts.imageColor || '').trim();
  if (ic && declared) {
    const dc = coarseOf(declared);
    const icc = coarseOf(ic);
    if (dc && icc && dc !== icc) {
      add('warn', `图里实取主色「${ic}」与声明颜色「${declared}」不是同一色系，需人工确认`);
    }
  }

  // ⑦ 标题是不是「商品描述」而不是「产品词 + 热词」（2026-10-03 加）
  //   为什么不直接查「有没有热词」：模型会自己造词（「松弛感」「少年感」…），
  //   拿内置词库去比对必然误杀。这里只数一个**客观**的东西 —— 款式特征词堆了几个。
  const dHit = DESCRIPTORS.filter(d => title.includes(d));
  if (dHit.length > DESCRIPTOR_MAX) {
    add('warn', `标题堆了 ${dHit.length} 个款式特征（${dHit.join('、')}），像商品描述；`
      + '建议改成「产品词 + 热门词」的写法，例如「简约百搭的羽绒服」「冬日神器羽绒服，过冬就靠它」');
  }

  // ⑧ 标题里出现了拼接符号「+」（2026-10-03 第八次加）
  //   用户原话：「我的 + 号是为了让你知道什么类型和什么类型合并，不是让你直接加进标题里」。
  const sym = PASTE_SYMBOLS.filter(s2 => title.includes(s2));
  if (sym.length) {
    add('warn', `标题里出现了拼接符号「${sym.join('、')}」—— 那只是「哪类词跟哪类词合并」的示意图，`
      + '标题要写成一句念得通的话（带连接字或收尾）');
  }

  // ⑨ 标题像是「热词 + 单品」直接贴出来的标签串（＝用户说的「有语病」）（2026-10-03 第八次加）
  //   ★ 这是**启发式**，只求「抓住用户实测那类」，判不出来的不报（不误杀）。
  if (looksLikeWordPaste(title)) {
    add('warn', '标题像是把热词直接贴在单品上的标签串（如「少年感灰针织毛衣」），读着有语病；'
      + '建议补一个收尾（「太帅了」「松弛感拉满」）或连接字（的 / 才是 / 穿出）');
  }

  const level = issues.some(i => i.level === 'bad') ? 'bad'
    : (issues.length ? 'warn' : 'ok');
  const text = issues.length ? issues.map(i => i.text).join('；') : '一致';
  return { level, text, issues };
}

/**
 * 批级判据：**相邻两条**的标题 / 正文是不是完完全全一样。
 *
 * ★★ 用户 2026-10-03 拍板的口径（原话）：
 *   「品牌 a 用了『abcde 文字 + x emoji』这个标题，品牌 b 也允许用同一个；
 *     品牌 a 后续也允许『abcde 文字 + y emoji』。同一品牌下，只要 emoji 有不同，
 *     文字完全相同也不要紧，**只要不要连续 2 条内容文字完全一致即可**。文案也一个道理。」
 *   ⇒ 三条结论，别做过头：
 *     ① **只比相邻两条** —— 隔了几条之后再出现同样的句子，允许；
 *     ② 比的是**原文（含 emoji）** —— 换了 emoji 就算不同，不报；
 *     ③ **跨品牌**根本不用比：一次生成只在一个品牌下，天然满足。
 * ★ 旧口径「整批不许重复」在这里**被放宽**了：以前那样会把「第 1 条和第 9 条撞句」也标出来，
 *   而用户明确说那没问题。
 *
 * @param {Array<{title?:string, body?:string}>} rows 按发布顺序排好的行
 * @returns {Array<string[]>} 与 rows 等长；第 i 项 = 这一条要多提示的句子（通常是空的）
 */
function checkBatch(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const same = (x, y) => {
    const a = String(x == null ? '' : x).trim();
    const b = String(y == null ? '' : y).trim();
    return !!a && a === b;
  };
  // ★★ 2026-10-03：正文末尾那几行话题是**程序按计划追加的、每条都不一样** ⇒ 必须剔掉再比。
  //   不剔的话「两条正文一模一样、只是话题组合不同」会被判成「不同」，这条判据就**静默失效**了
  //   （实测：copytest ⑤b 当场变红 —— 那才是对的，是代码该改，不是断言该改）。
  const coreBody = r => bodyWithoutTrailingTopics((r || {}).body);
  return list.map((cur, i) => {
    const out = [];
    if (i === 0) return out;
    const prev = list[i - 1] || {};
    if (same(prev.title, cur && cur.title)) {
      out.push('标题与上一条一字不差（换一个 emoji 或换一句就行；连续两条完全一样容易被平台判重复内容）');
    }
    if (same(coreBody(prev), coreBody(cur))) {
      out.push('正文与上一条一字不差（同上：换个 emoji 或换一句话）');
    }
    return out;
  });
}

module.exports = {
  check, checkBatch, colorWordsIn, declaredColorsIn, textLen, hasEmoji, stripEmoji, emojiCount,
  bodyWithoutTrailingTopics,
  BANNED, GARMENTS, DESCRIPTORS, DESCRIPTOR_MAX, COLOR_TAIL_SKIP,
  PASTE_SYMBOLS, LINKERS, prefixWords, PASTE_MIN_LEN, looksLikeWordPaste,
  TITLE_MAX, BODY_MIN, BODY_MAX,
  BODY_LINES_MIN, BODY_LINES_MAX, BODY_LINES_SOFT_MAX, BODY_LINE_MAX, BODY_EMOJI_MAX
};
