'use strict';
/**
 * ③ 文案生成
 * PRD 要点：
 *   - 把「选择」交给代码，「写作」交给模型：叙事视角 / 话题组合本地定死（代码保证去重）
 *   - 并发按路数均分，而不是「15 条/批」切批（尾批会把整体拖慢）
 *   - 结构化输出必须容错解析：markdown 代码块、中文标点、多余逗号都不能让整批失败
 *   - 单条重试，不整批失败
 *
 * ★★ 2026-10-02 「看图写」（本轮最大的一处改动，三处根因一起修）
 *   用户原话：「你现在都是根据货号和颜色生成的标题，一看就是 ai 做的，不真实」。
 *   实测查出来是三个毛病叠在一起：
 *     ① **一张图都没送给模型** —— user 消息里只有 `{货号, 颜色, 已选话题}` 三个字段；
 *     ② system 里钉着「标题必须采用 F01~F10 的写法」，而那 10 个模板长这样
 *        `<颜色>的细节，真的顶` ⇒ 标题必然是套话壳，因为输入里也没有别的信息；
 *     ③ 接口地址留空 + 模型名不是接口认的 id（实测 `deepseek v4.1 flash` 直接 HTTP 400），
 *        两次都抛异常被 catch，于是**静默**回退本地模板 —— 界面却显示「已生成」。
 *   现在：
 *     - 真的把素材图发给模型（缩到 imageMaxSide 内、JPEG base64，最多 imageCount 张）；
 *     - system 改成「标题只能来自你在图里看到的东西」，并把货号/款号与那批套话**明确禁掉**；
 *       F01~F10 降级为「本地模板（离线）」专用，不再往模型身上套；
 *     - 生成前先 preflight：把配置里的模型名对到接口**真认的 id**、读回它支不支持图像输入；
 *     - 开模型却连不上时**不再静默出模板货**：报错停下并说清原因（要本地模板就把开关关掉，
 *       那时报告里「生成来源」会逐行标成「本地模板」）。
 */
const path = require('path');
const store = require('../store');
const llmdefaults = require('../llmdefaults');
const imaging = require('./imaging');
// ★ 视频抽帧（2026-10-03）：只有视频、没有实拍图的叶子，从视频里抽帧当「图」送模型。
//   真起 ffmpeg 的是 frame.js，它复用 video.js 那一条 ffmpeg 通道（三段解析只有一个入口）。
const frame = require('./frame');
const copycheck = require('./copycheck');
const hotwords = require('./hotwords');
const apiusage = require('./apiusage');

/**
 * 本地模板（**离线 / 明确关掉模型时才用**）。
 * ★ 2026-10-02 起这套模板**不再进 system 提示词** —— 以前把它当「标题格式」钉给模型，
 *   模型照着套出来的就是「<颜色>的细节，真的顶」，用户一眼看出是 AI 批量做的。
 *   现在模型侧只按「看图写」的约束走，这 10 个壳留给离线兜底。
 */
const FORMATS = [
  { code: 'F01', name: '细节质感', tpl: c => `${c}的细节，真的顶`, hint: '从做工细节切入' },
  { code: 'F02', name: '场景代入', tpl: c => `穿上${c}的一天`, hint: '描述一个具体场景' },
  { code: 'F03', name: '配色思路', tpl: c => `${c}怎么搭都不出错`, hint: '给出一套配色方案' },
  { code: 'F04', name: '季节钩子', tpl: c => `这个季节就该是${c}`, hint: '绑定当季氛围' },
  { code: 'F05', name: '情绪表达', tpl: c => `被${c}治愈了`, hint: '情绪价值优先' },
  { code: 'F06', name: '穿搭上身', tpl: c => `${c}上身效果`, hint: '以上身感受为主' },
  { code: 'F07', name: '材质工艺', tpl: c => `${c}的面料会说话`, hint: '讲材质与工艺' },
  { code: 'F08', name: '性价比', tpl: c => `${c}这个价太实在`, hint: '强调质价比' },
  { code: 'F09', name: '提问互动', tpl: c => `${c}，谁懂啊`, hint: '用提问收尾引导评论' },
  { code: 'F10', name: '清单盘点', tpl: c => `${c}入选本周清单`, hint: '清单式盘点口吻' }
];

const ANGLES = [
  { key: '细节质感', phrase: '走线、包边、五金一处都不糊弄' },
  { key: '配色思路', phrase: '同色系拉开层次就很有质感' },
  { key: '穿搭上身', phrase: '上身不挑人，日常直接穿出门' },
  { key: '材质工艺', phrase: '面料摸上去就知道没偷工' },
  { key: '季节钩子', phrase: '换季衣柜里最该留的一件' },
  { key: '场景代入', phrase: '通勤和周末两套场景都能接住' },
  { key: '情绪表达', phrase: '穿上整个人都松弛下来了' },
  { key: '性价比', phrase: '这个价位能做成这样算厚道' },
  { key: '身材修饰', phrase: '版型对身材的包容度很高' },
  { key: '清洗打理', phrase: '好打理，不容易变形' }
];

/* ---------------- 模型配置 · 接口自检 ---------------- */

/**
 * 读模型配置。**留空 = 跟随内置**（llmdefaults.js），与云端协作同一套规矩。
 * ★ 只在**读**的时候兜底，**绝不写回 config.json** —— 写回就是固化，以后换服务商顶不动
 *   （而且卸载都不删 config.json，界面上还看不出区别）。
 */
function cfgOf() {
  const c = store.get('copy.llm') || {};
  const num = (v, def, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
  };
  // ★ 布尔要按**真值**判，不能只认 `!== false`：界面上存下来的是字符串 'false'，
  //   而 `'false' !== false` 是 true ⇒ 「不送图」会被读成「送图」。老配置里也留有字符串。
  const bool = v => !(v === false || v === 'false' || v === 0 || v === '0' || v === '');
  const own = String(c.endpoint || '').trim();
  // ★★ 2026-10-08：key 也走「留空＝跟随内置」（llmdefaults.apiKey，组织统一 key，用户拍板内置）。
  //   与 endpoint 同一套口径：本机填了以本机为准，留空才落回内置，且**绝不写回 config.json**。
  const ownKey = String(c.apiKey || '').trim();
  return {
    // 开关：显式开了才叫「要 AI 文案」。关着 = 用户主动选本地模板（报告里会逐行标出来）
    enabled: bool(c.enabled),
    endpoint: own || llmdefaults.endpoint,
    endpointSource: own ? '本机配置' : '跟随内置',
    apiKey: ownKey || llmdefaults.apiKey || '',
    apiKeySource: ownKey ? '本机配置' : '跟随内置',
    model: String(c.model || '').trim() || llmdefaults.model,
    temperature: Number.isFinite(Number(c.temperature)) ? Number(c.temperature) : 0.9,
    // 看图：默认开（只有明确写成 false / 'false' / 0 才是真的不看图）
    vision: bool(c.vision === undefined ? true : c.vision),
    imageCount: num(c.imageCount, llmdefaults.imageCount, 1, 4),
    imageMaxSide: num(c.imageMaxSide, llmdefaults.imageMaxSide, 320, 1568),
    timeoutSec: num(c.timeoutSec, llmdefaults.timeoutSec, 10, 300),
    // ★ 视频素材没有实拍图时，从视频里抽几帧送给模型（frame.js）。
    //   空串要当「没填」：`Number('')` 是 0，会被读成「一张都不抽」—— 而 0 是**真的**要「不抽」，
    //   这两件事必须分得开（和上面 vision 那个字符串 'false' 是同一类坑）。
    videoFrames: (c.videoFrames === '' || c.videoFrames == null)
      ? llmdefaults.videoFrames
      : num(c.videoFrames, llmdefaults.videoFrames, 0, frame.MAX_FRAMES)
  };
}

