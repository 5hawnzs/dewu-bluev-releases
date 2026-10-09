'use strict';
const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs').promises;
const ENTRY = pathToFileURL(path.join(__dirname, '../renderer/index.html')).href;
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

// 对象合并前检查完整树；不能只检查第一层，数组里也可能藏有危险键。
function assertSafeTree(value, depth = 0) {
  if (depth > 24) throw new Error('配置嵌套过深');
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (BAD_KEYS.has(key)) throw new Error('配置包含不安全字段');
    assertSafeTree(value[key], depth + 1);
  }
}

function trustedSender(event) {
  const frame = event && event.senderFrame;
  return !!(frame && event.sender && frame === event.sender.mainFrame && frame.url === ENTRY);
}

const EDITABLE = new Set([
  'paths.output', 'paths.rejected', 'copy.requiredTopic', 'copy.extraTopics',
  'copy.concurrency', 'copy.defaultBrandId', 'verify.mode', 'verify.api.endpoint',
  'verify.api.apiKey', 'publish.device', 'publish.intervalSec',
  'publish.intervalMinSec', 'publish.intervalMaxSec'
]);
const LLM = new Set(['enabled', 'endpoint', 'apiKey', 'model', 'temperature', 'vision',
  'imageCount', 'imageMaxSide', 'timeoutSec', 'videoFrames']);
const ADMIN = new Set(['publish.adbPath', 'publish.ffmpegPath']);

function validateConfigPatch(patch, isAdmin) {
  assertSafeTree(patch);
  if (!patch || Array.isArray(patch) || typeof patch !== 'object') throw new Error('配置格式不正确');
  if (JSON.stringify(patch).length > 65536) throw new Error('配置内容过大');
  const walk = (value, prefix) => {
    for (const [key, v] of Object.entries(value)) {
      const field = prefix ? prefix + '.' + key : key;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        if (!['paths', 'copy', 'copy.llm', 'verify', 'verify.api', 'publish'].includes(field)) {
          throw new Error('此配置只能通过专用入口修改');
        }
        walk(v, field);
      } else {
        const llmKey = field.startsWith('copy.llm.') && LLM.has(field.slice(9));
        if (!EDITABLE.has(field) && !llmKey && !(isAdmin && ADMIN.has(field))) {
          throw new Error('此配置只能通过专用入口修改');
        }
        if (!['string', 'number', 'boolean'].includes(typeof v)
          || (typeof v === 'number' && !Number.isFinite(v))) throw new Error('配置值格式不正确');
      }
    }
  };
  walk(patch, '');
}

async function canOpenPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value)) return false;
  // 只打开目录和本应用生成的数据文件，避免 shell 执行脚本、快捷方式或程序。
  if (process.platform === 'win32' && value.slice(2).includes(':')) return false;
  try {
    const stat = await fs.stat(value);
    return stat.isDirectory() || (stat.isFile() && new Set([
      '.xlsx', '.csv', '.tsv', '.txt', '.log', '.json', '.jpg', '.jpeg', '.png', '.mp4'
    ]).has(path.extname(value).toLowerCase()));
  } catch (_) { return false; }
}

function protectWindow(contents) {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', event => event.preventDefault());
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);
}

module.exports = { assertSafeTree, trustedSender, validateConfigPatch, canOpenPath, protectWindow, ENTRY };
