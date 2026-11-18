'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tvbox', {
  httpGet: (payload) => ipcRenderer.invoke('http:get', payload),
  setIdentity: (ua, referer) => ipcRenderer.invoke('net:set-identity', { ua, referer }),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  toggleFullscreen: () => ipcRenderer.invoke('app:fullscreen'),
  onFullscreen: (cb) => ipcRenderer.on('tvbox:fullscreen', (_evt, v) => cb(!!v)),
  winControl: (action) => ipcRenderer.invoke('app:win', action),
  info: () => ipcRenderer.invoke('app:info'),
  saveFile: (payload) => ipcRenderer.invoke('file:save', payload),
  openFile: () => ipcRenderer.invoke('file:open'),
  setProxy: (rule) => ipcRenderer.invoke('net:set-proxy', rule),
  clearCache: () => ipcRenderer.invoke('cache:clear')
});

/* 本地数据落到用户目录的 json 文件里：页面跑在随机端口的本地 http 上，
   localStorage 会随端口变化而失效，接口/记录必须存磁盘才能真的留住。 */
contextBridge.exposeInMainWorld('tvboxDisk', {
  all: () => ipcRenderer.sendSync('store:all'),
  set: (key, raw) => ipcRenderer.send('store:set', key, raw),
  clear: () => ipcRenderer.send('store:clear')
});
