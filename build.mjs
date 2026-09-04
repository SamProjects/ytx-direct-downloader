import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8'));
const version = packageJson.version;
const isGreasyBuild = process.argv.includes('--greasy');
const repository = 'SamProjects/ytx-direct-downloader';
let releaseCommit = process.env.YTX_RELEASE_COMMIT || '';

if (isGreasyBuild) {
  let currentCommit;
  try {
    ({ stdout: currentCommit } = await execFileAsync('git', ['rev-parse', 'HEAD']));
    currentCommit = currentCommit.trim();
  } catch {
    throw new Error('Greasy Fork build must run inside a Git checkout.');
  }

  if (!releaseCommit) releaseCommit = currentCommit;
  if (!/^[a-f0-9]{40}$/i.test(releaseCommit)) {
    throw new Error('YTX_RELEASE_COMMIT must be a real 40-character Git commit SHA.');
  }
  if (releaseCommit !== currentCommit) {
    throw new Error(`YTX_RELEASE_COMMIT must match the current HEAD (${currentCommit}).`);
  }
  try {
    await execFileAsync('git', ['cat-file', '-e', `${releaseCommit}^{commit}`]);
  } catch {
    throw new Error(`Git commit does not exist locally: ${releaseCommit}`);
  }
}

const baseMetadata = `// ==UserScript==
// @name         Youtube和X（Twitter）直连下载（免跳转第三方）
// @namespace    haiwaidao.local.ytx-downloader
// @version      ${version}
// @description  YouTube/X direct downloader. No third-party parser service. High-resolution YouTube streams are remuxed locally in the browser.
// @license      MIT
// @homepageURL  https://github.com/${repository}
// @supportURL   https://github.com/${repository}/issues
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
`;

const commonBuildOptions = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120', 'edge120'],
  conditions: ['browser', 'module', 'import'],
  mainFields: ['browser', 'module', 'main'],
  treeShaking: true,
  sourcemap: false,
  define: {
    global: 'globalThis'
  }
};

async function buildVendor(entryPoint, outfile) {
  await build({
    ...commonBuildOptions,
    entryPoints: [entryPoint],
    outfile,
    minify: true,
    legalComments: 'eof'
  });
}

async function sha256Base64(file) {
  const bytes = await fs.readFile(file);
  return crypto.createHash('sha256').update(bytes).digest('base64');
}

await fs.mkdir('dist', { recursive: true });
await fs.mkdir('vendor', { recursive: true });

const vendorFiles = {
  youtube: 'vendor/ytx-youtube-runtime.js',
  mediabunny: 'vendor/ytx-mediabunny-runtime.js'
};

await buildVendor('src/vendor/youtube-runtime.js', vendorFiles.youtube);
await buildVendor('src/vendor/mediabunny-runtime.js', vendorFiles.mediabunny);

if (isGreasyBuild) {
  try {
    await execFileAsync('git', [
      'ls-files', '--error-unmatch', vendorFiles.youtube, vendorFiles.mediabunny
    ]);
    await execFileAsync('git', ['diff', '--quiet', 'HEAD', '--', 'vendor']);
  } catch {
    throw new Error(
      'Greasy Fork build requires the generated vendor/ files to be committed '
      + 'in the current Git commit before building.'
    );
  }
}

let metadata = `${baseMetadata}// @run-at       document-start\n`;
let plugins = [];
let minify;

if (isGreasyBuild) {
  const vendorBase = `https://cdn.jsdelivr.net/gh/${repository}@${releaseCommit}/vendor`;
  const youtubeHash = await sha256Base64(vendorFiles.youtube);
  const mediabunnyHash = await sha256Base64(vendorFiles.mediabunny);
  metadata = `${baseMetadata}`
    + `// @require      ${vendorBase}/ytx-youtube-runtime.js#sha256=${youtubeHash}\n`
    + `// @require      ${vendorBase}/ytx-mediabunny-runtime.js#sha256=${mediabunnyHash}\n`
    + '// @run-at       document-start\n'
    + '// ==/UserScript==';
  plugins = [{
    name: 'greasy-runtime-alias',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^\.\/(?:runtime|media-runtime)\.js$/ }, (args) => {
        if (args.path === './runtime.js') {
          return { path: path.resolve('src/runtime.greasy.js') };
        }
        return { path: path.resolve('src/media-runtime.greasy.js') };
      });
    }
  }];
  minify = false;
} else {
  metadata += '// ==/UserScript==';
  minify = true;
}

const outfile = isGreasyBuild
  ? 'dist/ytx-direct-downloader.greasy.user.js'
  : 'dist/ytx-direct-downloader.user.js';

await build({
  ...commonBuildOptions,
  entryPoints: ['src/main.js'],
  outfile,
  minify,
  legalComments: 'eof',
  plugins,
  banner: { js: metadata }
});

console.log(`Built: ${outfile}`);
if (!isGreasyBuild) {
  console.log('The Greasy Fork variant is built with: YTX_RELEASE_COMMIT=<40-char-sha> npm run build:greasy');
}
