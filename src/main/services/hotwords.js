'use strict';
const store = require('../store');   // 用户版词库存 config.json（copy.hotwords）；本文件持有出厂基线
/**
 * 标题「产品词 × 热门词」用的内置词包。
 *
 * ★★ 2026-10-03（第七次会话）：用户拿真机生成的标题来投诉 ——
 *   「你这个标题就是纯描述产品是什么，我要的是产品+热门词」，
 *   并给了 6 个目标样例：
 *     羽绒服+简约百搭 / 羽绒服+韩系氛围感 / 羽绒服+灰色慵懒风 /
 *     羽绒服+美式学院风 / 蓝调穿搭+羽绒服 / 冬日神器+羽绒服
 *
 *   查出来的根因不在模型，在**我们的提示词**：
 *   `buildSystem` 上一轮把标题写成「品类 + 看得见的款式特征 + 颜色 + 风格或场景词」，
 *   模型老实地照做了 —— 于是出来的是「蓝灰横向绗缝立领羽绒，左胸刺绣🐻」这种**商品描述**。
 *   而品牌提示词里那句「格式参考以下 10 种多样化格式创作」，
 *   **后面那 10 种格式的清单是空的**（用户原文里这一段是张图，纯文本没带过来），
 *   模型没有任何可照抄的形状。
 *
 *   所以这里补两件事：
 *     ① **热词库**（按角色分组）—— 让模型有具体的词可挑，而不是自己编；
 *     ② **15 种标题句式骨架**（T01~T15）—— 每行轮换一种，整批不会一个格式。
 *   注意 T01~T06 与用户给的 6 个样例**一一对应**，这不是巧合：那 6 个样例本身就是
 *   6 种不同的「角色 × 语序」组合，补齐成 10 种即可覆盖「禁止单一格式重复」。
 *   ⚠️ **第八次之后这条「一一对应」已不成立**（下面是第七次的实况，别当现状读）：
 *      `STYLES` 从「词包格式」重写成「句式骨架」时整表重排过，那 6 个样例现在散在别的编号上
 *      （例：「羽绒服+简约百搭」＝现在的 T03、「冬日神器+羽绒服」＝T06），
 *      条数也不再是 10 —— 2026-10-05 已加到 **15 条（T01~T15）**。以 `STYLES` 本尊为准。
 *
 * ★ 边界（不许越过）：热词只许是**风格 / 氛围 / 场景 / 人群 / 季节 / 情绪 / 收尾**类。
 *   **材质与参数类**（鹅绒、充绒量、加厚、防风防水、羊毛含量……）不进来 ——
 *   那些是「这件衣服的客观事实」，必须图里看得见或货号有写，热词库里给不了，
 *   让模型自己编就等于造假。
 *
 * ★★ 2026-10-03（第八次会话）：用户又打回两条 ——
 *   「我的 + 号是为了让你知道什么类型和什么类型合并，不是让你直接加进标题里，
 *     而且目前你的标题有明显的语病，如你生成的『少年感灰针织毛衣』，
 *     如果能变成『少年感灰针织毛衣太帅了』+ emoji；
 *     或者你上次的『军绿调穿搭夹克』，如果能变成『军绿调穿搭夹克 松弛感拉满』」。
 *
 *   两个硬结论（这一版就是照这两条改的）：
 *     ① **`+` 只是「哪类词跟哪类词能合并」的示意图**，不是要写进标题 ——
 *        标题里**一个字都不许出现 `+`**（`copycheck` 事后还会再查一遍）。
 *     ② 词包**直贴**会出病句（`少年感` 贴 `灰针织毛衣` = 一串标签、没有收尾）。
 *        标题必须是一句**念得通的话**：要么带**连接字**（的 / 才是 / 穿出 / 就穿 / 自带），
 *        要么带**收尾**（太帅了 / 松弛感拉满 / 一眼心动）。
 *
 *   ⇒ 于是 `STYLES` 从「词包公式」改成「**句式骨架**」：每条骨架自带连接字或收尾，
 *     结构上就不再产出 `少年感灰针织毛衣` 这种句子。
 */

