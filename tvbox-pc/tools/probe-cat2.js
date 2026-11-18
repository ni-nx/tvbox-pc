'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const srcPath = 'C:/Users/Admin/Doubao/chats/2026-11-14/new-chat/_apk/x/assets/js/lib/cat.js';
const mjs = path.join(__dirname, 'cat-probe.mjs');
fs.writeFileSync(mjs, fs.readFileSync(srcPath, 'utf8'), 'utf8');

// 宿主垫片：先给最常用的几个
globalThis.http = (url, opts = {}) => ({ ok: false, status: 0, content: '', url });
globalThis._http = globalThis.http;
globalThis.req = (url, opts) => globalThis.http(url, opts);
globalThis.js2java = new Proxy({}, { get: () => (() => '') });
globalThis.local = { get: () => '', set: () => {}, del: () => {} };
globalThis.sniff = () => '';
globalThis.base64 = { encode: (s) => Buffer.from(s, 'utf8').toString('base64'), decode: (s) => Buffer.from(s, 'base64').toString('utf8') };

import(pathToFileURL(mjs).href).then((m) => {
  console.log('IMPORT OK, exports:', Object.keys(m));
  console.log('default type:', typeof m.default);
  if (m.default) console.log('default keys:', Object.keys(m.default));
}).catch((e) => {
  console.log('IMPORT ERROR:', e.message);
});
