# Youtube和X（Twitter）直连下载（免跳转第三方）

一个面向 YouTube 和 X 的 Tampermonkey 用户脚本。项目源码公开在 GitHub；GitHub Release 提供独立单文件版，Greasy Fork 使用主逻辑可阅读、仅将大型依赖外置的版本。

## 功能概览

- YouTube：支持普通直链、独立视频/音频流、SABR/UMP 流，并在浏览器内使用 Mediabunny 无损封装。
- X：支持普通 MP4、DASH/fMP4 和 HLS（`m3u8`）；初始化片段、单独音频和不可用的播放器请求会自动隐藏。
- 下载按钮位于 YouTube 普通视频下方操作栏、Shorts 当前视频右侧操作栏，以及 X 每条视频区域下方。
- 界面自动跟随浏览器首选语言：中文（包括 `zh-CN`、`zh-TW`、`zh-HK`）显示简体中文，其他语言显示英文。更改浏览器语言后刷新页面即可生效；视频标题、文件名和服务器返回的原始错误不做翻译。
- 大文件通过 File System Access API 流式写入磁盘，不需要把完整文件一次性放进内存。
- 悬浮下载框顶部可设置单文件下载并发数（1–8 路，默认 4 路），通过 Tampermonkey 保存设置，YouTube 和 X 共用；下载任务队列仍逐个执行。
- 独立单文件版不调用第三方解析站，不使用运行时 `@require` 或 CDN；Greasy Fork 可读版只通过固定版本、带 SRI 校验的 `@require` 加载本项目公开的运行库文件。

## Greasy Fork 用户使用说明

### 安装

