const runtime = globalThis.__YTX_MEDIABUNNY_RUNTIME__;

if (!runtime) {
  throw new Error('YT + X Direct Downloader media library was not loaded.');
}

export const ALL_FORMATS = runtime.ALL_FORMATS;
export const HLS_FORMATS = runtime.HLS_FORMATS;
export const Input = runtime.Input;
export const Output = runtime.Output;
export const UrlSource = runtime.UrlSource;
export const EncodedPacketSink = runtime.EncodedPacketSink;
export const EncodedVideoPacketSource = runtime.EncodedVideoPacketSource;
export const EncodedAudioPacketSource = runtime.EncodedAudioPacketSource;
export const Mp4OutputFormat = runtime.Mp4OutputFormat;
export const WebMOutputFormat = runtime.WebMOutputFormat;
export const StreamTarget = runtime.StreamTarget;
export const ReadableStreamSource = runtime.ReadableStreamSource;