/** 热词库：按「在标题里扮演什么角色」分组。`{色}` 由本行的颜色代入。 */
const GROUPS = [
  {
    key: '风格',
    words: ['简约百搭', '极简通勤', '基础款王者', '老钱风', '静奢感', '轻奢质感',
      '美式学院风', '学院风', '街头感', '机能风', '日系治愈', 'clean fit']
  },
  {
    key: '氛围',
    words: ['韩系氛围感', '氛围感拉满', '松弛感', '慵懒风', '清冷感', '高级感', '温柔感', '不费力的高级']
  },
  {
    key: '色感',
    // ★ 带 `{色}` 的模板：用**本行的颜色**去套，不是让模型编颜色
    words: ['{色}调穿搭', '{色}调高级感', '{色}系氛围感', '{色}调同色系', '{色}系慵懒风', '{色}调', '{色}系']
  },
  {
    key: '场景',
    words: ['通勤', '约会出街', '周末出街', '校园', '旅行', '居家', '上班通勤']
  },
  {
    key: '人群',
    words: ['少年感', '韩剧男主感', '减龄穿搭', '不挑人', '大男孩感', '学生党']
  },
  {
    key: '季节',
    words: ['冬日神器', '过冬必备', '换季刚需', '保暖担当', '冬天就靠它', '入冬第一件']
  },
  {
    key: '情绪',
    words: ['一眼心动', '治愈系', '情绪价值拉满', '被戳中了', '温柔暴击', '心情都变好了']
  },
  {
    // ★ 2026-10-03 新增：「收尾」组 —— 用户说的『太帅了』就属于这里。
    //   词包直贴之所以像病句，就是因为它**没有收尾**：句子有个结尾才像人说的话。
    key: '收尾',
    words: ['太帅了', '闭眼入', '谁穿谁帅', '真的绝了', '稳了', '不出错', '很能打',
      '安排上', '直接封神', '质感在线', '好看到犯规', '很难不爱']
  }
];

/**
 * 标题**句式骨架**（15 种，T01~T15；上一版是「词包公式」，会被模型原样输出成 `A+B` 的病句）。
 *
 * ★★ 每条骨架都必须自带「连接字」或「收尾」—— 这是**结构上的防病句**：
 *   只要模型照着骨架填，产出的就一定是念得通的一句话，而不是一串标签。
 *
 * `sample` 只是**形状示例**，两条铁律（`tools/copytest.js` 有断言钉着）：
 *   ① **不许出现 `+`**（`+` 只是「哪类词跟哪类词合并」的示意，不是标题的字）；
 *   ② **不许写死颜色 / 单品** —— 颜色位一律 `{色}` 占位（写死了模型会照抄，
 *      实测踩过：示例写「灰」，跑一条酒红的货，模型输出「羽绒服+灰调高级感」）。
 */
