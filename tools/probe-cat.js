'use strict';
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync('C:/Users/Admin/Doubao/chats/2026-11-14/new-chat/_apk/x/assets/js/lib/cat.js', 'utf8');

const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  TextEncoder, TextDecoder, URL, URLSearchParams, Buffer,
  globalThis: null
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
try {
  vm.runInContext(src, sandbox, { filename: 'cat.js', timeout: 5000 });
  console.log('LOADED OK');
  console.log('keys:', Object.keys(sandbox).filter(k => !['console','setTimeout','clearTimeout','setInterval','clearInterval','TextEncoder','TextDecoder','URL','URLSearchParams','Buffer','globalThis'].includes(k)));
  const g = sandbox.globalThis;
  for (const k of ['js','spider','Cms','req','_http','js2java','local','base64','md5']) {
    console.log(k, typeof sandbox[k], typeof g[k]);
  }
} catch (e) {
  console.log('LOAD ERROR:', e.message);
  const m = /^([A-Za-z_$][\w$]*) is not defined/.exec(e.message);
  console.log('missing:', m && m[1]);
}
