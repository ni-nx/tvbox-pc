'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const srcPath = 'C:/Users/Admin/Doubao/chats/2026-11-14/new-chat/_apk/x/assets/js/lib/cat.js';
const mjs = path.join(__dirname, 'cat-probe.mjs');
fs.writeFileSync(mjs, fs.readFileSync(srcPath, 'utf8'), 'utf8');

import(pathToFileURL(mjs).href).then((m) => {
  console.log('exports:', Object.keys(m));
  console.log('Crypto:', Object.keys(m.Crypto || {}));
  console.log('types:', typeof m.load, typeof m.cheerio, typeof m.jp, typeof m.jpo);
  console.log('html:', Object.keys(m.html || {}).slice(0, 8));
}).catch((e) => console.log('ERR', e.message));