const STYLES = [
  { code: 'T01', name: '人群感+单品+夸一句', formula: '「人群」组词打头 + 单品（颜色+品类）+ 一句「收尾」', sample: '少年感{色}针织毛衣太帅了' },
  { code: 'T02', name: '单品+氛围短语', formula: '单品 + 空格 + 「氛围」组短语', sample: '{色}调夹克 松弛感拉满' },
  { code: 'T03', name: '风格词+的+单品', formula: '「风格」组词 + 「的」 + 单品', sample: '简约百搭的羽绒服' },
  { code: 'T04', name: '单品+穿出+风格', formula: '单品 + 「穿出」 + 「风格」组词', sample: '{色}毛衣穿出老钱风' },
  { code: 'T05', name: '场景+就穿+单品', formula: '「场景」组词 + 「就穿」 + 单品', sample: '通勤就穿{色}夹克' },
  { code: 'T06', name: '季节词+单品+收尾', formula: '「季节」组词 + 单品 + 「，」 + 短收尾', sample: '冬日神器羽绒服，过冬就靠它' },
  { code: 'T07', name: '单品+，+情绪词', formula: '单品 + 「，」 + 「情绪」组词', sample: '{色}夹克，一眼心动' },
  { code: 'T08', name: '色感词+单品+收尾', formula: '用本行颜色套出的「色感」词 + 单品 + 「，」 + 短收尾', sample: '{色}调穿搭夹克，高级感拉满' },
  { code: 'T09', name: '单品+才是+场景+的答案', formula: '单品 + 「才是」 + 「季节 / 场景」组词 + 「的答案」', sample: '羽绒服才是过冬的答案' },
  { code: 'T10', name: '单品+自带+人群感', formula: '单品 + 「自带」 + 「人群」组词', sample: '{色}羽绒服自带少年感' },
  // ★ 2026-10-05（第十X次）：用户给了 4 条**实发标题**当形状，按同一套闸门收成 T11~T14。
  //   两条新规矩，都在这 4 条上第一次出现：
  //   ① **T11 / T13 / T14 故意不带单品**（4 条里 3 条）—— 标题从「必须说清这是什么衣服」
  //      松成「可以只写穿搭感 / 氛围感」。为此 `copywriter.buildSystem` 里补了一句「遇到不带单品的
  //      句式别硬塞单品」（不改那句，模型会把系统提示词里「标题 = 单品 + 颜色 + 热门词」当铁律，
  //      硬塞回一件夹克）。
  //   ② 「XX系」成了形状词（miu系 / {色}系）。★ 这 4 条都靠「穿」字过 ⑨ 标签串判据，
  //      所以**没有**把「系」加进 `copycheck.LINKERS`（加了会把 ⑨ 放松，得不偿失）；
  //      将来若出现**只靠「系」**（不带「穿」）的骨架，必须同步补 `LINKERS`，否则会被误判成病句。
  //   ★ 长度：T12 的示例**正好 15 字＝`TITLE_MAX`**，填真值时没有余量（多一个颜色词就 16 字 warn）；
  //     T13 的原始句子 24 字（超限）⇒ 这里用的是**裁短版**（13 字），形状没变。
  //   ★ 口径：`miu系` 是用户 2026-10-05 明确确认要保留的写法（原稿误写成 `mid`）。红线的三条
  //     （材质/极限/别的平台名）**都不拦品牌名**，这一条留待用户自己决定要不要收。
  { code: 'T11', name: '抽象感词+系+叠穿', formula: '「风格 / 情绪」组的抽象感词 + 「系」 + 「叠穿」（**不带单品**，走穿搭感）', sample: '高智感miu系叠穿' },
  { code: 'T12', name: '这件+单品+，+质感+情绪收尾', formula: '「这件」+ 单品（款式+品类）+ 「，」+ 质感短句 + 「情绪」组收尾', sample: '这件麻花毛衣，软糯质感一眼心动' },
  { code: 'T13', name: '人群感+，+叠穿+氛围收尾', formula: '「人群」组词 + 「，」+ 「叠穿」+ 「氛围」组收尾（**不带单品**）', sample: '软糯少女感，叠穿氛围感拉满' },
  { code: 'T14', name: '色系+穿搭+上线', formula: '「{色}系」（本行颜色代入）+ 「穿搭」+ 「上线」（**不带单品**，走穿搭感）', sample: '温柔{色}系穿搭上线' },
  // ★ 2026-10-05（同一批）：用户再补一条**实发标题**（得物 App 笔记截图 `韩系叠穿💙💙蓝色好有少年感`）当形状，收成 T15。
  //   两条只属于它的新规矩：
  //   ① **emoji 成对、且颜色=本行颜色** —— 这是第一条把 emoji 当**语义**用的骨架
  //      （T01~T14 的 emoji 只是行尾装饰、不带信息）。映射表写在 `promptBlock()` 里
  //      （黑🖤 白🤍 红❤️ 橙🧡 黄💛 绿💚 蓝💙 紫💜 棕🤎；圆圈 ⚫⚪🔴🟠🟡🟢🔵🟣🟤 同理）。
  //   ② **灰 / 浅灰 没有对应的灰色 emoji**（🩶 是 Unicode 15、2022 年才加，老机型会显示成豆腐块）
  //      ⇒ 提示词里写明「颜色是灰 / 浅灰时别用这条，退回 T13」。
  //   ★ 示例写 `{色}系` 而**不是**用户原文的「蓝色」：`{色}` 是**模型自由代入**的
  //     （`copywriter` 把示例整条丢给模型，程序不做替换），而本行颜色名本身可能已带「色」字
  //     （实测用户数据里有「冠军白 / 樱花粉 / 花灰色（加绒）」）⇒ 写 `{色}色` 会出「蓝色色」这种病句。
  //   ★ 长度 13 字（emoji 不计字数，见 `copycheck.textLen`）。
  { code: 'T15', name: '风格系叠穿+双同色emoji+色感收尾', formula: '「风格」组词 + 「系叠穿」+ **两个同色 emoji（爱心或圆圈，颜色必须=本行颜色）** + 「{色}系好有」+「人群」组词（**不带单品**）', sample: '韩系叠穿💙💙{色}系好有少年感' }
];

