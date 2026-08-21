import { build } from 'esbuild';
import fs from 'node:fs/promises';

const metadata = `// ==UserScript==
// @name         YT + X Direct Downloader (Local Remux)
// @namespace    haiwaidao.local.ytx-downloader
// @version      0.1.17
// @description  YouTube/X direct downloader. No third-party parser service. High-resolution YouTube streams are remuxed locally in the browser.
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        unsafeWindow
// @connect      youtube.com
// @connect      *.youtube.com
// @connect      youtubei.googleapis.com
// @connect      googlevideo.com
// @connect      *.googlevideo.com
// @connect      video.twimg.com
// @run-at       document-start
// ==/UserScript==`;

await fs.mkdir('dist', { recursive: true });

await build({
  entryPoints: ['src/main.js'],
  outfile: 'dist/ytx-direct-downloader.user.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120', 'edge120'],
  conditions: ['browser', 'module', 'import'],
  mainFields: ['browser', 'module', 'main'],
  treeShaking: true,
  minify: false,
  sourcemap: false,
  legalComments: 'inline',
  banner: { js: metadata },
  define: {
    global: 'globalThis'
  }
});

console.log('Built: dist/ytx-direct-downloader.user.js');
