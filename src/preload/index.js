'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (ch, cb) => {
  const listener = (_e, ...args) => cb(...args);
  ipcRenderer.on(ch, listener);
  return () => ipcRenderer.removeListener(ch, listener);
};

contextBridge.exposeInMainWorld('api', {
  info: () => ipcRenderer.invoke('app:info'),

  authStatus: () => ipcRenderer.invoke('auth:status'),
  authLogin: (u, p, remember) => ipcRenderer.invoke('auth:login', u, p, remember),
  authLogout: () => ipcRenderer.invoke('auth:logout'),
  authChangePwd: (oldP, newP) => ipcRenderer.invoke('auth:change-password', oldP, newP),
  authUsers: () => ipcRenderer.invoke('auth:users'),
  authCreateUser: input => ipcRenderer.invoke('auth:create-user', input),
  authUpdateUser: (id, patch) => ipcRenderer.invoke('auth:update-user', id, patch),
  authResetPwd: (id, newP) => ipcRenderer.invoke('auth:reset-password', id, newP),
  authRemoveUser: id => ipcRenderer.invoke('auth:remove-user', id),

  brandList: () => ipcRenderer.invoke('brand:list'),
  brandAdd: input => ipcRenderer.invoke('brand:add', input),
  brandUpdate: (id, patch) => ipcRenderer.invoke('brand:update', id, patch),
  brandPrompts: (id, patch) => ipcRenderer.invoke('brand:prompts', id, patch),
  brandRemove: id => ipcRenderer.invoke('brand:remove', id),
  statsQuery: opts => ipcRenderer.invoke('stats:query', opts),
  statsExport: opts => ipcRenderer.invoke('stats:export', opts),

  updateStatus: () => ipcRenderer.invoke('update:status'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  updateSetChannel: next => ipcRenderer.invoke('update:set-channel', next),
  updateSetLog: on => ipcRenderer.invoke('update:set-log', on),
  onUpdate: cb => on('update:changed', cb),

  configGet: key => ipcRenderer.invoke('config:get', key),
  configSet: patch => ipcRenderer.invoke('config:set', patch),
  projectGet: () => ipcRenderer.invoke('project:get'),
  logHistory: () => ipcRenderer.invoke('log:history'),
  logExport: payload => ipcRenderer.invoke('log:export', payload),

  run: (type, args) => ipcRenderer.invoke('job:run', type, args),
  cancel: type => ipcRenderer.invoke('job:cancel', type),
  busy: type => ipcRenderer.invoke('job:busy', type),

  pickDir: opts => ipcRenderer.invoke('dialog:dir', opts),
  pickFile: opts => ipcRenderer.invoke('dialog:file', opts),
  openPath: p => ipcRenderer.invoke('shell:open', p),
  reveal: p => ipcRenderer.invoke('shell:reveal', p),

  themeGet: () => ipcRenderer.invoke('theme:get'),
  themeSet: s => ipcRenderer.invoke('theme:set', s),

  min: () => ipcRenderer.send('win:min'),
  toggleMax: () => ipcRenderer.send('win:toggle-max'),
  close: () => ipcRenderer.send('win:close'),
  isMax: () => ipcRenderer.invoke('win:is-max'),
  flash: () => ipcRenderer.send('win:flash'),
  fitGate: h => ipcRenderer.send('win:fit-gate', h),

  onJobStart: cb => on('job:started', cb),
  onJobProgress: cb => on('job:progress', cb),
  onJobDone: cb => on('job:done', cb),
  onLog: cb => on('log:entry', cb),
  onProject: cb => on('project:changed', cb),
  onTheme: cb => on('theme:changed', cb),
  onMaxChange: cb => on('win:max', cb),
  onPublishRow: cb => on('publish:row', cb)
});