/** 第 i 行该用哪种标题句式（固定按序轮换，走完 15 种后从头开始） */
function styleOf(i) {
  const n = Number(i) || 0;
  return STYLES[((n % STYLES.length) + STYLES.length) % STYLES.length];
}

/* ============================ 可编辑词库 ============================
 * ★★ 2026-10-03（用户拍板开工）：「热词库」单开一屏，能增删改、能恢复内置。
 *
 * 三层，各有各的边界，**别混**：
 *   ① `GROUPS`（上面）＝**出厂基线**。本文件是它的**唯一**来源；`config.json` 里没存过就永远用它。
 *      ⇒ 于是「恢复内置」＝把 `copy.hotwords` 置回 `null`，不需要再抄一份内置词到别处。
 *   ② `copy.hotwords` ＝**用户版**，只存**可编辑组**。读的时候**按组名合并**：
 *      某组在用户版里有 ⇒ 用用户版；没有 ⇒ 用基线。这样以后代码里加组 / 改组，老数据也不会错位。
 *   ③ `STYLES`（T01~T15 句式骨架）＝**语法**，任何情况下**不可编辑**（改坏会直接产出病句，
 *      而判据只能事后告警、拦不住）。
 *
 * ★★ 读法必须是**函数**（`currentGroups()` / `allWords()`）而不是常量 —— 常量在 `require` 时只算一次，
 *    界面改完**不重启就不生效**，而界面看起来一切正常 ⇒ 这种「改了没反应」最难查。
 * ★★ 「收尾」组这一版**锁定**（用户 2026-10-03：先不放开编辑）—— 它仍参与生成（词照给），
 *    只是不出现在编辑界面里。
 */

/** 界面上可编辑的组（顺序即界面顺序） */
const EDITABLE_GROUPS = ['风格', '氛围', '色感', '场景', '人群', '季节', '情绪'];

/** 锁定的组：参与生成，但不给编辑 */
const LOCKED_GROUPS = ['收尾'];

/** 红线 1：材质 / 参数类 —— 这是「这件衣服的客观事实」，必须图里看得见或货号有写，词库给不了 */
const FORBIDDEN_SPEC_RE = /鹅绒|鸭绒|充绒|含绒量|克重|加厚|防风|防水|羊毛|羊绒|德绒|石墨烯|摇粒绒|白鸭绒|质检|含量|参数|纯棉|全棉|真丝|冰丝|莱赛尔|莫代尔/;

