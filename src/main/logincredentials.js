'use strict';
// 仅本机回填最近成功登录的账号密码；不上传，不以明文落盘。
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
let memory = null;
const file = () => path.join(app.getPath('userData'), 'last-login.enc');
function remember(username, password) {
  memory = { username: String(username || '').trim(), password: String(password || '') };
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      fs.rmSync(file(), { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), safeStorage.encryptString(JSON.stringify(memory)));
  } catch (_) { /* 无法持久化时只在当前进程内回填，绝不回退明文。 */ }
}
function read() {
  if (memory) return { ...memory };
  try {
    if (!safeStorage.isEncryptionAvailable()) return {};
    const value = JSON.parse(safeStorage.decryptString(fs.readFileSync(file())));
    if (typeof value.username !== 'string' || typeof value.password !== 'string') return {};
    memory = value;
    return { ...memory };
  } catch (_) { return {}; }
}
module.exports = { remember, read };
