'use strict';
const store = require('./store');
const crypto = require('crypto');
function list() { return store.get('copy.localPrompts') || []; }
function selected() { return list().find(p => p.id === store.get('copy.promptProfileId')) || null; }
function save(id, input = {}) {
  const name = String(input.name || '').trim().slice(0, 48);
  if (!name) return { ok: false, error: '请填写品牌名称' };
  const all = list();
  if (id && !all.some(p => p.id === id)) return { ok: false, error: '提示词品牌不存在' };
  const profile = { id: id || 'local-' + crypto.randomUUID(), name, promptWrite: String(input.promptWrite || '').slice(0, 12000), local: true, enabled: true };
  store.set({ copy: { localPrompts: [...all.filter(p => p.id !== profile.id), profile] } });
  return { ok: true, brand: profile };
}
module.exports = { list, selected, save };