/**
 * 红线 2：极限词（广告法不让写）；与 copywriter 的 system 提示词同一口径。
 * ★ 别写成 `/第一/` —— 实测会把内置词「入冬第一件」拦下来（它是「入冬的第一件外套」，不是极限表达）。
 *   红线必须**先放过自己的基线**，所以这里只拦真正带断言性的说法，
 *   并且有 `baselineViolations()` 做常驻自检（基线一踩红线，测试就红）。
 */
const FORBIDDEN_AD_RE = /最|顶级|极致|国家级|世界级|绝对|唯一|百分百|100%|第一名|全网第一|销量第一|第一品牌|首屈一指|史上|空前|绝无仅有/;

/** 红线 3：别的平台名 */
const FORBIDDEN_PLATFORM_RE = /淘宝|天猫|京东|拼多多|抖音|快手|小红书|唯品会|得物/;

/** 三条红线的人话说明（界面与告警共用一份，别在渲染层再抄一遍） */
const REDLINES = [
  '材质 / 参数词不许进（鹅绒、充绒量、加厚、防风防水…）—— 那是这件衣服的客观事实，必须图里看得见或货号有写，词库给不了，写出来等于造假',
  '极限词、别的平台名不许进（最 / 第一 / 顶级 / 淘宝 / 抖音…）',
  '{色} 是占位符，留着它这组词才会跟着**本行给的颜色**走；删光就写死颜色了'
];

/** 用户版（`config.json` 的 `copy.hotwords`）；没存过 / 结构不对 ⇒ 返回 null（＝用基线） */
function savedGroups() {
  try {
    const v = store.get('copy.hotwords');
    return (v && Array.isArray(v.groups)) ? v.groups : null;
  } catch (e) { return null; }   // 读不到就当没改过，绝不让生成因它报错
}

/** 当前生效的词库（用户版 ∪ 基线，按组名合并；锁定组永远取基线）。**每次现取** */
function currentGroups() {
  const saved = savedGroups();
  const byKey = {};
  if (saved) for (const g of saved) if (g && g.key) byKey[String(g.key)] = g;
  return GROUPS.map(bg => {
    if (LOCKED_GROUPS.indexOf(bg.key) >= 0) {
      return { key: bg.key, words: bg.words.slice(), locked: true };
    }
    const sg = byKey[bg.key];
    if (sg && Array.isArray(sg.words)) {
      return { key: bg.key, words: sg.words.map(w => String(w)).slice(), locked: false };
    }
    return { key: bg.key, words: bg.words.slice(), locked: false };
  });
}

/** 当前全部热词（`{色}` 模板原样保留）。★ 函数，不是常量 —— 见文件头 */
function allWords() {
  return currentGroups().reduce((a, g) => a.concat(g.words), []);
}

/** 用户版是否**真的**与基线不同（只是存过一份一模一样的副本 ⇒ 不算改过，界面不该显示「已修改」） */
function isCustom() {
  const saved = savedGroups();
  if (!saved) return false;
  const map = {};
  for (const g of saved) if (g && g.key) map[String(g.key)] = g.words;
  return EDITABLE_GROUPS.some(k => {
    const b = GROUPS.find(x => x.key === k);
    const u = map[k];
    if (!b) return false;
    if (!Array.isArray(u)) return true;
    const bu = b.words;
    return u.length !== bu.length || bu.some((w, i) => w !== String(u[i]));
  });
}

/**
 * ★★ 常驻自检：**出厂基线里不许有任何一个词踩自己的红线**。
 *   （实测踩过：红线 2 原本写成 `/第一/`，把内置词「入冬第一件」拦了 —— 于是用户一进界面
 *    什么都没改，先在预检里收到一条「极限词」告警。红线与基线必须互相自洽。）
 */
function baselineViolations() {
  return sanitizeWords(GROUPS.reduce((a, g) => a.concat(g.words), [])).rejected;
}

