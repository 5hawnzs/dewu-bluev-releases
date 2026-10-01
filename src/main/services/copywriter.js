'use strict';
/**
 * ③ 文案生成
 * PRD 要点：
 *   - 把「选择」交给代码，「写作」交给模型：标题格式 / 叙事视角 / 话题组合本地定死（代码保证去重）
 *   - 并发按路数均分，而不是「15 条/批」切批（尾批会把整体拖慢）
 *   - 结构化输出必须容错解析：markdown 代码块、中文标点、多余逗号都不能让整批失败
 *   - 单条重试，不整批失败
 */
const store = require('../store');

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

function topicPool() {
  const p = store.get('copy.pool');
  if (Array.isArray(p) && p.length) return p;
  if (p && p.品类) return p.品类;
  return ['#TW男装', '#男生穿搭', '#OOTD', '#秋冬新款', '#质感生活', '#日常搭配'];
}

/** 生成话题组合（去重由代码保证）；池子容量不够时明确告警 */
function topicCombos(count) {
  const pool = topicPool();
  const required = store.get('copy.requiredTopic') || pool[0];
  const extra = store.get('copy.extraTopics') || 4;
  const rest = pool.filter(t => t !== required);
  const combos = [];
  const seen = new Set();
  const pick = (arr, k, start) => {
    const out = [];
    for (let i = 0; i < k; i++) out.push(arr[(start + i) % arr.length]);
    return out;
  };
  for (let s = 0; s < rest.length; s++) {
    const c = [required].concat(pick(rest, extra, s));
    const key = c.slice().sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    combos.push(c);
  }
  if (combos.length < count) {
    // 容量不足：跨品类/滑动窗口补足，并允许重复但标记
    let s = 0;
    while (combos.length < count && s < 200) {
      const c = [required].concat(pick(rest, extra, s++));
      combos.push(c);
    }
    return { combos, warning: `话题池容量不足：${rest.length} 个可选话题只能凑 ${combos.length} 种组合，${count} 篇会出现重复，建议扩充话题池` };
  }
  return { combos, warning: null };
}

/** 本地先定好每篇的「选择」，模型只填空 */
function buildPlan(items) {
  const { combos, warning } = topicCombos(items.length);
  const rotate = store.get('copy.rotateStrategy') || 'F01-F10 轮换';
  const random = rotate === '随机';
  return {
    warning,
    rows: items.map((it, i) => {
      const fi = random ? Math.floor(Math.random() * FORMATS.length) : i % FORMATS.length;
      const ai = random ? Math.floor(Math.random() * ANGLES.length) : (i * 3) % ANGLES.length;
      return {
        id: it.id,
        format: FORMATS[fi].code,
        formatName: FORMATS[fi].name,
        formatHint: FORMATS[fi].hint,
        angle: ANGLES[ai].key,
        anglePhrase: ANGLES[ai].phrase,
        topics: combos[i % combos.length]
      };
    })
  };
}

function localFill(item, plan) {
  const c = item.color || '这款';
  const f = FORMATS.find(x => x.code === plan.format) || FORMATS[0];
  const title = f.tpl(c);
  const body = `${c}这件从${plan.angle}角度看，${plan.anglePhrase}。${f.hint}，日常搭配难度很低，衣柜里很省心。`;
  return { title, body };
}

function extractJson(text) {
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  s = s.replace(/，/g, ',').replace(/：/g, ':')
    .replace(/[“”「」]/g, '"').replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(s);
}

/** 没有品牌层时（免登录 / 测试直调）的兜底角色设定 */
const ROLE_FALLBACK = '你是得物蓝V账号的文案写手。';

/**
 * 拼 system：品牌自己的模板在前（角色 / 调性 / 写什么），代码固定的输出约束在后。
 * 分开是有意的 —— 写模板的人只管内容；JSON 字段名、字数上限这些**解析器依赖的硬约束由代码兜住**，
 * 漏写一句就会让整批 JSON.parse 失败，而失败原因看起来像「模型不听话」。
 */
function buildSystem(brandPrompt, f, plan) {
  const head = String(brandPrompt || '').trim() || ROLE_FALLBACK;
  return `${head}
---
输出要求（程序追加，别删）：
只输出 JSON，字段：title、body。
标题必须采用「${f.name}」写法（${f.hint}），20 字以内，不出现“最”“第一”等极限词；
正文 60-120 字，叙事视角为「${plan.angle}」，口语化，不堆砌形容词。不要输出 markdown 代码块。`;
}