1. 安装最新版 Tampermonkey。
2. 打开 [GitHub 项目页面](https://github.com/SamProjects/ytx-direct-downloader)，进入 Releases 下载 `ytx-direct-downloader.user.js`，然后拖入 Tampermonkey 安装。
3. 安装后刷新 YouTube 或 X 页面。

脚本只匹配以下网站：

- `youtube.com` / `m.youtube.com`
- `x.com` / `twitter.com`

### YouTube 使用

打开普通视频后，点击视频下方操作栏的“高清下载”；打开 Shorts 后，点击当前短视频右侧操作栏中的“直接下载”。脚本会锁定点击时对应的视频 ID，避免 Shorts 预加载前后视频时选错资源。1080p 及以上画质通常是独立视频轨和音频轨，脚本会在浏览器内合并。若页面只显示 360p：

1. 在 YouTube 播放器中手动选择目标画质。
2. 播放几秒钟。
3. 关闭并重新打开下载面板，或点击“刷新”。

### X 使用

在包含视频的推文下方点击“视频下载”。建议先让目标视频完整播放几秒，再打开面板或点击“刷新”。

X 播放器会产生初始化片段、范围请求、单独音频和 HLS 清单。它们不是完整文件，脚本会自动过滤，只显示可以直接保存或在浏览器内封装的资源。

如果文件名无法从媒体响应中取得，脚本会使用“上传者 ID_状态 ID_分辨率”的格式，不会再使用页面标题“主页”等名称。

### 单文件并发下载

在下载框顶部选择“单文件下载并发数”，1 路为串行，默认 4 路，最多 8 路。设置对新加入队列的任务生效，已排队或正在运行的任务保持原设置。

- 普通 YouTube/X 直链使用 4 MiB 分块并发请求，校验每块的范围和长度后按偏移写盘，不将完整文件拼入内存；服务器不支持 Range 时按完整响应保存，总长度未知时回退串行。
- 音视频合并使用 Mediabunny 的远程读取并发上限，按每个媒体源分别计算；实际请求数量由库的读取和预取调度决定。调整设置后会刷新资源列表，让 X 的预先创建的媒体源使用新设置。
- SABR/UMP 仍由专用协议下载；不支持 File System Access API 时使用的 `GM_download` 不受此设置控制。
- 并发下载支持当前页面会话内暂停、恢复和取消，失败的分块会有限重试。遇到文件大小变化、分块异常或磁盘错误时会终止任务，避免保存损坏文件。

建议先用 4 路；并发数更高不一定更快，效果取决于 CDN、浏览器连接调度和本地带宽。

### 权限和网络范围

脚本需要 Tampermonkey 提供 `GM_xmlhttpRequest`、`GM_download`、`GM_getValue`、`GM_setValue` 和 `unsafeWindow` 权限；后两项用于保存并发设置。运行时主动访问的域名限制为：

- `youtube.com` / `*.youtube.com`
- `youtubei.googleapis.com`
- `googlevideo.com` / `*.googlevideo.com`
- `video.twimg.com`

不会访问第三方视频解析站、广告站、统计站或返利链接。

## 两种构建产物

项目提供两种发布方式：

| 产物 | 用途 | 依赖方式 | 主脚本是否可读 |
| --- | --- | --- | --- |
| `dist/ytx-direct-downloader.user.js` | GitHub Release、个人本地安装 | 所有依赖打包在单文件中 | 否，使用压缩版 |
| `dist/ytx-direct-downloader.greasy.user.js` | Greasy Fork | 通过带 SRI 校验的 `@require` 加载库 | 是 |

### 为什么独立版使用压缩

独立版不使用运行时 `@require` 或 CDN，因此 `youtubei.js`、`googlevideo` 和 `mediabunny` 必须一起打包。未压缩 bundle 超过 Greasy Fork 的 `2 MiB（2097152 字节）`限制，所以独立版使用 esbuild 压缩，当前约为 `1.18 MiB`。

压缩的目的只是减小独立发布文件，不是隐藏代码。GitHub 中的 `src/main.js`、运行时适配层和构建脚本仍然是可阅读源码。

### 为什么 Greasy Fork 版不压缩

Greasy Fork 要求用户能够在安装前审查主脚本，因此不接受压缩后的主脚本。Greasy Fork 版只把较大的第三方库作为外部库通过 `@require` 加载，主下载逻辑保持非压缩、可阅读，并为每个库固定 Git commit 和 SHA-256 完整性哈希。

外部库只在 userscript 初始化时加载；下载器运行期间主动访问媒体的网络白名单仍然只有 YouTube、Googlevideo 和 `video.twimg.com`。如果你不希望初始化时访问 jsDelivr，请使用独立单文件版。

构建会关闭 sourcemap，并保留依赖许可证注释。独立版依赖全部内置；Greasy Fork 版使用固定版本的外部库。

### 为什么需要项目自己的 `vendor/` 文件

Greasy Fork 版头部的两个 `@require` 文件：

```text
vendor/ytx-youtube-runtime.js
vendor/ytx-mediabunny-runtime.js
```

是本项目根据公开 npm 依赖构建出来的适配文件，不是隐藏代码，也不是第三方解析服务。它们的来源和作用如下：

| 文件 | 来源 | 作用 |
| --- | --- | --- |
| `ytx-youtube-runtime.js` | `youtubei.js` + `googlevideo` | 将 YouTube.js 和 GoogleVideo 的浏览器模块合并为一个可被 Tampermonkey 加载的脚本，并暴露下载器需要的接口 |
| `ytx-mediabunny-runtime.js` | `mediabunny` | 将 Mediabunny 的媒体封装接口暴露给下载器，用于浏览器内合并视频和音频 |

官方库并不是都能直接写进 Tampermonkey 的 `@require`：

- [YouTube.js 官方仓库](https://github.com/LuanRT/YouTube.js)提供浏览器构建，但其浏览器 bundle 是 ES Module；
- [googlevideo 官方仓库](https://github.com/LuanRT/googlevideo)主要发布 ESM 模块，没有适合传统 `@require` 的单文件全局构建；
- [Mediabunny 官方仓库](https://github.com/Vanilagy/mediabunny)提供浏览器构建文件，但本项目仍将它统一封装为自己的运行时接口，以保证独立版和 Greasy Fork 版使用相同的版本和调用方式。

因此，直接把官方 ESM 文件填入 `@require` 可能无法运行；项目的构建脚本会将它们转换为可加载的运行库。Tampermonkey 只负责在主脚本前加载这些 JavaScript 文件，并不会自动把 ESM `import` 转换成普通脚本。

这些文件完全由 [build.mjs](build.mjs) 根据 `package-lock.json` 中锁定的版本生成，源代码入口位于 `src/vendor/`，不是手工下载后改名。构建会保留依赖许可证注释；项目也在 `@require` URL 中写入固定 commit 和 SHA-256 校验值，文件被替换或篡改后 Tampermonkey 会拒绝加载。

使用者可以直接检查以下内容：

1. `package.json` 和 `package-lock.json`：确认依赖版本。
2. `src/vendor/`：确认运行库的公开构建入口。
3. `build.mjs`：确认没有调用第三方解析站，且运行库只是打包和导出接口。
4. `vendor/`：确认发布到 GitHub 的文件与构建结果一致。

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

独立单文件产物：

```text
dist/ytx-direct-downloader.user.js
```

Greasy Fork 版需要在 vendor 文件已经提交到 GitHub 后构建，并提供当前 Git commit SHA。Bash：

```bash
export YTX_RELEASE_COMMIT="$(git rev-parse HEAD)"
npm run build:greasy
```

PowerShell：

```powershell
$env:YTX_RELEASE_COMMIT = (git rev-parse HEAD)
npm run build:greasy
```

产物为：

```text
dist/ytx-direct-downloader.greasy.user.js
```

`YTX_RELEASE_COMMIT` 必须是 40 位 Git commit SHA，因为 Greasy Fork 版的 `@require` 会从该 commit 对应的 jsDelivr 地址读取 `vendor/` 库。先运行 `npm run build` 生成或更新 vendor 文件，并把它们提交到 GitHub，再运行 Greasy Fork 构建。

不要填写示例中的 `0123456789abcdef0123456789abcdef01234567` 或其他占位字符串。只有已经提交并推送到 GitHub 的真实 commit SHA 才能生成可用的 jsDelivr 地址；否则 Greasy Fork 安装时会因找不到 `vendor/` 文件而失败。

推荐直接使用 GitHub Actions Release 中生成的 Greasy Fork 版；不要使用指向尚未推送到 GitHub 的 commit 的本地临时构建文件。

`dist/` 和 `node_modules/` 已加入 `.gitignore`；`vendor/` 是 Greasy Fork 外部库的来源文件，需要提交到 GitHub。

### 本地检查

```bash
npm test
node --check src/main.js
node --check build.mjs
node --check dist/ytx-direct-downloader.user.js
node --check dist/ytx-direct-downloader.greasy.user.js
```

构建脚本会自动从 `package.json` 读取版本号，并写入 userscript 的 `@version`，不需要再手动同步 `build.mjs` 中的版本。

## GitHub Actions 自动构建并发布 Release

工作流文件位于：

```text
.github/workflows/build-release.yml
```

它只在推送符合 `v*.*.*` 的 Git 标签时运行，例如 `v0.1.21`。工作流会：

1. 检出源码。
2. 安装 Node.js 和锁定版本的 npm 依赖。
3. 检查 Git 标签版本是否与 `package.json` 一致。
4. 构建独立版和 Greasy Fork 可读版。
5. 检查 vendor 文件没有未提交的变化。
6. 运行语法检查和 Greasy Fork 2 MiB 体积检查。
7. 生成 SHA-256 校验文件。
8. 将两个 userscript 和校验文件上传到 GitHub Release。

### 发布新版本

例如发布 `0.1.21`：

```bash
npm version 0.1.21 --no-git-tag-version
npm run build

git add package.json package-lock.json build.mjs README.md LICENSE .github/workflows/build-release.yml src vendor
git commit -m "release: v0.1.21"
git tag v0.1.21
git push origin master   # 如果默认分支不是 master，请替换为实际分支名
git push origin v0.1.21
```

推送标签后，GitHub Actions 会自动创建对应的 Release。标签名必须以 `v` 开头，并且去掉 `v` 后与 `package.json` 的版本完全一致。

## Greasy Fork 发布说明

### 应上传哪个文件

Greasy Fork 的“代码”区域应填写可读版：

```text
dist/ytx-direct-downloader.greasy.user.js
```

不要上传独立压缩版 `dist/ytx-direct-downloader.user.js`，Greasy Fork 会将其判定为最小化代码。也不要把 `src/main.js` 直接粘贴到 Greasy Fork，因为它依赖 npm 模块，不能直接运行。

Greasy Fork 版的主脚本包含下载器完整逻辑，只有两个大型第三方运行库通过 `@require` 外置。外部库 URL 使用固定 commit 和 SRI 哈希，符合 Greasy Fork 对 CDN 外部代码的要求。

构建文件头部已经包含 Greasy Fork 所需的元数据，包括：

```javascript
// @name         Youtube和X（Twitter）直连下载（免跳转第三方）
// @version      0.1.21
// @license      MIT
// @require      https://cdn.jsdelivr.net/gh/SamProjects/ytx-direct-downloader@<commit>/vendor/ytx-youtube-runtime.js#sha256=<hash>
```

如果 Greasy Fork 仍提示“代码被压缩”，请确认上传的是 `ytx-direct-downloader.greasy.user.js`，而不是独立版。Greasy Fork 版主脚本约 100 KB，低于 2 MiB 限制。

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
2. 运行 `npm run build`，确认生成的 `vendor/` 文件已经提交到 GitHub。
3. 创建并推送对应的 `vX.Y.Z` 标签。
4. 从 GitHub Release 下载新的 `dist/ytx-direct-downloader.greasy.user.js`，并在 Greasy Fork 编辑页替换脚本代码；GitHub Release 不会自动修改已经发布到 Greasy Fork 的脚本，除非你另外配置了同步方式。

不要手动删除 userscript 头部的 `@version`、`@license`、`@grant` 和 `@connect`，否则 Greasy Fork 或 Tampermonkey 可能无法正确识别脚本。

## 已知限制

- YouTube 内部 API、签名算法和反自动化措施可能变化，后续可能需要升级 `youtubei.js`。
- 某些年龄限制、付费、DRM、直播和 Post-Live-DVR 内容不在目标范围内。
- SABR 是否可用取决于当前 YouTube 响应、播放器会话和可选格式元数据。
- X 时间线同时播放多个视频时，建议在单条推文详情页使用，以减少混入其他视频资源的可能。
- 项目只做 remux，不重新编码；最终容器格式由视频和音频编码的兼容性决定。

## 依赖

- [youtubei.js](https://github.com/LuanRT/YouTube.js) 18.1.0（MIT）
- [googlevideo](https://github.com/LuanRT/googlevideo) 4.1.1（MIT）
- [mediabunny](https://github.com/Vanilagy/mediabunny) 1.61.3（MPL-2.0）
- [esbuild](https://github.com/evanw/esbuild) 0.28.2（MIT，仅用于构建）

## 许可证

本项目源码采用 MIT License 开源，详见 [LICENSE](LICENSE)。项目依赖分别遵循其各自许可证；发布或再分发时请同时保留相关许可证与版权声明。