/** 逐词过三条红线 + 去重；返回 `{words, rejected:[{word,why}]}` */
function sanitizeWords(words) {
  const out = [], rejected = [], seen = {};
  for (const raw of (words || [])) {
    const w = String(raw == null ? '' : raw).trim();
    if (!w) continue;
    if (w.length > 24) { rejected.push({ word: w, why: '太长（超过 24 字，标题装不下）' }); continue; }
    if (/[\r\n]/.test(w)) { rejected.push({ word: w.replace(/[\r\n]/g, ' '), why: '不许带换行' }); continue; }
    if (FORBIDDEN_SPEC_RE.test(w)) { rejected.push({ word: w, why: '材质 / 参数词（红线 1）' }); continue; }
    if (FORBIDDEN_AD_RE.test(w)) { rejected.push({ word: w, why: '极限词（红线 2）' }); continue; }
    if (FORBIDDEN_PLATFORM_RE.test(w)) { rejected.push({ word: w, why: '别的平台名（红线 3）' }); continue; }
    if (seen[w]) continue;
    seen[w] = 1;
    out.push(w);
  }
  return { words: out, rejected };
}

/**
 * 校验一份「用户版词库」提交（界面点保存 / 加词预检都走这里）。
 * 入参 `[{key, words:[...]}, ...]`；返回 `{groups, rejected, warnings}`。
 * ★ `groups` 里**只含可编辑组** —— 锁定组（收尾）与 T01~T15 骨架**绝不落盘**，
 *   这样将来解锁 / 改骨架都不会被老数据顶住。
 */
function sanitizeLibrary(input) {
  const rejected = [], warnings = [], groups = [];
  const arr = Array.isArray(input) ? input : ((input && Array.isArray(input.groups)) ? input.groups : []);
  const byKey = {};
  for (const g of arr) if (g && g.key) byKey[String(g.key)] = g;
  for (const key of EDITABLE_GROUPS) {
    const src = byKey[key];
    // ★★ 缺失 ⇒ **沿用基线**（不是清空）——渲染层少传一个组不该把那组词悄悄清掉；
    //   真要清空，得显式传 `words: []`（那时才给告警）。
    const base = GROUPS.find(g => g.key === key);
    const r = src ? sanitizeWords(src.words) : { words: (base ? base.words.slice() : []), rejected: [] };
    for (const x of r.rejected) rejected.push({ group: key, word: x.word, why: x.why });
    if (!r.words.length) warnings.push(`「${key}」组是空的 —— 这一组将不给模型任何词`);
    if (key === '色感' && r.words.length && !r.words.some(w => w.indexOf('{色}') >= 0)) {
      warnings.push('「色感」组里已经没有 {色} 占位词 —— 颜色不会再跟着本行颜色走（会写死）');
    }
    groups.push({ key, words: r.words });
  }
  return { groups, rejected, warnings };
}

/** 保存用户版（只落可编辑组）。`dryRun` 只校验不写盘（界面「加一个词」的预检用） */
function saveLibrary(input, opts) {
  const r = sanitizeLibrary(input);
  const dry = !!(opts && opts.dryRun);
  if (!dry) { store.set({ copy: { hotwords: { groups: r.groups, updatedAt: new Date().toISOString() } } }); }
  return { ok: true, dryRun: dry, rejected: r.rejected, warnings: r.warnings, library: libraryView() };
}

/** 恢复内置：置回 null（不需要把内置词抄一遍） */
function resetLibrary() {
  store.set({ copy: { hotwords: null } });
  return { ok: true, library: libraryView() };
}

