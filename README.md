# YouTube 和 X（Twitter）直连下载

Tampermonkey 用户脚本，支持 YouTube、Shorts 和 X 视频下载，在浏览器内无损合并音视频，不调用第三方解析站。

## 安装

1. 安装最新版 [Tampermonkey](https://www.tampermonkey.net/)，推荐使用 Chrome / Edge。
2. 打开 [Greasy Fork 脚本页面](https://greasyfork.org/zh-CN/scripts/592315-youtube%E5%92%8Cx-twitter-%E7%9B%B4%E8%BF%9E%E4%B8%8B%E8%BD%BD-%E5%85%8D%E8%B7%B3%E8%BD%AC%E7%AC%AC%E4%B8%89%E6%96%B9)，点击安装；也可从 [GitHub Releases](https://github.com/SamProjects/ytx-direct-downloader/releases/latest) 下载 `ytx-direct-downloader.user.js` 后拖入 Tampermonkey。
3. 刷新 YouTube 或 X 页面。

## 使用

- **YouTube**：点击视频下方的“高清下载”；Shorts 点击右侧的“直接下载”，选择画质保存。只显示 360p 时，先在播放器中选择高画质并播放几秒，再刷新下载框。
- **X**：先播放视频几秒，再点击视频区域下方的“视频下载”。支持 MP4、DASH/fMP4 和 HLS。
- **音频语言**：默认优先匹配浏览器语言，没有匹配版本时回退到默认/原声音轨；可在“音频语言”中选择其他语言后下载。
- **下载并发**：顶部可选择 1–8 路，默认 4 路，设置自动保存并对新任务生效。SABR/UMP 和 Tampermonkey 直接下载回退方式不受此设置控制。
- **下载队列**：任务逐个执行，浏览器内下载支持当前页面会话内暂停、恢复和取消。

## 限制

- 高画质合并和流式写盘需要 File System Access API，建议使用最新版 Chrome / Edge。
- 不支持 DRM、付费、直播及部分受限视频；YouTube 接口变化可能影响下载，SABR 可用性取决于播放器会话。
- X 同时播放多个视频时，建议在单条推文详情页下载。
- 仅无损封装，不重新编码；并发数增加不保证下载速度提升。

## 本地构建

需要 Node.js 20+ 和 npm。

```bash
npm ci
npm test
npm run build
```

生成独立版 `dist/ytx-direct-downloader.user.js`，依赖全部内置。

Greasy Fork 可读版通过带完整性校验的 `@require` 加载固定版本运行库。先将生成的 `vendor/` 文件提交并推送到 GitHub，再执行：

```bash
npm run build:greasy
```

生成 `dist/ytx-direct-downloader.greasy.user.js`，构建默认使用当前 Git commit。

## 发布

更新 `package.json` 版本号并提交源码及生成的 `vendor/` 文件后，推送同版本的 `vX.Y.Z` 标签，GitHub Actions 会自动构建并发布两种脚本及 SHA-256 校验文件。

Greasy Fork 需另行上传 `ytx-direct-downloader.greasy.user.js`；GitHub Release 不会自动同步到 Greasy Fork。

## 许可证

[MIT](LICENSE)。依赖及版本见 [package.json](package.json)，再发布时请保留依赖许可证声明。
