'use strict';

// 只记录 token 数和费用估算，不接收提示词、生成正文、图片或密钥。
const PRICE_VERSION = 'deepseek-flash-2026-10';
const DEEPSEEK_FLASH = Object.freeze({ offpeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 }, peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 } });

function finite(value) { const n = Number(value); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0; }

function requestUsage(usage, modelId, endpoint, mediaKind, at = Date.now()) {
  if (!usage || typeof usage !== 'object') return null;
  const input = usage.prompt_tokens ?? usage.input_tokens;
  const output = usage.completion_tokens ?? usage.output_tokens;
  if (input == null || output == null || !Number.isFinite(Number(input)) || !Number.isFinite(Number(output))
    || Number(input) < 0 || Number(output) < 0) return null;
  const inputTokens = finite(input);
  const outputTokens = finite(output);
  const details = usage.prompt_tokens_details || usage.input_tokens_details || {};
  const cachedTokens = Math.min(inputTokens, finite(
    usage.prompt_cache_hit_tokens != null ? usage.prompt_cache_hit_tokens
      : (usage.cached_tokens != null ? usage.cached_tokens : details.cached_tokens)
  ));
  const kind = ['image', 'video', 'text'].includes(mediaKind) ? mediaKind : 'text';
  const model = String(modelId || '').slice(0, 80);
  let host = '';
  try { host = new URL(endpoint).hostname.toLowerCase(); } catch (_) { /* 自定义或无效地址没有已识别费率 */ }
  let band = 'unknown';
  let costCny = null;
  if (host === 'api.deepseek.com' && model === 'deepseek-flash') {
    const date = new Date(at);
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(date);
    const weekday = parts.find(x => x.type === 'weekday')?.value || '';
    const hour = Number(parts.find(x => x.type === 'hour')?.value);
    const peak = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday) && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
    band = peak ? 'peak' : 'offpeak';
    const rate = DEEPSEEK_FLASH[band];
    costCny = ((cachedTokens * rate.cacheHit)
      + ((inputTokens - cachedTokens) * rate.cacheMiss)
      + (outputTokens * rate.output)) / 1000000;
  }
  return { model, host, mediaKind: kind, inputTokens, outputTokens, cachedInputTokens: cachedTokens,
    costCny, rateBand: band, priceVersion: costCny == null ? '' : PRICE_VERSION };
}

function aggregate(requests) {
  const result = { version: 1, requests: 0, unreportedRequests: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0,
    estimatedCostCny: 0, costKnown: true, byMedia: {}, models: [] };
  const modelSet = new Set();
  for (const req of requests || []) {
    if (req && req.usageMissing === true) {
      result.requests++;
      result.unreportedRequests++;
      result.costKnown = false;
      const kind = ['image', 'video', 'text'].includes(req.mediaKind) ? req.mediaKind : 'text';
      if (!result.byMedia[kind]) result.byMedia[kind] = { requests: 0, unreportedRequests: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, estimatedCostCny: 0, costKnown: true };
      result.byMedia[kind].requests++;
      result.byMedia[kind].unreportedRequests++;
      result.byMedia[kind].costKnown = false;
      continue;
    }
    if (!req || !Number.isFinite(Number(req.inputTokens)) || !Number.isFinite(Number(req.outputTokens))) continue;
    result.requests++;
    result.inputTokens += finite(req.inputTokens);
    result.outputTokens += finite(req.outputTokens);
    result.cachedInputTokens += finite(req.cachedInputTokens);
    const cost = req.costCny == null ? NaN : Number(req.costCny);
    if (Number.isFinite(cost) && cost >= 0) result.estimatedCostCny += cost;
    else result.costKnown = false;
    const kind = ['image', 'video', 'text'].includes(req.mediaKind) ? req.mediaKind : 'text';
    if (!result.byMedia[kind]) result.byMedia[kind] = { requests: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, estimatedCostCny: 0, costKnown: true };
    const b = result.byMedia[kind];
    b.requests++;
    b.inputTokens += finite(req.inputTokens);
    b.outputTokens += finite(req.outputTokens);
    b.cachedInputTokens += finite(req.cachedInputTokens);
    if (Number.isFinite(cost) && cost >= 0) b.estimatedCostCny += cost;
    else b.costKnown = false;
    if (req.model) modelSet.add(String(req.model).slice(0, 80));
  }
  result.estimatedCostCny = Number(result.estimatedCostCny.toFixed(8));
  for (const b of Object.values(result.byMedia)) b.estimatedCostCny = Number(b.estimatedCostCny.toFixed(8));
  result.models = [...modelSet].slice(0, 8);
  return result;
}

module.exports = { PRICE_VERSION, requestUsage, aggregate };