/** 给界面用的一次性快照（含只读的骨架与红线文案，避免渲染层再抄一份） */
function libraryView() {
  const saved = store.get('copy.hotwords');
  return {
    ok: true,
    groups: currentGroups(),
    baseline: GROUPS.map(g => ({ key: g.key, words: g.words.slice(), locked: LOCKED_GROUPS.indexOf(g.key) >= 0 })),
    editable: EDITABLE_GROUPS.slice(),
    locked: LOCKED_GROUPS.slice(),
    styles: STYLES.map(s => ({ code: s.code, name: s.name, formula: s.formula, sample: s.sample })),
    redlines: REDLINES.slice(),
    isCustom: isCustom(),
    updatedAt: (saved && saved.updatedAt) || '',
    wordTotal: allWords().length
  };
}

/** 热词库 + 句式清单，拼进 system 用。 */
function promptBlock() {
  // ★★ 2026-10-03：改读 `currentGroups()`（每次现取）—— 词库现在可在「热词库」页编辑，
  //    继续读常量 `GROUPS` 会让界面上改的内容**永远不生效**，而且不报错、最难查。
  const lib = currentGroups().map(g => `· ${g.key}：${g.words.join(' / ')}`).join('\n');
  const styles = STYLES.map(s => `${s.code} ${s.name} —— ${s.formula}（形状示例：${s.sample}）`).join('\n');
  return `【标题热词库】按「角色」分好组了，挑一个本行用得上的：
${lib}
（带 {色} 的词用**本行给的颜色**去套，比如颜色是「灰」⇒「灰调穿搭」；不许自己编颜色。）

【15 种标题句式】user 里会告诉你这一行用哪一种，整批轮换着来，**禁止整批一个格式**：
${styles}

★ 其中 T11 / T13 / T14 / T15 **故意不带单品**（只写穿搭感 / 氛围感）——
  轮到这四条时，**别硬塞一件单品进去**，否则整批又变成千篇一律的「XX 夹克」。

★ 轮到 **T15** 时，那两个 emoji（爱心或圆圈）**颜色必须等于本行的颜色**，不许随手挑一个：
  黑→🖤/⚫  白→🤍/⚪  红→❤️/🔴  橙→🧡/🟠  黄→💛/🟡  绿→💚/🟢  蓝→💙/🔵  紫→💜/🟣  棕（含卡其 / 驼 / 米 / 燕麦）→🤎/🟤
  ★ 本行颜色是**灰 / 浅灰**时**没有**对应的灰色 emoji（灰色的心是 2022 年才进系统的，老手机显示成方块）
    ⇒ 这一行**别用 T15**，改用 T13 那种写法（不加 emoji 对）。
  ★ 其余句式照旧只放 1 个 emoji、放在结尾；**只有 T15 是两个、夹在句子中间**。

★★ 两条硬规矩（上一版就是栽在这里被打回的）：
1. 上面示例里的 **「+」只是「哪类词跟哪类词合并」的示意**，**标题里一个字都不许出现「+」**。
   要写成**一句念得通的话** —— 带连接字（的 / 才是 / 穿出 / 就穿 / 自带）或带收尾（太帅了 / 松弛感拉满 / 一眼心动）。
   反例（上一版被打回的）：「少年感灰针织毛衣」—— 两个词直接贴在一起，像一串标签，读着有语病。
   正例：「少年感灰针织毛衣太帅了」/「军绿调穿搭夹克 松弛感拉满」。
2. 示例里的单品与颜色都只是**占位**：单品要用你**图里真正看到**的那件，
   **颜色也要换成本行的颜色** —— 本行颜色「酒红」就写「酒红调慵懒风」，不许照抄示例里的「灰」/「蓝」。`;
}

module.exports = {
  // 出厂基线 + 骨架（骨架不可编辑）
  GROUPS, STYLES, styleOf, promptBlock,
  // 可编辑词库（★ 都是函数 / 现取，别在调用方缓存成常量）
  EDITABLE_GROUPS, LOCKED_GROUPS, REDLINES,
  currentGroups, allWords, isCustom,
  sanitizeWords, sanitizeLibrary, saveLibrary, resetLibrary, libraryView,
  baselineViolations
};
