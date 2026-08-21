# YT + X Direct Downloader（Local Remux）

一个面向 YouTube 和 X 的 Tampermonkey 用户脚本。项目源码公开在 GitHub，发布到 Greasy Fork 的是经过依赖打包和压缩后的单文件 userscript。

## 功能概览

- YouTube：支持普通直链、独立视频/音频流、SABR/UMP 流，并在浏览器内使用 Mediabunny 无损封装。
- X：支持普通 MP4、DASH/fMP4 和 HLS（`m3u8`）；初始化片段、单独音频和不可用的播放器请求会自动隐藏。
- 下载按钮位于 YouTube 视频下方操作栏，以及 X 每条视频区域下方。
- 大文件通过 File System Access API 流式写入磁盘，不需要把完整文件一次性放进内存。
- 不调用第三方解析站，不使用运行时 `@require` 或 CDN。

## Greasy Fork 用户使用说明

### 安装

1. 安装最新版 Tampermonkey。
2. 在 [Greasy Fork](https://greasyfork.org/zh-CN) 页面安装本脚本，或者从 GitHub Releases 下载 `ytx-direct-downloader.user.js` 后拖入 Tampermonkey。
3. 安装后刷新 YouTube 或 X 页面。

脚本只匹配以下网站：

- `youtube.com` / `m.youtube.com`
- `x.com` / `twitter.com`

### YouTube 使用

打开视频后，点击视频下方操作栏的“高清下载”。1080p 及以上画质通常是独立视频轨和音频轨，脚本会在浏览器内合并。若页面只显示 360p：

1. 在 YouTube 播放器中手动选择目标画质。
2. 播放几秒钟。
3. 关闭并重新打开下载面板，或点击“刷新”。

### X 使用

在包含视频的推文下方点击“视频下载”。建议先让目标视频完整播放几秒，再打开面板或点击“刷新”。

X 播放器会产生初始化片段、范围请求、单独音频和 HLS 清单。它们不是完整文件，脚本会自动过滤，只显示可以直接保存或在浏览器内封装的资源。

如果文件名无法从媒体响应中取得，脚本会使用“上传者 ID_状态 ID_分辨率”的格式，不会再使用页面标题“主页”等名称。

### 权限和网络范围

脚本需要 Tampermonkey 提供 `GM_xmlhttpRequest`、`GM_download` 和 `unsafeWindow` 权限。运行时主动访问的域名限制为：

- `youtube.com` / `*.youtube.com`
- `youtubei.googleapis.com`
- `googlevideo.com` / `*.googlevideo.com`
- `video.twimg.com`

不会访问第三方视频解析站、广告站、统计站或返利链接。

## 为什么发布文件需要压缩

本项目不使用运行时 CDN 或 `@require`，因此 `youtubei.js`、`googlevideo` 和 `mediabunny` 都必须在构建时打包进一个 userscript 文件。未压缩的 bundle 体积较大，可能超过 Greasy Fork 的 `2 MiB（2097152 字节）`代码长度限制。

构建配置使用 esbuild：

- `bundle: true`：把运行时依赖合并到单个文件，安装后不依赖外部 CDN。
- `minify: true`：删除无用空白和开发期代码结构，降低上传和加载体积。
- `sourcemap: false`：发布文件不附带源码映射，避免进一步增大体积。
- `legalComments: 'eof'`：将依赖的许可证注释放到文件末尾，保留必要的开源声明。

压缩只作用于发布产物，GitHub 中的 `src/main.js` 仍然是可阅读、可自行修改的源码。当前发布文件约为 `1.18 MiB`，低于 Greasy Fork 限制。

## 本地构建

### 环境要求

- Node.js 20 或更高版本
- npm

### 安装依赖并构建

在项目根目录执行：

```bash
npm ci
npm run build
```

构建产物：

```text
dist/ytx-direct-downloader.user.js
```

`dist/` 和 `node_modules/` 已加入 `.gitignore`。也就是说，普通源码提交不需要提交依赖目录和构建产物；需要发布或测试时，在本地重新执行 `npm run build` 即可。

### 本地检查

```bash
node --check src/main.js
node --check build.mjs
node --check dist/ytx-direct-downloader.user.js
```

构建脚本会自动从 `package.json` 读取版本号，并写入 userscript 的 `@version`，不需要再手动同步 `build.mjs` 中的版本。

## GitHub Actions 自动构建并发布 Release

工作流文件位于：

```text
.github/workflows/build-release.yml
```

它只在推送符合 `v*.*.*` 的 Git 标签时运行，例如 `v0.1.19`。工作流会：

1. 检出源码。
2. 安装 Node.js 和锁定版本的 npm 依赖。
3. 检查 Git 标签版本是否与 `package.json` 一致。
4. 执行 `npm run build`。
5. 运行语法检查和 Greasy Fork 2 MiB 体积检查。
6. 生成 SHA-256 校验文件。
7. 将 userscript 和校验文件上传到 GitHub Release。

### 发布新版本

例如发布 `0.1.19`：

```bash
npm version 0.1.19 --no-git-tag-version
npm run build

git add package.json package-lock.json build.mjs README.md LICENSE .github/workflows/build-release.yml
git commit -m "release: v0.1.19"
git tag v0.1.19
git push origin main   # 如果默认分支不是 main，请替换为实际分支名
git push origin v0.1.19
```

推送标签后，GitHub Actions 会自动创建对应的 Release。标签名必须以 `v` 开头，并且去掉 `v` 后与 `package.json` 的版本完全一致。

## Greasy Fork 发布说明

### 应上传哪个文件

Greasy Fork 的“代码”区域应填写构建后的单文件：

```text
dist/ytx-direct-downloader.user.js
```

不要把 `src/main.js` 直接粘贴到 Greasy Fork。源码依赖多个 npm 包，直接上传源码不能运行；也不要上传整个项目目录、`node_modules` 或未压缩 bundle。

构建文件头部已经包含 Greasy Fork 所需的元数据，包括：

```javascript
// @name         YT + X Direct Downloader (Local Remux)
// @version      0.1.19
// @license      MIT
```

如果 Greasy Fork 提示“Code 过长”，请确认上传的是 `dist/ytx-direct-downloader.user.js`，并先执行 `npm run build`。当前构建配置已经启用压缩，发布文件应低于 2 MiB。

### Greasy Fork 页面简介（可直接使用）

> 面向 YouTube 和 X 的本地下载 userscript。
>
> YouTube 支持普通格式、独立视频/音频流和部分 SABR/UMP 流；X 支持普通 MP4、DASH/fMP4 和 HLS。需要合并的视频和音频会在浏览器内使用 Mediabunny 无损封装，不调用第三方解析站。
>
> 下载按钮位于 YouTube 视频下方操作栏和 X 视频区域下方。脚本会过滤初始化片段、单独音频和播放器临时请求，并使用媒体文件名或“上传者 ID_状态 ID_分辨率”生成保存名。
>
> 运行时网络仅允许 YouTube、Googlevideo 和 video.twimg.com。高画质 YouTube 视频可能需要先在播放器中选择画质并播放几秒，再刷新下载面板。

### Greasy Fork 更新

发布新版本时：

1. 修改 `package.json` 版本号。
2. 运行 `npm run build`。
3. 创建并推送对应的 `vX.Y.Z` 标签。
4. 从 GitHub Release 下载新的 `dist/ytx-direct-downloader.user.js`，并在 Greasy Fork 编辑页替换脚本代码；GitHub Release 不会自动修改已经发布到 Greasy Fork 的脚本，除非你另外配置了同步方式。

不要手动删除 userscript 头部的 `@version`、`@license`、`@grant` 和 `@connect`，否则 Greasy Fork 或 Tampermonkey 可能无法正确识别脚本。

## 已知限制

- YouTube 内部 API、签名算法和反自动化措施可能变化，后续可能需要升级 `youtubei.js`。
- 某些年龄限制、付费、DRM、直播和 Post-Live-DVR 内容不在目标范围内。
- SABR 是否可用取决于当前 YouTube 响应、播放器会话和可选格式元数据。
- X 时间线同时播放多个视频时，建议在单条推文详情页使用，以减少混入其他视频资源的可能。
- 项目只做 remux，不重新编码；最终容器格式由视频和音频编码的兼容性决定。

## 依赖

- [youtubei.js](https://github.com/LuanRT/YouTube.js) 18.0.0（MIT）
- [googlevideo](https://github.com/LuanRT/googlevideo) 4.1.1（MIT）
- [mediabunny](https://github.com/Vanilagy/mediabunny) 1.52.3（MPL-2.0）
- [esbuild](https://github.com/evanw/esbuild) 0.28.0（MIT，仅用于构建）

## 许可证

本项目源码采用 MIT License 开源，详见 [LICENSE](LICENSE)。项目依赖分别遵循其各自许可证；发布或再分发时请同时保留相关许可证与版权声明。