async function callLLM(item, plan, brandPrompt) {
  const c = store.get('copy.llm') || {};
  if (!c.endpoint) throw new Error('未配置接口地址');
  const url = /\/chat\/completions$/.test(c.endpoint) ? c.endpoint : c.endpoint.replace(/\/+$/, '') + '/chat/completions';
  const f = FORMATS.find(x => x.code === plan.format) || FORMATS[0];
  const messages = [
    { role: 'system', content: buildSystem(brandPrompt, f, plan) },
    { role: 'user', content: JSON.stringify({ 货号: item.sku, 颜色: item.color, 已选话题: plan.topics }) }
  ];
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${c.apiKey || ''}` },
    body: JSON.stringify({ model: c.model || 'gpt-4o-mini', temperature: c.temperature ?? 0.9, messages, response_format: { type: 'json_object' } }),
    signal: AbortSignal.timeout(60000)
  });
  if (!res.ok) throw new Error(`接口返回 ${res.status}`);
  const data = await res.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  const parsed = extractJson(content || '{}');
  if (!parsed.title) throw new Error('返回缺少 title');
  return { title: String(parsed.title).slice(0, 60), body: String(parsed.body || '').slice(0, 400) };
}

/** 并发按路数均分：6 路 × ~N/6 篇，而不是切成 15 条/批 */
async function generate(items, ctx = {}) {
  const log = ctx.log || (() => {});
  const progress = ctx.progress || (() => {});
  const cancelled = ctx.cancelled || (() => {});
  const concurrency = Math.max(1, Math.min(8, store.get('copy.concurrency') || 6));
  const llmOn = !!(store.get('copy.llm') || {}).enabled;
  const plan = buildPlan(items);
  if (plan.warning) log(plan.warning, 'warn');

  // 品牌自己的文案提示词。jobs.run 已经前置拦过一次，这里是第二道 ——
  // 有人直接 require 本模块调 generate 时也必须拦住，否则「没配也能出文案」这条后门一直开着
  const brand = (ctx && ctx.brandFull) || null;
  const brandPrompt = brand ? String(brand.promptWrite || '').trim() : '';
  if (brand && !brandPrompt) {
    throw new Error(`品牌「${brand.name}」还没配「文案生成提示词」——到「文案生成 → 提示词配置」里补上再跑`);
  }
  if (llmOn) {
    log(brand ? `文案模板：品牌「${brand.name}」自己的提示词` : '文案模板：内置默认（本次没有品牌归属）', 'info');
  }

  const lanes = Array.from({ length: concurrency }, () => []);
  plan.rows.forEach((r, i) => lanes[i % lanes.length].push(r));
  log(`并发 ${concurrency} 路 · 每路 ${Math.ceil(plan.rows.length / concurrency)} 篇（按路数均分，不留尾批）`, 'info');
  if (!llmOn) log('未配置模型接口，使用本地模板填空（选择仍由代码决定）', 'warn');

  const out = new Map();
  let done = 0;

  const workOne = async (row) => {
    const item = items.find(it => it.id === row.id) || {};
    let text = null, err = null;
    for (let attempt = 0; attempt < 3 && !text; attempt++) {
      try {
        text = llmOn ? await callLLM(item, row, brandPrompt) : localFill(item, row);
      } catch (e) {
        err = e;
        if (!llmOn) break;
        if (attempt < 2) await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
      }
    }
    if (!text) {
      log(`${row.id} 生成失败（${err ? err.message : '未知'}），已回退本地模板`, 'warn');
      text = localFill(item, row);
    }
    out.set(row.id, Object.assign({}, row, { title: text.title, body: text.body, status: '已生成' }));
    done++;
    progress({ done, total: plan.rows.length, label: row.id });
  };

  await Promise.all(lanes.map(async lane => {
    for (const row of lane) {
      if (cancelled()) return;
      await workOne(row);
    }
  }));

  const rows = plan.rows.map(r => out.get(r.id) || Object.assign({}, r, localFill({ color: '' }, r), { status: '已生成' }));
  log(`文案生成完成：${rows.length} 篇${llmOn ? '' : '（本地模板）'}`, 'ok');
  return { rows, warning: plan.warning, llm: llmOn };
}

module.exports = { FORMATS, ANGLES, buildPlan, topicCombos, generate, buildSystem };
