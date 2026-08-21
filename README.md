# YT + X Direct Downloader (Local Remux)

一个只面向 YouTube 和 X 的 Tampermonkey 用户脚本源码项目。

## 设计目标

- 不使用第三方视频解析站。
- 不使用 `@require` / CDN 运行时加载代码。
- YouTube 下载地址只允许 `youtube.com` / `googlevideo.com`。
- X 下载地址只允许 `video.twimg.com`。
- YouTube 1080p/1440p/2160p 独立视频流 + 音频流在浏览器内无损 remux。
- YouTube 普通格式会经过 `Format.decipher()` 实际验证；SABR/无直接 URL 的高画质格式则使用本地 `googlevideo` SABR/UMP 客户端读取，不再把 SABR 误判成“只有 360p”。
- YouTube 会比较页面数据及多个 InnerTube 客户端，选择包含最高可下载分辨率的响应，不会因为页面先暴露了 360p 就提前停止。
- 当 YouTube 只向 API 暴露 360p、但播放器实际请求了更高画质时，脚本会从 Resource Timing 捕获同源播放会话中的 `googlevideo.com/videoplayback` 视频轨/音频轨（兼容 `itag`/`fmt` 格式编号），去除播放器临时 range 参数后交给浏览器内 remux。需要先手动选择目标画质并播放数秒。
- 如果播放器请求不出现在 Resource Timing，脚本还会在 document 主环境捕获 `fetch`/`XMLHttpRequest` 的媒体 URL；只记录允许的 `googlevideo.com` 播放地址，不修改请求内容。
- 对于 `serverAbrStreamingUrl`，脚本通过 `googlevideo` 的 SABR 客户端按选定 itag 拉取音频/视频流，再交给 Mediabunny 在浏览器内合并；SABR 请求仍通过同一个 YouTube/googlevideo 白名单 transport 发出。
- SABR 服务器地址会先经过当前 YouTube player 的 `decipher()` 处理，并优先使用页面原生 `fetch` 的 Cookie/Origin/Referer 上下文；失败时才回退到带 YouTube 客户端标识的白名单 GM transport。
- Tampermonkey 直接下载会持续显示已接收大小、百分比、完成或具体权限错误；`saveAs` 不弹窗时会说明文件可能进入浏览器默认下载目录。
- 大文件通过 Mediabunny `StreamTarget` 直接写入 File System Access API，不把完整文件保存在内存。
- YouTube 下载按钮挂在视频下方的操作栏；X 下载按钮挂在每条视频下方右侧，不使用全局悬浮按钮。
- 按钮使用窗口级事件委托和 DOM 变化监听，兼容 YouTube/X 单页导航、虚拟列表重绘及节点克隆。
- 下载面板不使用 `innerHTML` 等受限 HTML 注入接口，兼容 YouTube 的 Trusted Types 策略。
- YouTube player 签名 evaluator 使用专用 `TrustedScript` policy；不会创建全局 default policy，也不会关闭或绕过页面 Trusted Types。
- X 的普通完整 MP4 经过头部和音视频轨探测后才允许直接下载；DASH/fMP4（如 `sidx` / `moof`）以及跨资源视频/音频统一由 Mediabunny 在浏览器内 remux。
- X 的 HLS (`m3u8`) 由 Mediabunny 读取并在浏览器内封装成可播放 MP4/WebM。
- X 会过滤 `sq` 分片并移除播放器临时的 `range` / `rn` / `rbuf` 参数，避免把初始化片段保存成不可播放的小文件。
- X 播放器产生的初始化片段、单独音频和不可解析 HLS 清单会从下载面板中自动隐藏，不再显示成“无法保存”的候选项。
- X 文件名优先使用媒体响应提供的文件名；没有原始文件名时使用 `上传者ID_状态ID_分辨率`，不再使用页面标题。

## 环境

建议：最新版 Chrome / Edge + Tampermonkey。

1080p+ 合并依赖 `showSaveFilePicker()`，Firefox/Safari 的兼容性不作为本项目目标。

## 构建

```bash
npm install
npm run build
```

产物：

```text
dist/ytx-direct-downloader.user.js
```

将这个文件拖入 Tampermonkey 或打开后安装即可。

## 为什么源码里有一处动态签名 evaluator？

YouTube 会动态改变 `signatureCipher` / `n` 参数算法。YouTube.js 18.x 的官方浏览器使用说明要求宿主提供一个 JS evaluator，用来执行从 YouTube 自己的 player JS 中提取出来的签名变换代码。Chromium/Edge 在启用 Trusted Types 时可能拒绝 `Function(TrustedScript)`，因此本项目按照 Trusted Types 项目记录的兼容方案，通过专用 policy 执行 `eval(TrustedScript)`。本项目没有用它执行第三方服务器返回的代码，也没有远程 `@require`。

如果你完全不接受动态执行，可以删除该 evaluator，但遇到 `signatureCipher` / `n` 的视频时高画质 URL 可能无法解析。

## 运行时网络白名单

源码中的 `isAllowedNetworkUrl()` 会再次检查所有由本脚本发起的 HTTP 请求：

- `youtube.com` / `*.youtube.com`
- `youtubei.googleapis.com`
- `googlevideo.com` / `*.googlevideo.com`
- `video.twimg.com`

即使以后某个依赖尝试访问其他域名，也会被本脚本直接拒绝。

## 已知限制

- YouTube 内部 API、签名算法和反自动化措施可能变化，因此以后可能需要升级 `youtubei.js`。
- 某些年龄限制、付费、DRM、直播/Post-Live-DVR 内容不在目标范围内。
- SABR 是否可用取决于当前 YouTube 响应是否包含 `serverAbrStreamingUrl`、Ustreamer 配置及可选格式元数据；需要播放器会话允许这些字段，DRM/需要额外 attestation 的内容仍会失败并显示原因。
- X 时间线中同时播放多个视频时，脚本按最近的 `video.twimg.com` 请求展示候选；单条推文详情页最准确。
- 只做 remux，不做重新编码，因此最终容器由视频/音频编码兼容性决定。

## 依赖

- youtubei.js 18.0.0 (MIT)
- googlevideo 4.1.1 (MIT)
- mediabunny 1.52.3 (MPL-2.0)
- esbuild 0.28.0 (MIT, build-time only)
