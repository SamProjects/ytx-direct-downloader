const runtime = globalThis.__YTX_YOUTUBE_RUNTIME__;

if (!runtime) {
  throw new Error('YT + X Direct Downloader libraries were not loaded.');
}

export const Innertube = runtime.Innertube;
export const Parser = runtime.Parser;
export const Platform = runtime.Platform;
export const YTNodes = runtime.YTNodes;
export const SabrStream = runtime.SabrStream;
