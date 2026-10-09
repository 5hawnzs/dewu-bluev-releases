'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const s = require('../src/main/security');
let count = 0;
function check(label, fn) { fn(); count++; console.log('PASS  ' + label); }
(async () => {
  const frame = { url: s.ENTRY };
  check('只接受本地入口的主框架 IPC', () => assert(s.trustedSender({ senderFrame: frame, sender: { mainFrame: frame } })));
  check('拒绝伪造的远程页面和子框架 IPC', () => {
    assert(!s.trustedSender({ senderFrame: { url: s.ENTRY }, sender: { mainFrame: frame } }));
    const remote = { url: 'https://attacker.invalid/' };
    assert(!s.trustedSender({ senderFrame: remote, sender: { mainFrame: remote } }));
    assert(!s.trustedSender({}));
  });
  check('配置原型污染与过深对象被拦截', () => {
    assert.throws(() => s.assertSafeTree(JSON.parse('{"copy":{"__proto__":{"polluted":true}}}')));
    assert.throws(() => s.assertSafeTree({ a: [{ constructor: {} }] }));
    let nested = {}; for (let i = 0; i < 26; i++) nested = { a: nested };
    assert.throws(() => s.assertSafeTree(nested));
  });
  check('成员不能改品牌、云目标、外部程序或注入对象值', () => {
    for (const payload of [{ brands: [] }, { cloud: { url: 'https://attacker.invalid' } },
      { publish: { adbPath: 'attack.exe' } }, { copy: { concurrency: [] } }, { copy: { concurrency: { evil: 1 } } }]) {
      assert.throws(() => s.validateConfigPatch(payload, false));
    }
    assert.throws(() => s.validateConfigPatch({ brands: [] }, true));
  });
  check('成员仍可编辑文案模型与发布间隔，管理员可配置程序路径', () => {
    s.validateConfigPatch({ copy: { llm: { model: 'model', vision: false } }, publish: { intervalSec: 0 } }, false);
    s.validateConfigPatch({ publish: { adbPath: 'C:\\adb.exe', ffmpegPath: '' } }, true);
  });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bluev-security-'));
  try {
    fs.writeFileSync(path.join(tmp, 'attack.cmd'), '@echo attack');
    fs.writeFileSync(path.join(tmp, 'report.xlsx'), 'test');
    assert(!await s.canOpenPath(path.join(tmp, 'attack.cmd')));
    assert(await s.canOpenPath(path.join(tmp, 'report.xlsx')));
    assert(await s.canOpenPath(tmp));
    assert(!await s.canOpenPath('relative.xlsx'));
    console.log('PASS  拒绝执行脚本，保留打开报告和目录'); count++;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  check('禁止窗口跳转、弹窗、webview 和浏览器权限', () => {
    const listeners = {}; let open, request, permission;
    s.protectWindow({ setWindowOpenHandler: fn => { open = fn; }, on: (key, fn) => { listeners[key] = fn; },
      session: { setPermissionRequestHandler: fn => { request = fn; }, setPermissionCheckHandler: fn => { permission = fn; } } });
    assert.strictEqual(open().action, 'deny');
    for (const key of ['will-navigate', 'will-attach-webview']) { let denied = false; listeners[key]({ preventDefault: () => { denied = true; } }); assert(denied); }
    request(null, 'media', allowed => assert.strictEqual(allowed, false));
    assert.strictEqual(permission(), false);
  });
  console.log(`全部通过 ${count} 项安全检查`);
})().catch(e => { console.error(e); process.exit(1); });