/** 用户可能只填到 `/v1`，也可能填全 `/chat/completions` —— 两种都要能算出清单与对话两个 URL */
function urlsOf(endpoint) {
  const base = String(endpoint || '').trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(base)) {
    return { chat: base, models: base.replace(/\/chat\/completions$/, '/models') };
  }
  return { chat: base + '/chat/completions', models: base + '/models' };
}

/** 比模型名时把空格/点/横线/下划线都去掉：`deepseek v4.1 flash` ↔ `DeepSeek-V4.1-Flash` */
function normModel(s) { return String(s == null ? '' : s).toLowerCase().replace(/[\s._\-]+/g, ''); }

async function listModels(cfg) {
  const res = await fetch(urlsOf(cfg.endpoint).models, {
    headers: { authorization: `Bearer ${cfg.apiKey}` },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`模型清单接口返回 ${res.status}`);
  const j = await res.json();
  const arr = (j && Array.isArray(j.data)) ? j.data : (Array.isArray(j) ? j : []);
  return arr.filter(m => m && m.id);
}

/**
 * 把配置里的模型名对到接口**真认的** id。
 * ★ 为什么非做不可：用户填的是显示名 `deepseek v4.1 flash`，实测接口直接 400
 *   `The supported API model names are deepseek-flash, deepseek-v4-pro, ...`
 *   —— 不解析就整批失败，然后被 catch 掉静默退回模板，看起来像「模型不好用」。
 * 匹配顺序：id 精确 → 显示名归一化 → 认不出交给调用方
 */
function pickModel(list, want) {
  const w = normModel(want);
  const byId = list.find(m => String(m.id) === String(want));
  if (byId) return { m: byId, how: 'id 精确匹配' };
  const byName = list.find(m => normModel(m.name) === w);
  if (byName) return { m: byName, how: `按显示名匹配（${byName.name || byName.id}）` };
  const byIdLoose = list.find(m => normModel(m.id) === w);
  if (byIdLoose) return { m: byIdLoose, how: '按 id 归一化匹配' };
  return null;
}

/** 这个模型收不收图。清单没说 → null（不知道，试了才知道），别说成「不支持」 */
function imageCapability(model) {
  if (!model) return null;
  const m = model.input_modalities || model.inputModalities;
  if (!Array.isArray(m)) return null;
  return m.includes('image');
}

/**
 * 生成前自检（一次网络往返）：地址通不通、模型名接口认不认、这个模型能不能看图。
 * 返回 { ok, why, chatUrl, modelId, modelName, modelHow, image, listErr, switched }
 * ★ 清单拉不到（有些网关没有 /models）**不算失败** —— 地址和 key 都在就先试真调用，
 *   真调用失败也会带上原始信息报出来，不会变成一句「未知错误」。
 */
async function preflight(cfg) {
  const u = urlsOf(cfg.endpoint);
  const out = {
    ok: false, why: '', chatUrl: u.chat,
    modelId: cfg.model, modelName: cfg.model, modelHow: '按配置原样用',
    image: null, model: null, listErr: '', switched: false
  };
  if (!cfg.endpoint) { out.why = '没配接口地址'; return out; }
  if (!cfg.apiKey) { out.why = '没配 API Key'; return out; }
  let list = [];
  try { list = await listModels(cfg); } catch (e) {
    out.listErr = e.message;
    // ★ 「拉不到清单」要分两种，别混成一件：
    //   ① 网络层就没通（fetch failed / 超时 / DNS）⇒ **这里就停下**，别让每条素材各撞一次墙；
    //   ② 地址通了但那个路径没有（404/405，有些网关就是不提供 /models）⇒ 不算失败，
    //      按配置的模型名直接试真调用，真失败也会带上原始信息报出来。
    if (!/返回 \d{3}/.test(e.message)) {
      out.why = `连不上接口（${e.message}）`;
      return out;
    }
  }
  if (list.length) {
    const hit = pickModel(list, cfg.model);
    if (hit) {
      out.model = hit.m; out.modelId = hit.m.id; out.modelName = hit.m.name || hit.m.id; out.modelHow = hit.how;
    } else {
      const d = pickModel(list, llmdefaults.model) || { m: list[0], how: '清单里的第一个' };
      out.model = d.m; out.modelId = d.m.id; out.modelName = d.m.name || d.m.id;
      out.modelHow = `配置的「${cfg.model}」不在接口清单里 → 改用「${out.modelName}」`;
      out.switched = true;
    }
  }
  out.image = imageCapability(out.model);
  out.ok = true;
  return out;
}

/* ---------------- 看图 ---------------- */

/**
 * 把这条素材的图读成模型能吃的 data URL。
 * 取叶子目录里前 imageCount 张图（真机第一个叶子就是一个商品的多张图）；
 * 单张读不了（HEIC 缺解码器 / 路径过长）只跳过这一张，不拖垮整条。
 */
async function imagePartsOf(item, cfg) {
  const dir = (item && (item.absDir || item.dir)) || '';
  const files = (item && item.files) || [];
  if (!dir) return [];
  const names = files
    .filter(f => f && f.type === 'image' && f.name)
    .map(f => f.name)
    .slice(0, cfg.imageCount);
  const out = [];
  for (const name of names) {
    try {
      const b64 = await imaging.shrinkBase64(path.join(dir, name), cfg.imageMaxSide);
      out.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } });
    } catch (e) { /* 单张失败继续下一张 */ }
  }
  return out;
}

/**
 * 这个叶子里的视频素材（抽帧只认第一个 —— 真机一个叶子 = 一个商品的素材）。
 * 返回 null 表示「这个叶子里没有视频」，**据此决定「没图」那句该怎么如实说**。
 */
