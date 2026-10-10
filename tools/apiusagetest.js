'use strict';
const usage = require('../src/main/services/apiusage');
let bad = 0;
function ok(name, value, detail) {
  console.log((value ? 'PASS  ' : 'FAIL  ') + name + (detail ? ' → ' + detail : ''));
  if (!value) bad++;
}

const offpeak = usage.requestUsage({ prompt_tokens: 100, completion_tokens: 50, prompt_cache_hit_tokens: 10 },
  'deepseek-flash', 'https://api.deepseek.com/v1/chat/completions', 'image', Date.parse('2026-10-10T04:00:00Z'));
ok('解析 provider usage 并按缓存命中/未命中计数', offpeak.inputTokens === 100 && offpeak.cachedInputTokens === 10
  && offpeak.outputTokens === 50 && offpeak.mediaKind === 'image', JSON.stringify(offpeak));
ok('周末低峰价估算命中缓存及输出费用', offpeak.rateBand === 'offpeak' && offpeak.costCny === 0.0002902, String(offpeak.costCny));
const peak = usage.requestUsage({ prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 10 } },
  'deepseek-flash', 'https://api.deepseek.com/v1/chat/completions', 'video', Date.parse('2026-10-09T02:00:00Z'));
ok('工作日高峰按高峰费率计算', peak.rateBand === 'peak' && peak.costCny === 0.0005804, String(peak.costCny));
const unknown = usage.requestUsage({ prompt_tokens: 1, completion_tokens: 1 }, 'custom-model', 'https://gateway.example/v1', 'text');
ok('空用量对象不能伪装成零token和零费用',usage.requestUsage({}, 'deepseek-flash', 'https://api.deepseek.com', 'text') === null);
ok('支持明确返回的input/output token字段',usage.requestUsage({input_tokens:12,output_tokens:3},'custom-model','https://gateway.example','text').inputTokens===12);
ok('自定义接口/未知模型保留 token、不乱猜费用', unknown.costCny === null && unknown.rateBand === 'unknown');
const summary = usage.aggregate([offpeak, peak, unknown]);
ok('任务汇总分别保留图文、视频、文本用量且未知费用置未识别', summary.requests === 3 && summary.inputTokens === 201
  && summary.outputTokens === 101 && summary.byMedia.image.requests === 1 && summary.byMedia.video.requests === 1
  && summary.byMedia.text.requests === 1 && summary.costKnown === false, JSON.stringify(summary));
if (bad) process.exitCode = 1;