function videoOf(item) {
  const dir = (item && (item.absDir || item.dir)) || '';
  const v = ((item && item.files) || []).find(f => f && f.type === 'video' && f.name);
  if (!dir || !v) return null;
  return { name: v.name, path: path.join(dir, v.name) };
}

/** 兜底话题池（品牌提示词与设置里都没给时才用） */
const DEFAULT_TOPIC_POOL = ['#男生穿搭', '#OOTD', '#秋冬新款', '#质感生活', '#日常搭配', '#好物分享'];

/**
 * 从一段自由文本里把 `#话题` 抠出来（按出现顺序、去重）。
 * ★ 话题名的合法字符与 `stripTrailingTopics` 同一套：`#` + 汉字/字母/数字，**遇到标点就停**。
 *   实测踩过：写成「`#` 后面直到空白」会把「#小故事，讲给你听。」整段当成一个话题。
 */
function topicsFromPrompt(text) {
  const src = String(text == null ? '' : text);
  const hit = src.match(/#[^\s#，。！？、：；,.;:!?()（）\[\]【】"'“”‘’…—\-]+/g) || [];
  const out = [];
  const seen = new Set();
  for (const t of hit) {
    const n = normTopic(t);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * 额外话题的**池子**。两级来源，前者优先：
 *   ① **品牌提示词里自己写的 `#话题`** —— 2026-10-03 用户拍板：「额外话题我会在品牌提示词中写入」。
 *      品牌那段「二、话题列表……#今日份穿搭 #我的穿搭不秋季新look」直接就能当池子用，
 *      不用再让人在设置页抄一遍（以前池子只有内置的 `#男生穿搭 #OOTD` 那几个通用词，
 *      跟品牌调性完全不搭 —— 用户拿到的就是「话题不对」）。
 *   ② 设置页的「话题池」（`copy.pool`）—— 老来源，保底用。
 *   ③ 都没有 → 内置默认。
 * ★ 提示词里那两条**必带话题**也会被抽进来，但 `topicCombos` 会按名字把它们从「额外」里剔掉，
 *   不会重复占坑。
 *
 * ★★ 2026-10-03 实测补一条：**提示词里写得够，就只用它写的**。
 *   第一版是把「品牌提示词抽出来的」和「设置页话题池」直接拼起来 —— 真机跑 10 条，
 *   前 7 条用的是提示词里那几个（对），后 3 条滑进了设置页的 `#男生穿搭 #OOTD #秋冬新款`（用户根本没要）。
 *   用户的原话是「额外话题我会在品牌提示词中写入」⇒ 写够了就别再掺别的。
 *   写得**不够**（少于这次要的额外个数）才补，而且提示词里的排在前面 —— 补足只是为了「组合凑不开」，
 *   不是为了改变话题来源。
 *
 * @param {object} brand 品牌（读 promptWrite）
 * @param {number} min   这次需要的「额外话题」个数；提示词里给够这个数就只用提示词里的
 */
function topicPool(brand, min) {
  const fromBrand = topicsFromPrompt(brand && brand.promptWrite);
  const enough = Number(min) > 0 && fromBrand.length >= Number(min);
  const p = store.get('copy.pool');
  const local = enough ? [] : (Array.isArray(p) && p.length ? p : (p && p.品类 ? p.品类 : []));
  const merged = [];
  const seen = new Set();
  for (const t of fromBrand.concat(local.map(normTopic))) {
    const n = normTopic(t);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    merged.push(n);
  }
  return merged.length ? merged : DEFAULT_TOPIC_POOL;
}

/** 发布单只有「话题1~话题5」五列（见 sheet.COLUMNS）—— 多出来的话题到不了得物 */
const MAX_TOPIC_COLS = 5;

/** 一个话题的规范写法：统一带 `#` 前缀（2026-10-03 用户拍板：**不做联想点选**，按给的词直接写） */
function normTopic(t) {
  const s = String(t == null ? '' : t).trim();
  if (!s) return '';
  return s.startsWith('#') ? s : '#' + s;
}

/**
 * 「必带话题」输入框里可以写**多个**话题，分隔符认这几种（可混用、连续几个也只算一次）：
 *   空格 / Tab / 换行 · 英文逗号 `,` · 中文逗号 `，` · 顿号 `、` · 分号 `;` `；` · 竖线 `|`
 *
 * 为什么非要有明确的分隔符：得物的话题字段是「一格一个话题」。
 * 把 `#A #B` 整串写进一格，得物那边会当成**一个不存在的话题**，联想点选必然失败 ——
 * 而失败现场看起来像是「话题选错」，查起来很绕。所以在这里就拆开。
 * ★ 自动补 `#`（写 `品牌词, 品类词` 也能用），并按拆分后的原文去重。
 */
function parseTopics(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return [];
  const out = [];
  const seen = new Set();
  for (const piece of s.split(/[\s,，、;；|]+/)) {
    const t = normTopic(piece);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** 生成话题组合（去重由代码保证）；池子容量不够时明确告警 */
function topicCombos(count, brand) {
  // ★ wantExtra 要在读池子**之前**算出来：池子得知道「这次要几个额外话题」，
  //   好决定「品牌提示词里写的够不够」（够了就只用它写的，见 topicPool）。
  const wantExtra = Number(store.get('copy.extraTopics')) || 4;
  const pool = topicPool(brand, wantExtra).map(normTopic).filter(Boolean);
  const requiredAll = parseTopics(store.get('copy.requiredTopic'));
  const required = requiredAll.length ? requiredAll : [pool[0]].filter(Boolean);
  // ★ 必带 + 额外 超过 5 列就**少给并说出来**。以前是静默把第 6 个丢掉 ——
  //   界面上看着「带了 6 个话题」，发布单里只有 5 个，而且没有任何提示。
  const extra = Math.max(0, Math.min(wantExtra, MAX_TOPIC_COLS - required.length));
  const notes = [];
  if (extra < wantExtra) {
    notes.push(`发布单只有 ${MAX_TOPIC_COLS} 个话题列（话题1~话题${MAX_TOPIC_COLS}）：必带 ${required.length} 个 + 额外 ${wantExtra} 个放不下，每条只带前 ${MAX_TOPIC_COLS} 个话题`);
  }
  const rest = pool.filter(t => !required.includes(t));
  const combos = [];
  const seen = new Set();
  const pick = (arr, k, start) => {
    const out = [];
    for (let i = 0; i < k; i++) out.push(arr[(start + i) % arr.length]);
    return out;
  };
  for (let s = 0; s < rest.length; s++) {
    const c = required.concat(pick(rest, extra, s));
    const key = c.slice().sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    combos.push(c);
  }
  // extra = 0（必带就把 5 列占满了）：每篇本来就只有必带那几个，重复是**应该**的，不算容量不足
  if (!extra && !combos.length) combos.push(required.slice());
  if (combos.length < count) {
    // 容量不足：跨品类/滑动窗口补足，并允许重复但标记
    // ★ 报的必须是**补足之前**真能凑出的种数。以前是在 while 之后取 combos.length，
    //   那个数已经被补到 count 了 —— 于是告警写着「只能凑 5 种组合」（其实只有 1 种），
    //   看的人会以为「还剩 5 种可用」，等于把容量问题说轻了。
    const distinct = combos.length;
    let s = 0;
    while (combos.length < count && s < 200) {
      const c = required.concat(pick(rest, extra, s++));
      combos.push(c);
    }
    if (extra > 0) {
      notes.push(`话题池容量不足：${rest.length} 个可选话题只能凑 ${distinct} 种组合，${count} 篇会出现重复 —— `
        + '在**品牌提示词的「话题列表」里多写几个 #话题**（程序会自动抓过来当池子），或把「额外话题」调小');
    }
  }
  return { combos, warning: notes.length ? notes.join('；') : null };
}

/** 本地先定好每篇的「选择」，模型只填空 */
function buildPlan(items, brand) {
  const { combos, warning } = topicCombos(items.length, brand);
  return {
    warning,
    rows: items.map((it, i) => {
      const fi = i % FORMATS.length;
      const ai = (i * 3) % ANGLES.length;
      // ★★ 标题的「词包格式」（T01~T15）与本地模板的 F01~F10 是**两套**东西：
      //   F 只在「关掉模型 / 离线」时用；T 是给模型的**标题形状**（单品+热词 怎么拼）。
      //   同一个轮换下标 ⇒ 整批不会只出一种格式（用户明确要求「禁止单一格式重复」）。
      //   ★ 但「重复」的**判定口径**在 2026-10-03 被用户放宽：只看**相邻两条**是否一字不差
      //     （换了 emoji 就算不同；跨品牌、隔开几条再撞句都没关系）—— 见 copycheck.checkBatch。
      const ts = hotwords.styleOf(i);
      return {
        id: it.id,
        format: FORMATS[fi].code,
        formatName: FORMATS[fi].name,
        formatHint: FORMATS[fi].hint,
        angle: ANGLES[ai].key,
        anglePhrase: ANGLES[ai].phrase,
        topics: combos[i % combos.length],
        titleStyle: ts.code,
        titleStyleName: ts.name,
        titleFormula: ts.formula,
        titleSample: ts.sample
      };
    })
  };
}

function localFill(item, plan) {
  const c = item.color || '这款';
  const f = FORMATS.find(x => x.code === plan.format) || FORMATS[0];
  const title = f.tpl(c);
  // ★ 2026-10-03：正文也改成 **4 行短句**（与模型侧同一套格式）——
  //   否则「关掉模型用本地模板」的产物会被自己的核对判成「没分行」：
  //   同一条规则，不能对模型严、对模板松。
  const body = [
    `${c}这件上身很好穿，`,
    `${plan.anglePhrase}，`,
    `${f.hint}，`,
    '日常搭配不费劲，衣柜里很省心🌟'
  ].join('\n');
  return { title, body };
}

/**
 * 从模型回复里抠出 JSON。
 *
 * ★★ 2026-10-02 修一个**会毁掉文案质量**的老毛病：旧实现**无条件**先把
 *   `，`→`,`、`：`→`:`、`“”「」`→`"` 全换一遍，再 JSON.parse。
 *   结构问题确实被修掉了，但**正文里的中文标点也跟着被改掉了** ——
 *   实测「的细节，真的顶」回来变成「的细节,真的顶」，
 *   一整篇中文文案里全是半角逗号、冒号、引号，发出去一眼就不像人写的。
 *   现在：**先按原样解析**（绝大多数模型返回的就是合法 JSON，本来不需要动它）；
 *   只有真的解析不了，才退到那套宽容替换 —— 它是"别让整批挂掉"的兜底，不是常态路径。
 */
function extractJson(text) {
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try { return JSON.parse(s); } catch (e) { /* 落到宽容解析 */ }
  const loose = s.replace(/，/g, ',').replace(/：/g, ':')
    .replace(/[“”「」]/g, '"').replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(loose);
}

/** 没有品牌层时（免登录 / 测试直调）的兜底角色设定 */
const ROLE_FALLBACK = '你是得物蓝V账号的文案写手。';

/**
 * 拼 system：品牌自己的模板在前（角色 / 调性 / 写什么），代码固定的输出约束在后。
 * 分开是有意的 —— 写模板的人只管内容；JSON 字段名、字数上限这些**解析器依赖的硬约束由代码兜住**，
 * 漏写一句就会让整批 JSON.parse 失败，而失败原因看起来像「模型不听话」。
 *
 * ★★ 2026-10-02：「标题必须采用 F01~F10 的写法」这条约束**删掉了**。
 *   它把「写什么」也一起钉死了 —— 模型只能照着 `${color}的细节，真的顶` 这种壳填，
 *   而送进去的又只有货号+颜色、一张图都没有，于是标题必然像 AI 批量做的
 *   （用户原话：「一看就是 ai 做的，不真实」）。
 *   换成「标题只能来自你在图里真实看到的东西」，并把货号/款号与那批套话明确禁掉。
 *   `opt.vision=false`（模型不收图 / 用户关掉看图）时换成对应说法 —— 宁可写得平实，
 *   也不许模型**编造**图里才看得见的款式细节（编出来的比没有更糟）。
 */
function buildSystem(brandPrompt, plan, opt = {}) {
  const head = String(brandPrompt || '').trim() || ROLE_FALLBACK;
  const vision = opt.vision !== false;
  const see = vision
    ? [
      '【看图写词包标题】看图是为了让你**认准这是哪件单品、什么颜色**，',
      '不是让你把款式特征堆成一句话。标题 = 产品词（图里那件单品 + 颜色）+ 热门词，',
      '但**不是把两个词直接贴在一起** —— 那样读着有语病，要写成**一句念得通的话**：',
      '· 带连接字：简约百搭的羽绒服 / 通勤就穿卡其夹克 / 灰毛衣穿出老钱风 / 羽绒服才是过冬的答案；',
      '· 或带收尾：少年感灰针织毛衣太帅了 / 军绿调穿搭夹克 松弛感拉满 / 卡其夹克，一眼心动。',
      '· ★★ 标题里**一个字都不许出现「+」** —— 那只是我示意「哪类词跟哪类词合并」的符号，别抄进标题。',
      '· 热门词从下面「标题热词库」里挑，或写出同等调性的风格 / 氛围 / 场景 / 人群 / 季节 / 情绪 / 收尾词；',
      '· 这一行用哪种**句式**见 user 里的「本行标题格式」，整批轮换着来（一直用同一个形状会显得单调）；',
      '· ★ 相邻两条别写得一模一样（标题、正文都是）—— 换一个句式、换一个热词、或者**只换一个 emoji** 都算不同；',
      '  隔开几条之后再出现同样的句子、或者换个品牌再用同一句，都没关系。',
      '· 15 字以内，1~2 个贴合的 emoji：一般句式放 1 个、在结尾；',
      '  **只有那句「双爱心 / 双圆圈」的句式是两个、夹在句子中间，且颜色必须跟本行颜色一致**。',
      '★ 不许写成商品描述 ——「蓝灰横向绗缝立领羽绒，左胸刺绣」这种是被打回的写法：',
      '  款式特征（绗缝 / 立领 / 刺绣 / 拉链 / 口袋 / 圆领）整条标题**最多带 1 个**，别堆。',
      '· ★ 有几条句式**故意不带单品**（只写穿搭感 / 氛围感，如「高智感…系叠穿」「温柔…系穿搭上线」「韩系叠穿💙💙蓝色系好有少年感」）——',
      '  轮到这种就照句式写，**别硬塞一件单品进去**（上面那句「标题 = 单品 + 颜色 + 热门词」不适用于它们）。',
      '★ 热词只许是风格 / 氛围 / 场景 / 人群 / 季节 / 情绪类；',
      '  材质与参数（鹅绒 / 充绒量 / 加厚 / 防风防水 / 羊毛含量…）图里看不出来就别写。'
    ].join('\n')
    : [
      '【这次没有图，照样写词包标题】只能按文字里给的货号与颜色写：',
      '标题 = 产品词（颜色能推出的品类）+ 热门词，但要写成**一句念得通的话**（带连接字或收尾）；',
      '★ 标题里**一个字都不许出现「+」** —— 那只是「哪类词跟哪类词合并」的示意图；',
      '颜色只能写文里给的那个，不许编造图里才看得见的款式细节（领型 / 面料 / 图案）；',
      '热词只许用风格 / 氛围 / 场景 / 人群 / 季节 / 情绪类。',
      '★ 有几条句式故意不带单品（只写穿搭感 / 氛围感）—— 轮到就照句式写，别硬塞单品。',
      '这一行用哪种句式见 user 里的「本行标题格式」，15 字以内，1~2 个贴合的 emoji（一般放结尾；双爱心/双圆圈那句是两个、夹在句中，颜色跟本行颜色一致）。'
    ].join('\n');
  return `${head}
---
输出要求（程序追加，别删）：
只输出 JSON，字段：title、body。
${see}
下面的热词库是当前机器保存的词库。生成文案时结合本批提供的图片和这份词库，不假定其他机器的自定义词库相同；商品细节以图片为准。
${hotwords.promptBlock()}
标题里一律不许出现：货号、款号、SKU、条形码、编号、店铺名。
标题里也不许用「最」「第一」「顶级」这类极限词（广告法不让写）。
标题里也不许出现这些空话套话：${copycheck.BANNED.map(p => `「${p}」`).join('')}。
正文写成 **4~5 行**（这是格式要求，不是建议）：**一行一句短句、8~16 字**，行与行之间**真的换行**（在 JSON 字符串里用换行转义表示，别打成两个字面字符）。
一行一个点，按「卖点（面料 / 工艺 / 版型）→ 氛围感 → 上身体验 → 搭配」铺开，其中一行走「${plan.angle}」（${plan.anglePhrase}）这个角度；
只写图里看得到的实物细节，口语化，不要第一人称、不要广告腔、不要写成一大段。
全篇 1~3 个 emoji，放在行尾，别每行都堆。形状参考（单品与颜色按你图里那件写，别照抄）：
  面料摸上去软糯，
  宽松版型上身不挑人，
  颜色低调但很显气色，
  日常通勤随手一穿就对🌿
话题（必带话题 + 品牌提示词里写的那些）由程序统一追加到文案末尾、一个话题单独一行，所以正文结尾不要带任何 #话题。
不要输出 markdown 代码块。
（上面品牌提示词里若自己写了标题格式清单，以**品牌提示词**的为准。）`;
}

/** 网关拒绝「收了不支持的图」时措辞五花八门，用关键字判一下，好决定要不要退回纯文字重试 */
function looksLikeVisionReject(msg) {
  return /image|multimodal|vision|unsupported|content type|modalit/i.test(String(msg || ''));
}

/**
 * 调一次模型。opt: { modelId, vision, images }
 * 有图就发多模态 content 数组；没图就发老式的纯字符串（兼容只认字符串的网关）。
 */
async function callLLM(item, plan, brandPrompt, opt = {}) {
  const c = cfgOf();
  if (!c.endpoint) throw new Error('未配置接口地址');
  const url = urlsOf(c.endpoint).chat;
  const useImages = opt.vision !== false && (opt.images || []).length > 0;
  const messages = [
    { role: 'system', content: buildSystem(brandPrompt, plan, { vision: opt.vision !== false }) }
  ];
  const ask = JSON.stringify({
    货号: item.sku || '',
    颜色: item.color || '',
    已选话题: plan.topics,
    // ★ 每行的标题格式由**代码**定（保证整批不重复），模型只管照着这个形状填内容
    本行标题格式: plan.titleStyle
      ? `${plan.titleStyle} ${plan.titleStyleName || ''}：${plan.titleFormula || ''}（形状示例：${plan.titleSample || ''} —— 只学这个句子的形状，别照抄里面的单品与颜色（颜色用**本行**的）；写成念得通的一句话，**不许出现 + 号**）`
      : '（未指定，按「产品词 + 热门词」自行组织；只要相邻两条不写成一模一样就行）',
    看图: useImages ? `本次给了 ${opt.images.length} 张实拍图，标题按图里的实物写` : '本次没有图'
  });
  messages.push({
    role: 'user',
    content: useImages ? [{ type: 'text', text: ask }].concat(opt.images) : ask
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${c.apiKey || ''}` },
    body: JSON.stringify({
      model: opt.modelId || c.model,
      temperature: c.temperature,
      messages,
      response_format: { type: 'json_object' }
    }),
    signal: AbortSignal.timeout(c.timeoutSec * 1000)
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`接口返回 ${res.status}${body ? '：' + body.slice(0, 200) : ''}`);
    err.status = res.status;
    // 让上层知道「这次是因为图才失败的」，好退回纯文字再试一次，而不是把整条作废
    if (useImages && looksLikeVisionReject(body)) err.visionReject = true;
    throw err;
  }
  const data = await res.json();
  const usage = apiusage.requestUsage(data && data.usage, opt.modelId || c.model, c.endpoint, opt.mediaKind, Date.now());
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  let parsed;
  try { parsed = extractJson(content || '{}'); }
  catch (error) { error.usage = usage; throw error; }
  if (!parsed || !parsed.title) throw Object.assign(new Error('返回缺少 title'), { usage });
  return {
    title: unescapeNewlines(parsed.title).slice(0, 60),
    body: unescapeNewlines(parsed.body).slice(0, 400),
    usage
  };
}

/**
 * 正文结尾模型自己加的 `#话题` 去掉 —— 只负责**摘掉**，写回是 `appendTopics` 的事（两步别混）。
 * 为什么非去不可：品牌提示词常写着「结尾从话题列表里挑 5 个」，模型就顺手在正文尾巴上再写一遍；
 * 而它挑的那几个**跟程序按计划选的对不上**（必带话题可能漏、额外话题可能重）。
 * 话题由 `appendTopics` 按计划统一追加 ⇒ 留着模型那串就是同一个话题出现两次。
 * 实测三张样本里两张都是这样（`…套上刚好。#TW男装`）。
 */
function stripTrailingTopics(body, topics) {
  const before = String(body == null ? '' : body);
  // 话题名的合法字符：一个话题就是 `#` + 汉字/字母/数字，**遇到标点就停**。
  // ★ 这里不能用「`#` 后面直到空白」那种写法 —— 实测会把「#小故事，讲给你听。」整段当成一个话题删掉。
  const TOKEN = '#[^\\s#，。！？、：；,.;:!?()（）\\[\\]【】"\'“”‘’…—\\-]+';
  const isTopicLine = line => new RegExp(`^\\s*(${TOKEN}\\s*)+$`).test(line);
  const lines = before.split(/\r?\n/);
  // ① 尾部整行是话题的（以及它前面的空行）逐行删
  while (lines.length) {
    const last = lines[lines.length - 1];
    if (!last.trim() || isTopicLine(last)) { lines.pop(); continue; }
    break;
  }
  // ② 末行**尾巴上直接跟**一串话题 —— 实测就是「…套上刚好。#TW男装」，**连空格都没有**，
  //    所以不能要求话题前面必须有空白，认「行首 / 空白 / 句末标点」三种起点就行。
  if (lines.length) {
    const last = lines[lines.length - 1];
    const m = last.match(new RegExp(`(?:^|[\\s\\u3000]|[。！？!?.])(${TOKEN}(?:[\\s\\u3000]*${TOKEN})*)[\\s\\u3000]*$`));
    if (m) {
      lines[lines.length - 1] = last.slice(0, last.length - m[1].length).replace(/[\s\u3000]+$/, '');
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    }
  }
  const s = lines.join('\n');
  return { body: s, changed: s !== before, stripped: before.length - s.length, hasTopics: (topics || []).length > 0 };
}

/**
 * 把这条的**话题并进文案**：一个话题单独一行，连 `#` 一起写进去。
 *
 * ★★ 2026-10-03 用户拍板（原话：「你直接在文案那里每个话题单独一行，复制 `#abcde` 整个过去就行了」）。
 *   必须写进**文案本体**，不能只留在 `row.topics` 里 —— 后者在真实流程里是**断的**：
 *   生成 → 导出 `AI内容报告`（表里**没有话题列**）→ 导入 ⇒ `report.js` 一律读回 `topics: []`，
 *   于是发布时定位表的「话题1~5」五步全是空占位符、整段跳过，真机跑出来就是**第一条零话题**。
 *   写进文案，就跟着「文案」那一列走，导来导去话题都在。
 * ★ 为什么「一个话题一行」而不是挤一行：得物正文本来就是**多行输入框**（正文本身要求 4~5 行），
 *   话题挤在一行会跟正文粘成一串，读着像写坏了。
 * ★ 空话题数组 ⇒ 原样返回，不做任何拼接（`= 0` 个话题时正文一个字符都不许多）。
 */
function appendTopics(body, topics) {
  const core = String(body == null ? '' : body).replace(/[\s\u3000]+$/, '');
  const list = (topics || []).map(normTopic).filter(Boolean);
  if (!list.length) return core;
  return core + '\n' + list.join('\n');
}

/**
 * 模型有时把换行写成**字面的** `\n`（两个字符：反斜杠 + n），不是真的换行。
 * 实测（2026-10-03 真机 3 条）：同一批里就有 1 条正文带字面 `\n`，另外两条是真换行 ——
 * 这种串发到得物会原样显示成死文本，用户只会觉得「文案坏了」。这里统一还原成真换行。
 */
function unescapeNewlines(s) {
  return String(s == null ? '' : s)
    .replace(/\\r\\n|\\n|\\r/g, '\n')
    .replace(/\r\n?/g, '\n');
}

/** 并发按路数均分：6 路 × ~N/6 篇，而不是切成 15 条/批 */
async function generate(items, ctx = {}) {
  const log = ctx.log || (() => {});
  // ★ 2026-10-05 用户口径「给用户只看大结论」：`log`（= ctx.log）现在是**过程明细**（界面不显示）。
  //   `conclude` 是**会直接出现在用户眼前**的那几句 —— 只有「用户据此要改设置 / 要换做法」的才配用它：
  //   比如「这次根本没看图」。工具直接调本模块时 ctx 里没有 conclude ⇒ 退回 log（老行为）。
  const conclude = ctx.conclude || log;
  const progress = ctx.progress || (() => {});
  const cancelled = ctx.cancelled || (() => {});
  const concurrency = Math.max(1, Math.min(8, store.get('copy.concurrency') || 6));
  const cfg = cfgOf();
  const llmOn = cfg.enabled;

  // 品牌自己的文案提示词。jobs.run 已经前置拦过一次，这里是第二道 ——
  // 有人直接 require 本模块调 generate 时也必须拦住，否则「没配也能出文案」这条后门一直开着
  // ★ 品牌要在 buildPlan **之前**拿到：额外话题的池子就来自品牌提示词里写的 `#话题`（见 topicPool）。
  const brand = (ctx && ctx.brandFull) || null;
  const brandPrompt = brand ? String(brand.promptWrite || '').trim() : '';
  const plan = buildPlan(items, brand);
  if (plan.warning) log(plan.warning, 'warn');
  if (brand && !brandPrompt) {
    throw new Error(`品牌「${brand.name}」还没配「文案生成提示词」——到「文案生成 → 提示词配置」里补上再跑`);
  }

  // ---- 接口自检（只在「开了模型」时才做：关着就是用户主动选本地模板，不该联网）----
  let pf = null;
  let vision = false;
  if (llmOn) {
    pf = await preflight(cfg);
    if (!pf.ok) {
      // ★★ 这里**不再静默回退本地模板**。以前是：抛异常 → catch → 用模板填空 → 界面显示「已生成」，
      //   用户拿到的是一堆像 AI 写的模板货，还以为那就是模型写的（2026-10-02 用户实测投诉）。
      //   现在直接停下并说清：要本地模板就把模型开关关掉（那时报告里会逐行标出「本地模板」）。
      throw new Error(
        `模型没连上（${pf.why}）：没有生成任何文案，也不会拿本地模板冒充 AI 文案。`
        + `接口地址：${cfg.endpoint}（${cfg.endpointSource}）。修好后重跑；`
        + '要用本地模板就先把「设置 → 文案 → 调用模型」改成「本地模板（离线）」。'
      );
    }
    vision = cfg.vision && pf.image !== false;
    log(brand ? `文案模板：品牌「${brand.name}」自己的提示词` : '文案模板：内置默认（本次没有品牌归属）', 'info');
    log(`接口：${cfg.endpoint}（${cfg.endpointSource}）· 模型 ${pf.modelId}${pf.switched ? `（${pf.modelHow}）` : ''}`, pf.switched ? 'warn' : 'info');
    if (pf.listErr) log(`拉不到模型清单（${pf.listErr}），按配置的模型名直接试 —— 失败原因会原样报出来`, 'warn');
    if (pf.image === false) {
      conclude(`模型「${pf.modelId}」的清单里没有 image 输入能力 ⇒ 这次不看图，标题只能按货号/颜色写（会偏「像 AI 批量做的」）`, 'warn');
    } else if (!cfg.vision) {
      conclude('「设置 → 文案 → 看图」关着 ⇒ 这次不送图，标题只能按货号/颜色写', 'warn');
    } else {
      log(`看图写：每条送前 ${cfg.imageCount} 张实拍图（缩到 ${cfg.imageMaxSide}px 再发，不落盘）`, 'info');
      if (cfg.videoFrames > 0) {
        log(`只有视频、没有实拍图的素材：从视频里抽 ${cfg.videoFrames} 帧当图送去`
          + '（抽帧在本机做；送出去的还是这个常数，不随视频变长而变多）', 'info');
      } else {
        conclude('抽帧张数被设成 0 ⇒ 只有视频的素材一张图都不送，标题只能按货号/颜色写', 'warn');
      }
    }
  }
  if (!llmOn) {
    // 关掉模型 = 用户主动选择本地模板。**如实说清它不是 AI 文案**，报告里「生成来源」也会逐行标出来
    log('模型开关关着 ⇒ 标题/正文来自本地模板（F01~F10），不是看图写的；AI 内容报告的「生成来源」列会逐行标出「本地模板」', 'warn');
  }

  const lanes = Array.from({ length: concurrency }, () => []);
  plan.rows.forEach((r, i) => lanes[i % lanes.length].push(r));
  log(`并发 ${concurrency} 路 · 每路 ${Math.ceil(plan.rows.length / concurrency)} 篇（按路数均分，不留尾批）`, 'info');

  const out = new Map();
  const apiRequests = [];
  let balanceInsufficient = false;
  let done = 0, failed = 0, visionOff = 0, topicStripped = 0, topicAppended = 0, noImage = 0, firstErr = '';
  // 视频抽帧的账：成功几条、失败几条（失败原因取第一条；逐条的结果都写进了报告的「生成来源」）
  let frameUsed = 0, frameFail = 0, frameErr = '';

  const workOne = async (row) => {
    const item = items.find(it => it.id === row.id) || {};
    let text = null, err = null, images = [];
    // ★ 这个叶子里的视频素材：既用来抽帧，也决定「没图」那句该怎么说才如实
    const vid = videoOf(item);
    let fromVideo = false;
    if (llmOn && vision) {
      images = await imagePartsOf(item, cfg);
      // ★★ 一张实拍图都没有、却有视频 ⇒ 从视频里抽帧当图（用户 2026-10-03：
      //   「目前导入视频无法根据视频中的产品生成对应的文案」—— 以前视频叶子一张图都送不出去，
      //   模型只能按货号+颜色写，出来的又是套话壳）。
      //   **有图就只送图**：实拍图本来就是这件货最好的那几帧，而抽帧要起 ffmpeg、多花时间。
      //   抽帧失败**不抛**（frame.framesOf 自己把原因带回来）—— 一条视频抽不出帧，
      //   不该把整批 50 条一起弄挂；那一条如实标成「视频没抽出帧」照常往下走。
      if (!images.length && vid && cfg.videoFrames > 0 && !cancelled()) {
        const fr = await frame.framesOf(vid.path, {
          count: cfg.videoFrames, maxSide: cfg.imageMaxSide, cancelled
        });
        if (fr.ok) { images = fr.images; fromVideo = true; frameUsed++; }
        else { frameFail++; if (!frameErr) frameErr = fr.err; }
      }
      if (!images.length) noImage++;
    }
    for (let attempt = 0; attempt < 3 && !text; attempt++) {
      if (llmOn && balanceInsufficient) {
        err = Object.assign(new Error('AI 接口余额不足，本批已停止后续请求'), { status: 402 });
        break;
      }
      try {
        text = llmOn
          ? await callLLM(item, row, brandPrompt, { modelId: pf.modelId, vision: vision, images,
            mediaKind: fromVideo ? 'video' : (images.length ? 'image' : 'text') })
          : localFill(item, row);
        if (llmOn && text) apiRequests.push(text.usage || { usageMissing: true,
          mediaKind: fromVideo ? 'video' : (images.length ? 'image' : 'text') });
      } catch (e) {
        err = e;
        if (!llmOn) break;
        // HTTP 成功但返回内容不能用时也可能已经计费；先记录响应里的 usage，再进行重试。
        if (Object.prototype.hasOwnProperty.call(e, 'usage')) apiRequests.push(e.usage || { usageMissing: true,
          mediaKind: fromVideo ? 'video' : (images.length ? 'image' : 'text') });
        // 这一次是因为「图」被网关拒了 ⇒ 整批改走纯文字，别让 50 条一条条撞同一个墙
        if (e.visionReject && vision) {
          vision = false;
          images = [];
          visionOff++;
          conclude(`${pf.modelId} 不收图（${e.message.slice(0, 80)}）⇒ 整批改成只发文字，标题会偏货号/颜色`, 'warn');
          continue;
        }
        // 余额不足属于账户状态，不会因重复请求恢复；立刻停下，避免每条素材再发两次无效请求。
        if (Number(e.status) === 402) {
          balanceInsufficient = true;
          err = Object.assign(new Error('AI 接口余额不足（HTTP 402），请检查 API 账户余额后重试'), { status: 402 });
          break;
        }
        if (attempt < 2) await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
      }
    }
    if (!text) {
      // ★ 单条失败**不再拿本地模板顶上**（那正是「看起来像 AI、其实是模板」的来源）：
      //   如实记成「未生成 + 原因」，报告里逐行写出来，最后还会汇总告警。
      failed++;
      const why = err ? err.message : '未知原因';
      if (!firstErr) firstErr = why;
      log(`${row.id} 生成失败：${why}`, 'warn');
      out.set(row.id, Object.assign({}, row, {
        title: '', body: '', status: '未生成', genSource: '未生成', genNote: why,
        // 没生成出正文 ⇒ 也没有话题可并（话题是跟着文案走的）
        topics: []
      }));
      done++;
      progress({ done, total: plan.rows.length, label: row.id });
      return;
    }
    // ① 正文尾巴上模型自己写的 #话题 先摘掉（它挑的跟程序按计划选的对不上，会重复）
    // ② 再把**程序按计划选好的**话题追加到文案末尾 —— 一个话题单独一行（用户 2026-10-03 拍板，见 appendTopics）
    let body = text.body;
    if (!llmOn) {
      body = text.body;
    } else {
      const st = stripTrailingTopics(text.body, row.topics);
      if (st.changed) { topicStripped++; body = st.body; }
    }
    body = appendTopics(body, row.topics);
    if (row.topics && row.topics.length) topicAppended++;
    out.set(row.id, Object.assign({}, row, {
      title: text.title, body, status: '已生成',
      // ★★ 话题已经并进 `body`（见 appendTopics）⇒ 这里必须**清空** topics。
      //   留着它，发布时定位表的「话题1~5」五步会**再写一遍** ⇒ 同一条内容话题出现两次。
      //   清空后那五步自动跳过（占位符是空的），走的还是原来那条已测过的路。
      topics: [],
      // 逐条如实标来源：这条到底看没看图（模型不收图 / 这条没图 都要分得清）
      genSource: llmOn
        ? (vision
          ? (images.length
            ? (fromVideo ? `AI 看图（${pf.modelId}，视频抽帧）` : `AI 看图（${pf.modelId}）`)
            : (vid
              ? (cfg.videoFrames > 0
                ? `AI 文字（${pf.modelId}，视频没抽出帧）`
                : `AI 文字（${pf.modelId}，视频没抽帧）`)
              : `AI 文字（${pf.modelId}，这条没图）`))
          : `AI 文字（${pf.modelId}，没看图）`)
        : '本地模板'
    }));
    done++;
    progress({ done, total: plan.rows.length, label: row.id });
  };

  await Promise.all(lanes.map(async lane => {
    for (const row of lane) {
      if (cancelled()) return;
      await workOne(row);
    }
  }));

  // 中断/取消时没跑到的那几行也按**同一条口径**收尾：话题并进文案 + 清空 topics。
  // ★ 别省这一步：同一批里若「跑到的行话题在文案里、没跑到的行话题在 topics 里」，
  //   发布时有的行写成正文、有的行走「话题1~5」五步 —— 事后看日志根本分不清是哪种。
  const rows = plan.rows.map(r => out.get(r.id) || (() => {
    const m = Object.assign({}, r, localFill({ color: '' }, r), {
      status: '已生成', genSource: llmOn ? 'AI（中断，未取到结果）' : '本地模板'
    });
    return Object.assign(m, { body: appendTopics(m.body, m.topics), topics: [] });
  })());
  const okCount = rows.filter(r => r.status === '已生成').length;
  if (llmOn && failed && !okCount) {
    // 带上**第一条的原始原因**：只说「一条都没生成出来」等于没说，
    // 用户还是不知道是 401、是模型名不对、还是网络断了。
    const error = new Error(balanceInsufficient
      ? `AI 接口余额不足（HTTP 402），本批已停止（${failed} 条未生成）。请检查 API 账户余额后重试。`
      : `一条都没生成出来（${failed} 条全失败）——接口或模型有问题，先解决再跑，别拿空文案往下走。原始错误：${firstErr || '（没记到）'}`);
    error.apiUsage = apiusage.aggregate(apiRequests);
    throw error;
  }
  if (balanceInsufficient) conclude(`AI 接口余额不足（HTTP 402），本批有 ${failed} 条未生成；请检查 API 账户余额后重试`, 'warn');
  if (failed) log(`${failed} 条没生成出来（已如实记成「未生成」，报告里逐行写明了原因）`, 'warn');
  if (frameUsed) log(`${frameUsed} 条素材只有视频 ⇒ 已从视频里抽帧送去（每条最多 ${cfg.videoFrames} 帧，本机抽、不落素材目录）`, 'info');
  if (frameFail) log(`有 ${frameFail} 条视频没能抽出可用帧（${frameErr || '原因不明'}）⇒ 那几条标题只能按货号/颜色写`, 'warn');
  if (noImage && vision) log(`有 ${noImage} 条没能给出可用的图（没有实拍图，或视频里没抽出帧）⇒ 那几条标题只能按货号/颜色写`, 'warn');
  if (topicStripped) log(`${topicStripped} 条的正文结尾模型自己带了 #话题，已去掉（话题由程序按计划追加到文案末尾）`, 'info');
  if (topicAppended) log(`${topicAppended} 条已把话题并进文案末尾（一个话题单独一行，连 # 一起写）`, 'info');
  log(`文案生成完成：${rows.length} 篇${llmOn ? '' : '（本地模板，不是 AI 文案）'}`, llmOn ? 'ok' : 'warn');
  return {
    rows, warning: plan.warning, llm: llmOn,
    apiUsage: apiusage.aggregate(apiRequests),
    genSource: llmOn ? (vision ? 'AI 看图' : 'AI 文字') : '本地模板',
    modelId: pf ? pf.modelId : '', modelHow: pf ? pf.modelHow : '',
    endpoint: cfg.endpoint, endpointSource: cfg.endpointSource,
    vision, failed, visionOff, topicStripped, topicAppended, noImage, frameUsed, frameFail
  };
}

module.exports = {
  FORMATS, ANGLES, buildPlan, topicCombos, parseTopics, normTopic, topicsFromPrompt, topicPool,
  DEFAULT_TOPIC_POOL, MAX_TOPIC_COLS, generate, buildSystem,
  // 接口自检与配置（界面「接口自检」按钮 / 测试都要直接调，别在别处再复制一份）
  cfgOf, urlsOf, preflight, listModels, pickModel, imageCapability, normModel,
  // 看图与正文清理
  imagePartsOf, stripTrailingTopics, appendTopics, extractJson, unescapeNewlines
};
