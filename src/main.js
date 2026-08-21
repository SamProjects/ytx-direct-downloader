import { Innertube, Parser, Platform, YTNodes, SabrStream } from './runtime.js';
import {
  ALL_FORMATS,
  HLS_FORMATS,
  Input,
  Output,
  UrlSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  EncodedAudioPacketSource,
  Mp4OutputFormat,
  WebMOutputFormat,
  StreamTarget,
  ReadableStreamSource
} from './media-runtime.js';

(() => {
  'use strict';

  const APP = 'ytx-local-downloader';
  const PLAYER_EVAL_POLICY = `${APP}-player-eval`;
  const BUTTON_CLASS = `${APP}-context-button`;
  const PANEL_ID = `${APP}-panel`;
  const STYLE_ID = `${APP}-style`;

  const state = {
    youtubePromise: null,
    youtubeInfo: new Map(),
    youtubeUrlCache: new WeakMap(),
    youtubeSessionClient: null,
    youtubeSessionPoToken: '',
    youtubeEvalEnvironment: null,
    youtubeMedia: new Map(),
    youtubeFormatMetadata: new Map(),
    youtubeNavigationStartedAt: 0,
    youtubeNetworkCaptureInstalled: false,
    xMedia: new Map(),
    lastHref: location.href,
    busy: false,
    activeAnchor: null,
    panelResizeObserver: null,
    activationInstalled: false,
    ensureScheduled: false,
    domObserver: null,
    lastActivationAt: 0,
    lastActivationButton: null
  };

  // ---------------------------------------------------------------------------
  // Security boundary
  // ---------------------------------------------------------------------------
  // All runtime HTTP requests created by this script must pass this allowlist.
  // No analytics, ads, referral endpoints, or third-party parser services exist.
  function isAllowedNetworkUrl(rawUrl) {
    let url;
    try {
      url = new URL(String(rawUrl));
    } catch {
      return false;
    }

    if (url.protocol !== 'https:') return false;

    const host = url.hostname.toLowerCase();
    return (
      host === 'youtube.com' ||
      host.endsWith('.youtube.com') ||
      host === 'youtubei.googleapis.com' ||
      host === 'googlevideo.com' ||
      host.endsWith('.googlevideo.com') ||
      host === 'video.twimg.com'
    );
  }

  function assertAllowedNetworkUrl(rawUrl) {
    if (!isAllowedNetworkUrl(rawUrl)) {
      throw new Error(`Blocked non-whitelisted URL: ${rawUrl}`);
    }
  }

  // ---------------------------------------------------------------------------
  // GM_xmlhttpRequest -> Fetch API adapter
  // ---------------------------------------------------------------------------
  // YouTube.js and Mediabunny expect fetch(). A normal page fetch is subject to
  // CORS. Tampermonkey's GM_xmlhttpRequest is used only as a transport adapter,
  // while the explicit allowlist above prevents arbitrary outbound requests.
  async function bodyToGmData(body) {
    if (body == null) return undefined;
    if (typeof body === 'string') return body;
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof ArrayBuffer) return body;
    if (ArrayBuffer.isView(body)) {
      return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    }
    if (body instanceof Blob) return await body.arrayBuffer();
    if (body instanceof ReadableStream) return await new Response(body).arrayBuffer();
    if (body instanceof FormData) {
      throw new Error('FormData requests are intentionally unsupported by gmFetch.');
    }
    return body;
  }

  function mergeHeaders(baseHeaders, overrideHeaders) {
    const headers = new Headers(baseHeaders || undefined);
    if (overrideHeaders) {
      new Headers(overrideHeaders).forEach((value, key) => headers.set(key, value));
    }
    return headers;
  }

  function headersToObject(headers) {
    const obj = {};
    headers.forEach((value, key) => {
      obj[key] = value;
    });
    return obj;
  }

  function parseResponseHeaders(raw) {
    const headers = new Headers();
    String(raw || '')
      .split(/\r?\n/)
      .forEach((line) => {
        const p = line.indexOf(':');
        if (p <= 0) return;
        const key = line.slice(0, p).trim();
        const value = line.slice(p + 1).trim();
        if (!key) return;
        try {
          headers.append(key, value);
        } catch {
          // Ignore invalid headers returned by the browser/userscript engine.
        }
      });
    return headers;
  }

  async function normalizeFetchRequest(input, init = {}) {
    let url;
    let method;
    let headers;
    let body;
    let signal;

    if (input instanceof Request) {
      url = input.url;
      method = String(init.method || input.method || 'GET').toUpperCase();
      headers = mergeHeaders(input.headers, init.headers);
      signal = init.signal || input.signal;

      if (method !== 'GET' && method !== 'HEAD') {
        if (Object.prototype.hasOwnProperty.call(init, 'body')) {
          body = await bodyToGmData(init.body);
        } else {
          body = await input.clone().arrayBuffer();
        }
      }
    } else {
      url = input instanceof URL ? input.href : String(input);
      method = String(init.method || 'GET').toUpperCase();
      headers = new Headers(init.headers || undefined);
      signal = init.signal;
      if (method !== 'GET' && method !== 'HEAD') {
        body = await bodyToGmData(init.body);
      }
    }

    assertAllowedNetworkUrl(url);
    return { url, method, headers, body, signal };
  }

  async function gmFetch(input, init = {}) {
    const request = await normalizeFetchRequest(input, init);

    if (request.signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    return await new Promise((resolve, reject) => {
      let settled = false;
      let abortListener = null;

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (abortListener && request.signal) {
          request.signal.removeEventListener('abort', abortListener);
        }
        fn(value);
      };

      const xhr = GM_xmlhttpRequest({
        method: request.method,
        url: request.url,
        headers: headersToObject(request.headers),
        data: request.body,
        responseType: 'arraybuffer',
        timeout: 60_000,
        anonymous: false,
        onload(response) {
          try {
            const status = Number(response.status);
            if (!Number.isFinite(status) || status < 100 || status > 599) {
              throw new Error(`Invalid HTTP status: ${response.status}`);
            }

            const headers = parseResponseHeaders(response.responseHeaders);
            const noBody = request.method === 'HEAD' || [204, 205, 304].includes(status);
            const body = noBody ? null : response.response;
            const result = new Response(body, {
              status,
              statusText: response.statusText || '',
              headers
            });

            // Response.url is empty for a Response constructed in JS. Some
            // libraries inspect it, so expose GM's final URL when possible.
            try {
              Object.defineProperty(result, 'url', {
                configurable: true,
                value: response.finalUrl || request.url
              });
            } catch {
              // Non-critical.
            }

            finish(resolve, result);
          } catch (error) {
            finish(reject, error);
          }
        },
        onerror(error) {
          finish(reject, new TypeError(`Network request failed: ${request.url}`, { cause: error }));
        },
        ontimeout() {
          finish(reject, new DOMException(`Network timeout: ${request.url}`, 'TimeoutError'));
        },
        onabort() {
          finish(reject, new DOMException('The operation was aborted.', 'AbortError'));
        }
      });

      if (request.signal) {
        abortListener = () => xhr.abort();
        request.signal.addEventListener('abort', abortListener, { once: true });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------------------
  function sanitizeFilename(value) {
    return String(value || 'video')
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/g, '')
      .slice(0, 170) || 'video';
  }

  function getXTweetContext(anchor = state.activeAnchor) {
    const article = anchor?.closest?.('article, [role="article"], [data-testid="tweet"]') || null;
    const links = article ? [...article.querySelectorAll('a[href]')] : [];
    const hrefs = links.map((link) => link.href).filter(Boolean);
    const statusHref = hrefs.find((href) => /\/status(?:es)?\/\d+/i.test(href)) || location.href;
    const statusMatch = statusHref.match(/\/status(?:es)?\/(\d+)/i);
    const authorFromStatus = statusHref.match(/\/([^/?#]+)\/status(?:es)?\/\d+/i)?.[1] || '';
    const userName = article?.querySelector('[data-testid="User-Name"]');
    const authorHref = [...(userName?.querySelectorAll('a[href]') || [])]
      .map((link) => link.href)
      .find((href) => !/\/status(?:es)?\/\d+/i.test(href));
    const authorFromUser = authorHref?.match(/\/([^/?#]+)\/?(?:\?|#|$)/)?.[1] || '';

    return {
      article,
      tweetId: statusMatch?.[1] || '',
      authorId: authorFromStatus && authorFromStatus !== 'i'
        ? authorFromStatus
        : authorFromUser
    };
  }

  function getXUrlFilename(rawUrl) {
    try {
      const url = new URL(String(rawUrl));
      const queryCandidate = ['filename', 'file', 'name']
        .map((key) => url.searchParams.get(key) || '')
        .find((value) => value);
      const pathCandidate = decodeURIComponent(url.pathname.split('/').pop() || '');
      const candidate = queryCandidate || pathCandidate;
      const stem = candidate.replace(/\.(?:mp4|webm|mov|m4s|m3u8)$/i, '');
      if (!stem || /^(?:mp4|webm|mov|m4s|m3u8|video|vid|file|stream)$/i.test(stem)) return '';
      return sanitizeFilename(stem);
    } catch {
      return '';
    }
  }

  function getXDownloadName(item, analysis, extension, index = 0) {
    const original = analysis?.suggestedName || getXUrlFilename(item?.url);
    const context = getXTweetContext();
    let base = original;
    if (!base) {
      base = [context.authorId || 'x-user', context.tweetId || 'tweet'].join('_');
      if (analysis?.width && analysis?.height) base += `_${analysis.width}x${analysis.height}`;
      if (index > 0) base += `_video${index + 1}`;
    }

    const clean = sanitizeFilename(base).replace(/\.(?:mp4|webm|mov|m4s|m3u8)$/i, '');
    return `${clean || 'x-video'}.${extension}`;
  }

  function formatBytes(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '未知大小';
    if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
    if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(2)} MB`;
    return `${(n / 1024).toFixed(1)} KB`;
  }

  function mimeContainer(mimeType) {
    const mime = String(mimeType || '').toLowerCase();
    if (mime.startsWith('video/mp4') || mime.startsWith('audio/mp4')) return 'mp4';
    if (mime.startsWith('video/webm') || mime.startsWith('audio/webm')) return 'webm';
    return null;
  }

  function codecLabel(mimeType) {
    const text = String(mimeType || '');
    const codecs = text.match(/codecs="([^"]+)"/i)?.[1] || '';
    const lower = codecs.toLowerCase();

    if (lower.includes('av01')) return `AV1${codecs ? ` (${codecs})` : ''}`;
    if (lower.includes('vp09') || lower.includes('vp9')) return `VP9${codecs ? ` (${codecs})` : ''}`;
    if (lower.includes('vp8')) return `VP8${codecs ? ` (${codecs})` : ''}`;
    if (lower.includes('avc1') || lower.includes('avc3')) return `H.264${codecs ? ` (${codecs})` : ''}`;
    if (lower.includes('hev1') || lower.includes('hvc1')) return `H.265${codecs ? ` (${codecs})` : ''}`;
    if (lower.includes('mp4a')) return `AAC${codecs ? ` (${codecs})` : ''}`;
    if (lower.includes('opus')) return 'Opus';
    if (lower.includes('vorbis')) return 'Vorbis';
    return codecs || '未知编码';
  }

  function isYoutubeHost() {
    return /(^|\.)youtube\.com$/i.test(location.hostname);
  }

  function isXHost() {
    return /(^|\.)(x|twitter)\.com$/i.test(location.hostname);
  }

  function getYoutubeVideoId() {
    try {
      const url = new URL(location.href);
      if (url.pathname === '/watch') return url.searchParams.get('v');
      const shorts = url.pathname.match(/^\/shorts\/([\w-]{6,})/);
      if (shorts) return shorts[1];
      const live = url.pathname.match(/^\/live\/([\w-]{6,})/);
      if (live) return live[1];
    } catch {
      // ignore
    }
    return null;
  }

  function isDrmFormat(format) {
    return Array.isArray(format?.drm_families) && format.drm_families.length > 0;
  }

  function hasYoutubeFormatSource(format) {
    return [format?.url, format?.signature_cipher, format?.cipher].some(
      (value) => typeof value === 'string' && value.trim().length > 0
    );
  }

  function showError(error) {
    console.error(`[${APP}]`, error);
    const message = error?.message || String(error);
    setStatus(`失败：${message}`, 'error');
  }

  // ---------------------------------------------------------------------------
  // YouTube.js
  // ---------------------------------------------------------------------------
  // YouTube.js extracts a small signature/nsig transformation program from
  // YouTube's own current player JS. Its official browser documentation requires
  // the host application to supply an evaluator. This is the only dynamic code
  // execution intentionally used by this script.
  function getYoutubeEvalEnvironment() {
    if (state.youtubeEvalEnvironment) return state.youtubeEvalEnvironment;

    const pageWindow = typeof unsafeWindow !== 'undefined'
      ? unsafeWindow
      : document.defaultView || globalThis;
    const candidates = [
      { scope: globalThis, name: 'userscript' },
      { scope: pageWindow, name: 'page' }
    ].filter((candidate, index, all) => candidate.scope && all.findIndex((item) => item.scope === candidate.scope) === index);
    const hasTrustedTypes = candidates.some((candidate) => candidate.scope?.trustedTypes?.createPolicy);
    let lastError = null;

    for (const candidate of candidates) {
      const evaluate = candidate.scope?.eval;
      if (typeof evaluate !== 'function') continue;

      const trustedTypes = candidate.scope?.trustedTypes;
      if (trustedTypes?.createPolicy) {
        try {
          // The source is the signature transformer extracted by YouTube.js
          // from YouTube's own player JS. Never create a default policy and
          // never accept code from another network source here.
          const policy = trustedTypes.createPolicy(PLAYER_EVAL_POLICY, {
            createScript(value) {
              return String(value);
            }
          });
          state.youtubeEvalEnvironment = { evaluate, scope: candidate.scope, policy, trustedTypes, name: candidate.name };
          return state.youtubeEvalEnvironment;
        } catch (error) {
          lastError = error;
        }
      } else if (!hasTrustedTypes) {
        state.youtubeEvalEnvironment = { evaluate, scope: candidate.scope, policy: null, trustedTypes: null, name: candidate.name };
        return state.youtubeEvalEnvironment;
      }
    }

    throw new Error(`YouTube 页面拒绝创建 TrustedScript 策略：${lastError?.message || lastError || '没有可用的 Trusted Types 环境'}`);
  }

  Platform.shim.eval = async (data) => {
    if (!data || typeof data.output !== 'string') {
      throw new Error('YouTube player evaluator received invalid data.');
    }

    // Chromium/Edge can reject Function(TrustedScript) even when the value is
    // correctly branded. Execute an IIFE through eval(TrustedScript), which is
    // the compatibility path documented by the Trusted Types project.
    const source = `(function ytxYoutubePlayerTransform() {\n"use strict";\n${data.output}\n})()`;
    const environment = getYoutubeEvalEnvironment();
    const trustedSource = environment.policy ? environment.policy.createScript(source) : source;
    if (environment.trustedTypes?.isScript && !environment.trustedTypes.isScript(trustedSource)) {
      throw new Error(`TrustedScript 创建失败（执行环境：${environment.name}）。`);
    }
    return Reflect.apply(environment.evaluate, environment.scope, [trustedSource]);
  };

  // YouTube occasionally returns this command inside an authentication error
  // screen before youtubei.js has released a typed node for it. Register the
  // small stable shape locally so parsing can continue to playabilityStatus.
  if (!Parser.hasParser('PlayerErrorCommand')) {
    class PlayerErrorCommand {
      static type = 'PlayerErrorCommand';

      constructor(data) {
        this.command = {
          click_tracking_params: data?.command?.clickTrackingParams || '',
          auth_required_command: data?.command?.authRequiredCommand
            ? new YTNodes.NavigationEndpoint(data.command.authRequiredCommand)
            : null
        };
      }
    }

    Parser.addRuntimeParser('PlayerErrorCommand', PlayerErrorCommand);
  }

  function readJsonObjectAt(text, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }

      if (character === '"') {
        inString = true;
      } else if (character === '{') {
        depth += 1;
      } else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, index + 1));
          } catch {
            return null;
          }
        }
      }
    }

    return null;
  }

  function getYoutubePlayerResponseFromPage(videoId) {
    const candidates = [
      globalThis.ytInitialPlayerResponse,
      globalThis.ytplayer?.config?.args?.player_response,
      globalThis.ytplayer?.config?.player_response
    ];

    const accept = (candidate) => {
      if (typeof candidate === 'string') {
        try { candidate = JSON.parse(candidate); } catch { return null; }
      }
      if (!candidate || typeof candidate !== 'object') return null;
      return candidate.videoDetails?.videoId === videoId ? candidate : null;
    };

    for (const candidate of candidates) {
      const response = accept(candidate);
      if (response) return response;
    }

    const markers = [
      'ytInitialPlayerResponse =',
      'ytInitialPlayerResponse=',
      'player_response:'
    ];

    for (const script of document.scripts) {
      const text = script.textContent || '';
      if (!text.includes('ytInitialPlayerResponse') && !text.includes('player_response')) continue;

      for (const marker of markers) {
        const markerIndex = text.indexOf(marker);
        if (markerIndex < 0) continue;
        const objectStart = text.indexOf('{', markerIndex + marker.length);
        if (objectStart < 0) continue;
        const response = accept(readJsonObjectAt(text, objectStart));
        if (response) return response;
      }
    }

    return null;
  }

  function readableYoutubeText(value) {
    if (typeof value === 'string') return value;
    if (typeof value?.text === 'string') return value.text;
    return '';
  }

  function youtubePlayabilityText(info) {
    const playability = info?.playability_status;
    if (!playability) return '没有 playabilityStatus';

    const status = playability.status || 'UNKNOWN';
    const reason = readableYoutubeText(playability.reason);
    const errorScreen = playability.error_screen;
    const detail =
      readableYoutubeText(errorScreen?.subreason) ||
      readableYoutubeText(errorScreen?.reason);
    return [status, reason || detail].filter(Boolean).join('：');
  }

  function parsePageYoutubeInfo(youtube, playerResponse) {
    const parsed = Parser.parseResponse(playerResponse);
    return {
      ...parsed,
      actions: youtube?.actions,
      basic_info: parsed.video_details || {},
      source: 'page'
    };
  }

  function rememberYoutubeFormatMetadata(videoId, info) {
    if (!videoId || !info?.streaming_data) return;
    let metadata = state.youtubeFormatMetadata.get(videoId);
    if (!metadata) {
      metadata = new Map();
      state.youtubeFormatMetadata.set(videoId, metadata);
    }

    const formats = [
      ...(info.streaming_data.formats || []),
      ...(info.streaming_data.adaptive_formats || [])
    ];
    for (const format of formats) {
      if (!format?.itag) continue;
      metadata.set(String(format.itag), format);
      if (format.xtags) metadata.set(`${format.itag}:${format.xtags}`, format);
    }
  }

  const YOUTUBE_CLIENT_NAME_IDS = {
    iOS: 5,
    WEB: 1,
    MWEB: 2,
    WEB_KIDS: 76,
    WEB_REMIX: 67,
    ANDROID: 3,
    ANDROID_CREATOR: 14,
    ANDROID_MUSIC: 21,
    ANDROID_VR: 28,
    VISIONOS: 101,
    TVHTML5: 7,
    TVHTML5_SIMPLY: 74,
    TVHTML5_SIMPLY_EMBEDDED_PLAYER: 85,
    WEB_EMBEDDED_PLAYER: 56,
    WEB_CREATOR: 62
  };

  function youtubeSabrFormatFromFormat(format) {
    if (!format?.itag) return null;
    return {
      itag: Number(format.itag),
      lastModified: String(format.last_modified_ms || format.last_modified || '0'),
      xtags: format.xtags || undefined,
      width: Number(format.width || 0) || undefined,
      height: Number(format.height || 0) || undefined,
      contentLength: Number(format.content_length || 0) || undefined,
      audioTrackId: format.audio_track?.id || format.audio_track_id || undefined,
      mimeType: format.mime_type || undefined,
      quality: format.quality || undefined,
      qualityLabel: format.quality_label || undefined,
      averageBitrate: Number(format.average_bitrate || 0) || undefined,
      bitrate: Number(format.bitrate || format.average_bitrate || 0) || 0,
      audioQuality: format.audio_quality || undefined,
      approxDurationMs: Number(format.approx_duration_ms || 0) || 0,
      language: format.language || null,
      isDubbed: Boolean(format.is_dubbed),
      isAutoDubbed: Boolean(format.is_auto_dubbed),
      isDescriptive: Boolean(format.is_descriptive),
      isSecondary: Boolean(format.is_secondary),
      isOriginal: Boolean(format.is_original)
    };
  }

  function selectYoutubeSabrAudioFormat(info, videoFormat) {
    const container = mimeContainer(videoFormat?.mime_type);
    const candidates = (info?.streaming_data?.adaptive_formats || [])
      .filter((format) => {
        if (!format?.has_audio || format.has_video || format.is_type_otf || isDrmFormat(format)) return false;
        if (!format.mime_type) return false;
        return !container || mimeContainer(format.mime_type) === container;
      })
      .sort((a, b) => Number(b.bitrate || b.average_bitrate || 0) - Number(a.bitrate || a.average_bitrate || 0));

    return candidates[0] || null;
  }

  function getYoutubeSabrFormatPairs(info) {
    const streaming = info?.streaming_data;
    if (!streaming?.server_abr_streaming_url) return [];

    const pairs = [];
    const seen = new Set();
    for (const rawVideo of [
      ...(streaming.adaptive_formats || []),
      ...(streaming.formats || [])
    ]) {
      if (!rawVideo?.has_video || rawVideo.is_type_otf || isDrmFormat(rawVideo)) continue;
      if (!rawVideo.mime_type || !mimeContainer(rawVideo.mime_type)) continue;
      const rawAudio = selectYoutubeSabrAudioFormat(info, rawVideo);
      if (!rawAudio) continue;

      const video = youtubeSabrFormatFromFormat(rawVideo);
      const audio = youtubeSabrFormatFromFormat(rawAudio);
      if (!video || !audio) continue;
      const key = `${video.itag}:${video.xtags || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ video, audio, rawVideo, rawAudio });
    }

    pairs.sort((a, b) =>
      (Number(b.video.height || 0) - Number(a.video.height || 0)) ||
      (Number(b.video.qualityLabel?.endsWith?.('60') ? 60 : 0) - Number(a.video.qualityLabel?.endsWith?.('60') ? 60 : 0)) ||
      (Number(b.video.bitrate || 0) - Number(a.video.bitrate || 0))
    );
    return pairs;
  }

  function scoreYoutubeSabrInfo(info) {
    const pairs = getYoutubeSabrFormatPairs(info);
    if (!pairs.length) return -1;
    const best = pairs[0].video;
    return Number(best.height || 0) * 1_000_000_000_000 +
      Number(best.bitrate || 0);
  }

  function scoreYoutubeInfo(info) {
    let best = -1;
    for (const format of getYoutubeVideoFormats(info)) {
      if (!mimeContainer(format.mime_type)) continue;
      if (!format.has_audio && !selectYoutubeAudioFormat(info, format)) continue;

      const height = Number(format.height || 0);
      const fps = Number(format.fps || 0);
      const bitrate = Number(format.bitrate || format.average_bitrate || 0);
      const score = height * 1_000_000_000_000 + fps * 1_000_000_000 + bitrate;
      if (score > best) best = score;
    }
    return best;
  }

  async function getYoutubeClient() {
    if (!state.youtubePromise) {
      const cookie = (() => {
        try { return document.cookie || ''; } catch { return ''; }
      })();

      state.youtubePromise = Innertube.create({
        fetch: gmFetch,
        cookie: cookie || undefined,
        retrieve_player: true,
        generate_session_locally: true,
        enable_session_cache: false,
        user_agent: navigator.userAgent,
        lang: (navigator.language || 'en').split('-')[0]
      }).catch((error) => {
        state.youtubePromise = null;
        throw error;
      });
    }
    const youtube = await state.youtubePromise;
    state.youtubeSessionClient = youtube?.session?.context?.client || state.youtubeSessionClient;
    state.youtubeSessionPoToken = youtube?.session?.po_token || state.youtubeSessionPoToken;
    return youtube;
  }

  async function loadYoutubeInfo(videoId, force = false) {
    if (!force && state.youtubeInfo.has(videoId)) {
      return state.youtubeInfo.get(videoId);
    }

    const errors = [];
    const candidates = [];
    const sabrCandidates = [];
    let youtube = null;

    const addCandidate = (info, client) => {
      const score = scoreYoutubeInfo(info);
      if (score < 0) {
        errors.push(`${client}: ${youtubePlayabilityText(info)}；没有可下载的视频/音频组合`);
        return;
      }
      candidates.push({ info, client, score });
    };

    const addSabrCandidate = (info, client) => {
      const score = scoreYoutubeSabrInfo(info);
      if (score >= 0) sabrCandidates.push({ info, client, score });
    };

    try {
      youtube = await getYoutubeClient();
    } catch (error) {
      errors.push(`客户端初始化：${error?.message || error}`);
    }

    const pageResponse = getYoutubePlayerResponseFromPage(videoId);
    if (pageResponse) {
      try {
        const info = parsePageYoutubeInfo(youtube, pageResponse);
        rememberYoutubeFormatMetadata(videoId, info);
        addSabrCandidate(info, 'PAGE');
        const streaming = info.streaming_data;
        const pageFormats = [
          ...(streaming?.adaptive_formats || []),
          ...(streaming?.formats || [])
        ];
        if (pageFormats.some(hasYoutubeFormatSource)) {
          addCandidate(info, 'PAGE');
        } else {
          errors.push(`PAGE: ${youtubePlayabilityText(info)}；返回的格式没有可解码 URL，可能是 SABR 流`);
        }
      } catch (error) {
        errors.push(`PAGE: ${error?.message || error}`);
      }
    }

    // ANDROID_VR currently avoids some WEB/TV SABR responses. youtubei.js 18
    // also fixes the User-Agent header required by this client.
    const clients = [
      'ANDROID_VR',
      'ANDROID',
      'TV_SIMPLY',
      'TV_EMBEDDED',
      'WEB_EMBEDDED',
      'WEB',
      'TV',
      'IOS',
      'MWEB'
    ];

    if (youtube) {
      const results = await Promise.all(clients.map(async (client) => {
        try {
          return { client, info: await youtube.getBasicInfo(videoId, { client }) };
        } catch (error) {
          return { client, error };
        }
      }));

      for (const result of results) {
        if (result.error) {
          errors.push(`${result.client}: ${result.error?.message || result.error}`);
          continue;
        }

        rememberYoutubeFormatMetadata(videoId, result.info);
        addSabrCandidate(result.info, result.client);
        const streaming = result.info.streaming_data;
        const formats = [
          ...(streaming?.adaptive_formats || []),
          ...(streaming?.formats || [])
        ];
        if (formats.some(hasYoutubeFormatSource)) {
          addCandidate(result.info, result.client);
        } else {
          errors.push(`${result.client}: ${youtubePlayabilityText(result.info)}；返回的格式没有可解码 URL，可能是 SABR 流`);
        }
      }
    }

    if (candidates.length) {
      candidates.sort((a, b) => b.score - a.score);
      const best = candidates[0];
      sabrCandidates.sort((a, b) => b.score - a.score);
      const bestSabr = sabrCandidates[0] || null;
      const result = {
        info: best.info,
        client: best.client,
        sabrInfo: bestSabr?.info || null,
        sabrClient: bestSabr?.client || ''
      };
      state.youtubeInfo.set(videoId, result);
      return result;
    }

    if (sabrCandidates.length) {
      sabrCandidates.sort((a, b) => b.score - a.score);
      const bestSabr = sabrCandidates[0];
      const result = {
        info: bestSabr.info,
        client: bestSabr.client,
        sabrInfo: bestSabr.info,
        sabrClient: bestSabr.client
      };
      state.youtubeInfo.set(videoId, result);
      return result;
    }

    if (!youtube) {
      throw new Error(`YouTube 客户端初始化失败。${errors.length ? `\n${errors.join('\n')}` : ''}`);
    }

    throw new Error(`无法取得 YouTube 媒体信息。${errors.length ? `\n${errors.join('\n')}` : ''}`);
  }

  function getYoutubeVideoFormats(info) {
    const streaming = info.streaming_data;
    if (!streaming) return [];

    const all = [
      ...(streaming.formats || []),
      ...(streaming.adaptive_formats || [])
    ];

    const seen = new Set();
    const result = [];

    for (const format of all) {
      if (!format?.has_video) continue;
      if (format.is_type_otf) continue;
      if (isDrmFormat(format)) continue;
      if (!hasYoutubeFormatSource(format)) continue;
      if (!format.mime_type) continue;
      if (seen.has(format.itag)) continue;
      seen.add(format.itag);
      result.push(format);
    }

    result.sort((a, b) => {
      return (
        (b.height || 0) - (a.height || 0) ||
        (b.fps || 0) - (a.fps || 0) ||
        (b.bitrate || 0) - (a.bitrate || 0)
      );
    });

    return result;
  }

  function hasYoutubeSabrStreaming(info) {
    const streaming = info?.streaming_data;
    if (!streaming) return false;
    if (typeof streaming.server_abr_streaming_url === 'string' && streaming.server_abr_streaming_url) {
      return true;
    }
    const all = [
      ...(streaming.formats || []),
      ...(streaming.adaptive_formats || [])
    ];
    return all.some((format) => !hasYoutubeFormatSource(format) && !isDrmFormat(format));
  }

  function selectYoutubeAudioFormat(info, videoFormat) {
    const container = mimeContainer(videoFormat.mime_type);
    if (!container) return null;

    const candidates = (info.streaming_data?.adaptive_formats || []).filter((format) => {
      if (!format?.has_audio || format.has_video) return false;
      if (format.is_type_otf || isDrmFormat(format)) return false;
      if (!hasYoutubeFormatSource(format)) return false;
      return mimeContainer(format.mime_type) === container;
    });

    candidates.sort((a, b) => {
      const score = (f) => {
        let value = Number(f.bitrate || f.average_bitrate || 0);
        if (f.audio_track?.audio_is_default) value += 10_000_000_000;
        if (f.is_original) value += 1_000_000_000;
        if (f.is_drc) value -= 2_000_000_000;
        if (f.is_vb) value -= 1_000_000_000;
        return value;
      };
      return score(b) - score(a);
    });

    return candidates[0] || null;
  }

  async function decipherYoutubeFormat(info, format) {
    if (!hasYoutubeFormatSource(format)) {
      throw new Error(`itag ${format?.itag || '?'} 没有可解码 URL；YouTube 返回的是 SABR/分段流。`);
    }

    if (!format || typeof format.decipher !== 'function') {
      throw new Error(`itag ${format?.itag || '?'} 不是可解码的 YouTube 格式对象。`);
    }

    const cached = state.youtubeUrlCache.get(format);
    if (cached) return await cached;

    const task = (async () => {
      const player = info.actions?.session?.player || (await getYoutubeClient()).session.player;
      let url;
      try {
        url = await format.decipher(player);
      } catch (error) {
        if (String(error?.message || error).includes('No valid URL to decipher')) {
          throw new Error(`itag ${format.itag || '?'} 没有可解码 URL；YouTube 返回的是 SABR/分段流。`);
        }
        throw error;
      }
      if (!url) throw new Error(`itag ${format.itag || '?'} 没有可用下载 URL。`);
      assertAllowedNetworkUrl(url);

      const host = new URL(url).hostname.toLowerCase();
      if (!(host === 'googlevideo.com' || host.endsWith('.googlevideo.com'))) {
        throw new Error(`YouTube 媒体 URL 不在 googlevideo.com：${host}`);
      }
      return url;
    })();

    state.youtubeUrlCache.set(format, task);
    try {
      return await task;
    } catch (error) {
      state.youtubeUrlCache.delete(format);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // YouTube player media discovery
  // ---------------------------------------------------------------------------
  const YOUTUBE_ITAG_FALLBACKS = new Map([
    [18, ['muxed', 'mp4', 360, 30]], [22, ['muxed', 'mp4', 720, 30]],
    [133, ['video', 'mp4', 240, 30]], [134, ['video', 'mp4', 360, 30]],
    [135, ['video', 'mp4', 480, 30]], [136, ['video', 'mp4', 720, 30]],
    [137, ['video', 'mp4', 1080, 30]], [138, ['video', 'mp4', 2160, 30]],
    [160, ['video', 'mp4', 144, 30]], [264, ['video', 'mp4', 1440, 30]],
    [266, ['video', 'mp4', 2160, 30]], [298, ['video', 'mp4', 720, 60]],
    [299, ['video', 'mp4', 1080, 60]], [399, ['video', 'mp4', 1080, 30]],
    [400, ['video', 'mp4', 1440, 30]], [401, ['video', 'mp4', 2160, 30]],
    [139, ['audio', 'mp4', 0, 0]], [140, ['audio', 'mp4', 0, 0]],
    [141, ['audio', 'mp4', 0, 0]], [242, ['video', 'webm', 240, 30]],
    [243, ['video', 'webm', 360, 30]], [244, ['video', 'webm', 480, 30]],
    [247, ['video', 'webm', 720, 30]], [248, ['video', 'webm', 1080, 30]],
    [271, ['video', 'webm', 1440, 30]], [272, ['video', 'webm', 2160, 30]],
    [278, ['video', 'webm', 144, 30]], [302, ['video', 'webm', 720, 60]],
    [303, ['video', 'webm', 1080, 60]], [308, ['video', 'webm', 1440, 60]],
    [313, ['video', 'webm', 2160, 30]], [315, ['video', 'webm', 2160, 60]],
    [330, ['video', 'webm', 144, 60]], [331, ['video', 'webm', 240, 60]],
    [332, ['video', 'webm', 360, 60]], [333, ['video', 'webm', 480, 60]],
    [334, ['video', 'webm', 720, 60]], [335, ['video', 'webm', 1080, 60]],
    [336, ['video', 'webm', 1440, 60]], [337, ['video', 'webm', 2160, 60]],
    [249, ['audio', 'webm', 0, 0]], [250, ['audio', 'webm', 0, 0]],
    [251, ['audio', 'webm', 0, 0]]
  ]);

  function youtubeMediaKindFromUrl(url, itag) {
    const mime = String(url.searchParams.get('mime') || '').toLowerCase();
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    return YOUTUBE_ITAG_FALLBACKS.get(itag)?.[0] || null;
  }

  function rememberYoutubeMedia(rawUrl, startTime = performance.now()) {
    if (!isYoutubeHost()) return;

    let url;
    try {
      url = new URL(String(rawUrl));
    } catch {
      return;
    }

    const host = url.hostname.toLowerCase();
    if (!(host === 'googlevideo.com' || host.endsWith('.googlevideo.com'))) return;
    if (!url.pathname.toLowerCase().includes('videoplayback')) return;

    const seenAt = Number(startTime) || performance.now();
    if (seenAt + 100 < state.youtubeNavigationStartedAt) return;
    if (url.searchParams.has('sq')) return; // OTF/live segments are not a complete seekable file.

    // Older playback URLs use `itag`; newer player/QoE paths may expose the
    // same format number as `fmt` instead.
    const itag = Number(url.searchParams.get('itag') || url.searchParams.get('fmt') || 0);
    if (!itag) return;
    const kind = youtubeMediaKindFromUrl(url, itag);
    if (!kind) return;

    // The player adds these per-request range/buffering parameters after the
    // signed URL is created. Remove them so Mediabunny can issue its own byte
    // range requests against the complete media resource.
    for (const parameter of ['range', 'rn', 'rbuf']) {
      url.searchParams.delete(parameter);
    }

    const videoId = getYoutubeVideoId();
    if (!videoId) return;
    const xtags = url.searchParams.get('xtags') || '';
    const mediaId = url.searchParams.get('id') || url.pathname;
    const key = `${videoId}:${mediaId}:${itag}:${xtags}`;
    state.youtubeMedia.set(key, {
      url: url.href,
      videoId,
      itag,
      xtags,
      kind,
      seenAt
    });

    if (state.youtubeMedia.size > 200) {
      const oldest = [...state.youtubeMedia.entries()]
        .sort((a, b) => a[1].seenAt - b[1].seenAt)
        .slice(0, state.youtubeMedia.size - 200);
      oldest.forEach(([entryKey]) => state.youtubeMedia.delete(entryKey));
    }
  }

  function scanPerformanceForYoutubeMedia() {
    for (const entry of performance.getEntriesByType('resource')) {
      rememberYoutubeMedia(entry.name, entry.startTime);
    }
  }

  function getRequestUrl(input) {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    if (typeof input?.url === 'string') return input.url;
    return '';
  }

  function installYoutubeNetworkCapture() {
    if (!isYoutubeHost() || state.youtubeNetworkCaptureInstalled) return;

    const pageWindow = typeof unsafeWindow !== 'undefined'
      ? unsafeWindow
      : document.defaultView || globalThis;
    let installed = false;
    const hookMarker = '__ytxLocalDownloaderMediaHook__';

    try {
      const originalFetch = pageWindow.fetch;
      if (typeof originalFetch === 'function') {
        const wrappedFetch = function ytxMediaFetch(input, ...init) {
          try { rememberYoutubeMedia(getRequestUrl(input)); } catch { /* ignore */ }
          const result = Reflect.apply(originalFetch, this, [input, ...init]);
          return Promise.resolve(result).then((response) => {
            try { rememberYoutubeMedia(response?.url); } catch { /* ignore */ }
            return response;
          });
        };
        Object.defineProperty(wrappedFetch, hookMarker, { value: true });
        pageWindow.fetch = wrappedFetch;
        installed = true;
      }
    } catch {
      // The page may expose a non-writable fetch property.
    }

    try {
      const xhrPrototype = pageWindow.XMLHttpRequest?.prototype;
      const originalOpen = xhrPrototype?.open;
      if (xhrPrototype && typeof originalOpen === 'function') {
        const wrappedOpen = function ytxMediaXhrOpen(method, url, ...rest) {
          try { rememberYoutubeMedia(getRequestUrl(url)); } catch { /* ignore */ }
          return Reflect.apply(originalOpen, this, [method, url, ...rest]);
        };
        Object.defineProperty(wrappedOpen, hookMarker, { value: true });
        xhrPrototype.open = wrappedOpen;
        installed = true;
      }
    } catch {
      // The page may expose a non-writable XHR prototype.
    }

    state.youtubeNetworkCaptureInstalled = installed;
  }

  function capturedYoutubeFormat(videoId, media) {
    const metadata = state.youtubeFormatMetadata.get(videoId);
    const source = metadata?.get(`${media.itag}:${media.xtags}`) || metadata?.get(String(media.itag));
    const fallback = YOUTUBE_ITAG_FALLBACKS.get(media.itag) || [media.kind, 'mp4', 0, 0];
    const kind = source?.has_video && source?.has_audio
      ? 'muxed'
      : source?.has_video
        ? 'video'
        : source?.has_audio
          ? 'audio'
          : fallback[0];
    const container = mimeContainer(source?.mime_type) || fallback[1];
    const mimeType = source?.mime_type || `${kind === 'audio' ? 'audio' : 'video'}/${container}`;

    return {
      ...(source || {}),
      itag: media.itag,
      url: media.url,
      mime_type: mimeType,
      width: Number(source?.width || 0) || undefined,
      height: Number(source?.height || fallback[2] || 0) || undefined,
      fps: Number(source?.fps || fallback[3] || 0) || undefined,
      content_length: Number(source?.content_length || new URL(media.url).searchParams.get('clen') || 0) || undefined,
      has_video: kind === 'video' || kind === 'muxed',
      has_audio: kind === 'audio' || kind === 'muxed',
      is_type_otf: false,
      ytx_captured: true,
      async decipher() {
        return this.url;
      }
    };
  }

  function mergeCapturedYoutubeFormats(videoId, info) {
    scanPerformanceForYoutubeMedia();
    const recent = [...state.youtubeMedia.values()]
      .filter((media) => media.videoId === videoId)
      .sort((a, b) => b.seenAt - a.seenAt);
    if (!recent.length) return { info, capturedCount: 0, observedCount: 0, capturedSummary: '' };

    const byTrack = new Map();
    for (const media of recent) {
      const key = `${media.itag}:${media.xtags}`;
      if (!byTrack.has(key)) byTrack.set(key, capturedYoutubeFormat(videoId, media));
    }

    const captured = [...byTrack.values()];
    const capturedSummary = captured
      .slice()
      .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0))
      .slice(0, 10)
      .map((format) => {
        const quality = format.has_video
          ? (format.quality_label || (format.height ? `${format.height}p` : '视频'))
          : '音频';
        return `${quality}/itag ${format.itag}`;
      })
      .join('、');
    const streaming = info.streaming_data || {};
    const formats = [...(streaming.formats || [])];
    const adaptive = [...(streaming.adaptive_formats || [])];
    const existingSources = new Set(
      [...formats, ...adaptive]
        .filter(hasYoutubeFormatSource)
        .map((format) => `${format.itag}:${format.xtags || ''}`)
    );

    let capturedCount = 0;
    for (const format of captured) {
      const key = `${format.itag}:${format.xtags || ''}`;
      if (existingSources.has(key)) continue;
      if (format.has_video && format.has_audio) formats.push(format);
      else adaptive.push(format);
      existingSources.add(key);
      capturedCount += 1;
    }

    return {
      info: {
        ...info,
        streaming_data: {
          ...streaming,
          formats,
          adaptive_formats: adaptive
        }
      },
      capturedCount,
      observedCount: captured.length,
      capturedSummary
    };
  }

  // ---------------------------------------------------------------------------
  // X media discovery
  // ---------------------------------------------------------------------------
  function normalizeXMediaUrl(rawUrl) {
    let url;
    try {
      url = new URL(String(rawUrl));
    } catch {
      return null;
    }

    if (url.hostname.toLowerCase() !== 'video.twimg.com') return null;

    // X uses these query parameters for player range/segment requests. They
    // identify a byte range or DASH fragment, not a standalone downloadable
    // file. Keep the stable signed URL parameters (tag/v/etc.) and remove only
    // the transient request parameters.
    if (url.searchParams.has('sq') || url.searchParams.has('segment')) return null;
    ['range', 'rn', 'rbuf'].forEach((key) => url.searchParams.delete(key));

    const path = url.pathname.toLowerCase();
    const type = path.includes('.m3u8') ? 'hls' : path.includes('.mp4') ? 'mp4' : null;
    if (!type) return null;

    return { url: url.href, type };
  }

  function rememberXMedia(rawUrl, startTime = performance.now()) {
    const normalized = normalizeXMediaUrl(rawUrl);
    if (!normalized) return;

    state.xMedia.set(normalized.url, {
      url: normalized.url,
      type: normalized.type,
      seenAt: Number(startTime) || performance.now()
    });

    // Keep bounded.
    if (state.xMedia.size > 100) {
      const oldest = [...state.xMedia.entries()]
        .sort((a, b) => a[1].seenAt - b[1].seenAt)
        .slice(0, state.xMedia.size - 100);
      oldest.forEach(([key]) => state.xMedia.delete(key));
    }
  }

  function scanPerformanceForXMedia() {
    for (const entry of performance.getEntriesByType('resource')) {
      rememberXMedia(entry.name, entry.startTime);
    }
  }

  try {
    const mediaObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        rememberYoutubeMedia(entry.name, entry.startTime);
        rememberXMedia(entry.name, entry.startTime);
      }
    });
    mediaObserver.observe({ type: 'resource', buffered: true });
  } catch {
    // PerformanceObserver is optional; manual scans are still available.
  }

  // Install before YouTube's player starts its media fetches. This complements
  // Resource Timing for SABR/player requests that are not exposed there.
  installYoutubeNetworkCapture();

  function getRecentXMedia() {
    scanPerformanceForXMedia();
    return [...state.xMedia.values()].sort((a, b) => b.seenAt - a.seenAt);
  }

  function readAscii(bytes, start, length) {
    return String.fromCharCode(...bytes.slice(start, start + length));
  }

  function scanMp4Boxes(bytes) {
    const boxes = new Set();
    const completeBoxes = new Set();
    let offset = 0;
    let complete = true;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    while (offset + 8 <= bytes.length) {
      let size = view.getUint32(offset);
      const type = readAscii(bytes, offset + 4, 4);
      boxes.add(type);

      if (size === 1) {
        if (offset + 16 > bytes.length) {
          complete = false;
          break;
        }
        const high = view.getUint32(offset + 8);
        const low = view.getUint32(offset + 12);
        size = high * 2 ** 32 + low;
      } else if (size === 0) {
        size = bytes.length - offset;
      }

      if (!Number.isSafeInteger(size) || size < 8 || offset + size > bytes.length) {
        complete = false;
        break;
      }
      completeBoxes.add(type);
      offset += size;
    }

    if (offset !== bytes.length) complete = false;
    return { boxes, complete, completeBoxes };
  }

  function parseContentRange(value) {
    const match = String(value || '').match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
    if (!match) return null;
    return {
      start: Number(match[1]),
      end: Number(match[2]),
      total: match[3] === '*' ? null : Number(match[3])
    };
  }

  function parseContentDispositionFilename(value) {
    const text = String(value || '');
    const encoded = text.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i)?.[1];
    const plain = text.match(/filename\s*=\s*"([^"]+)"/i)?.[1] ||
      text.match(/filename\s*=\s*([^;]+)/i)?.[1];
    const candidate = encoded || plain;
    if (!candidate) return '';
    try {
      return sanitizeFilename(decodeURIComponent(candidate.trim().replace(/^"|"$/g, '')));
    } catch {
      return sanitizeFilename(candidate.trim().replace(/^"|"$/g, ''));
    }
  }

  async function inspectXMp4(url) {
    assertAllowedNetworkUrl(url);
    const response = await gmFetch(url, {
      headers: { Range: 'bytes=0-524287' }
    });
    if (!response.ok && response.status !== 206) {
      throw new Error(`无法读取 X MP4 头部（HTTP ${response.status}）。`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length < 16) throw new Error('X MP4 头部过短，无法识别。');

    const scanned = scanMp4Boxes(bytes);
    const boxes = scanned.boxes;
    const majorBrand = readAscii(bytes, 8, 4).toLowerCase();
    const compatibleBrands = [];
    for (let offset = 16; offset + 4 <= Math.min(bytes.length, 128); offset += 4) {
      compatibleBrands.push(readAscii(bytes, offset, 4).toLowerCase());
    }

    const contentRange = parseContentRange(response.headers.get('content-range'));
    const contentLength = Number(response.headers.get('content-length'));
    const totalBytes = contentRange?.total || (Number.isFinite(contentLength) ? contentLength : null);
    const hasCompleteMdat = scanned.completeBoxes.has('mdat');
    const hasMediaData = boxes.has('moof') || hasCompleteMdat || (
      boxes.has('mdat') && (response.status === 200 || totalBytes == null || totalBytes > bytes.length)
    );

    return {
      boxes,
      bytesRead: bytes.length,
      totalBytes: Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : null,
      probeComplete: scanned.complete,
      hasMoov: boxes.has('moov'),
      hasMdat: boxes.has('mdat'),
      hasCompleteMdat,
      hasMediaData,
      suggestedName: parseContentDispositionFilename(response.headers.get('content-disposition')),
      fragmented: boxes.has('sidx') || boxes.has('moof') || majorBrand === 'dash' || compatibleBrands.includes('dash'),
      majorBrand
    };
  }

  // ---------------------------------------------------------------------------
  // Browser-local remux
  // ---------------------------------------------------------------------------
  function createRemoteInput(url, formats = ALL_FORMATS) {
    assertAllowedNetworkUrl(url);
    return new Input({
      source: new UrlSource(url, {
        fetchFn: gmFetch,
        maxCacheSize: 16 * 1024 * 1024,
        parallelism: 2,
        getRetryDelay(previousAttempts) {
          return previousAttempts >= 4 ? null : Math.min(2 ** previousAttempts, 8);
        }
      }),
      formats
    });
  }

  async function chooseOutputForTracks(videoTrack, audioTrack, preferredKind = null) {
    const [videoCodec, audioCodec] = await Promise.all([
      videoTrack.getCodec(),
      audioTrack.getCodec()
    ]);

    if (!videoCodec || !audioCodec) {
      throw new Error(`无法识别编码：video=${videoCodec}, audio=${audioCodec}`);
    }

    const candidates = preferredKind === 'webm'
      ? [new WebMOutputFormat(), new Mp4OutputFormat()]
      : [new Mp4OutputFormat(), new WebMOutputFormat()];

    for (const format of candidates) {
      const videoOk = format.getSupportedVideoCodecs().includes(videoCodec);
      const audioOk = format.getSupportedAudioCodecs().includes(audioCodec);
      if (videoOk && audioOk) {
        return {
          format,
          extension: format instanceof WebMOutputFormat ? 'webm' : 'mp4',
          videoCodec,
          audioCodec
        };
      }
    }

    throw new Error(`没有可直接封装 ${videoCodec} + ${audioCodec} 的 MP4/WebM 容器。`);
  }

  async function remuxTracksToFile({
    videoTrack,
    audioTrack,
    inputs,
    fileHandle,
    preferredKind,
    expectedBytes = 0,
    onProgress
  }) {
    const [videoConfig, audioConfig, outputChoice] = await Promise.all([
      videoTrack.getDecoderConfig(),
      audioTrack.getDecoderConfig(),
      chooseOutputForTracks(videoTrack, audioTrack, preferredKind)
    ]);

    if (!videoConfig) throw new Error('无法读取视频轨 DecoderConfig。');
    if (!audioConfig) throw new Error('无法读取音频轨 DecoderConfig。');

    const videoSource = new EncodedVideoPacketSource(outputChoice.videoCodec);
    const audioSource = new EncodedAudioPacketSource(outputChoice.audioCodec);
    const writable = await fileHandle.createWritable();
    const target = new StreamTarget(writable, {
      chunked: true,
      chunkSize: 2 ** 20
    });

    const output = new Output({
      format: outputChoice.format,
      target
    });

    output.addVideoTrack(videoSource);
    output.addAudioTrack(audioSource);

    let maxWritten = 0;
    let lastUi = 0;
    const stopWriteListener = target.on('write', ({ end }) => {
      maxWritten = Math.max(maxWritten, Number(end) || 0);
      const now = performance.now();
      if (now - lastUi < 150) return;
      lastUi = now;
      if (typeof onProgress === 'function') {
        const ratio = expectedBytes > 0 ? Math.min(maxWritten / expectedBytes, 0.995) : null;
        onProgress({ bytes: maxWritten, ratio });
      }
    });

    const videoSink = new EncodedPacketSink(videoTrack);
    const audioSink = new EncodedPacketSink(audioTrack);

    const copyTrack = async (sink, source, decoderConfig) => {
      let first = true;
      for await (const packet of sink.packets()) {
        if (first) {
          await source.add(packet, { decoderConfig });
          first = false;
        } else {
          await source.add(packet);
        }
      }
      source.close();
    };

    try {
      await output.start();
      await Promise.all([
        copyTrack(videoSink, videoSource, videoConfig),
        copyTrack(audioSink, audioSource, audioConfig)
      ]);
      await output.finalize();
      if (typeof onProgress === 'function') {
        onProgress({ bytes: maxWritten, ratio: 1 });
      }
      return outputChoice;
    } catch (error) {
      try {
        if (output.state === 'pending' || output.state === 'started' || output.state === 'finalizing') {
          await output.cancel();
        }
      } catch {
        // ignore cancellation failures
      }
      throw error;
    } finally {
      try { stopWriteListener?.(); } catch { /* ignore */ }
      for (const input of inputs || []) {
        try { input.dispose(); } catch { /* ignore */ }
      }
    }
  }

  async function remuxYoutubeFormat(info, videoFormat, audioFormat, fileHandle, onProgress) {
    const [videoUrl, audioUrl] = await Promise.all([
      decipherYoutubeFormat(info, videoFormat),
      decipherYoutubeFormat(info, audioFormat)
    ]);

    const videoInput = createRemoteInput(videoUrl, ALL_FORMATS);
    const audioInput = createRemoteInput(audioUrl, ALL_FORMATS);

    let videoTrack;
    let audioTrack;
    try {
      [videoTrack, audioTrack] = await Promise.all([
        videoInput.getPrimaryVideoTrack(),
        audioInput.getPrimaryAudioTrack()
      ]);
    } catch (error) {
      videoInput.dispose();
      audioInput.dispose();
      throw error;
    }

    if (!videoTrack || !audioTrack) {
      videoInput.dispose();
      audioInput.dispose();
      if (!videoTrack) throw new Error('YouTube 视频流中找不到视频轨。');
      throw new Error('YouTube 音频流中找不到音频轨。');
    }

    return await remuxTracksToFile({
      videoTrack,
      audioTrack,
      inputs: [videoInput, audioInput],
      fileHandle,
      preferredKind: mimeContainer(videoFormat.mime_type),
      expectedBytes: Number(videoFormat.content_length || 0) + Number(audioFormat.content_length || 0),
      onProgress
    });
  }

  function youtubeSabrClientInfo(info) {
    const client = info?.actions?.session?.context?.client || state.youtubeSessionClient || {};
    const clientName = typeof client.clientName === 'number'
      ? client.clientName
      : YOUTUBE_CLIENT_NAME_IDS[client.clientName] || YOUTUBE_CLIENT_NAME_IDS.WEB;
    const screenWidth = Number(window.screen?.width || window.innerWidth || 0) || undefined;
    const screenHeight = Number(window.screen?.height || window.innerHeight || 0) || undefined;

    return {
      clientName,
      clientVersion: client.clientVersion || '2.20260623.01.00',
      acceptLanguage: client.hl || navigator.language || 'en-US',
      acceptRegion: client.gl || 'US',
      osName: client.osName || navigator.userAgentData?.platform || navigator.platform || 'Windows',
      osVersion: client.osVersion || '',
      screenWidthPoints: screenWidth,
      screenHeightPoints: screenHeight,
      windowWidthPoints: Number(window.innerWidth || 0) || undefined,
      windowHeightPoints: Number(window.innerHeight || 0) || undefined,
      screenPixelDensity: Number(window.devicePixelRatio || 0) || undefined,
      screenDensityFloat: Number(window.devicePixelRatio || 0) || undefined,
      utcOffsetMinutes: String(-new Date().getTimezoneOffset()),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || ''
    };
  }

  async function decipherYoutubeServerAbrUrl(info, rawUrl) {
    const player = info?.actions?.session?.player || (await getYoutubeClient()).session.player;
    if (!player || typeof player.decipher !== 'function') {
      throw new Error('YouTube SABR 缺少可用的 player URL 解码器。');
    }
    const url = await player.decipher(rawUrl);
    if (!url) throw new Error('YouTube SABR 没有返回可用的服务器地址。');
    assertAllowedNetworkUrl(url);
    return url;
  }

  async function youtubeSabrFetch(input, init = {}) {
    assertAllowedNetworkUrl(getRequestUrl(input));
    const pageWindow = typeof unsafeWindow !== 'undefined'
      ? unsafeWindow
      : document.defaultView || globalThis;
    const nativeFetch = pageWindow?.fetch;

    // The YouTube page's own fetch keeps the browser's origin, referrer and
    // cookie context. This is preferable for SABR, whose endpoint can reject
    // a userscript transport even when the URL and protobuf payload are valid.
    if (typeof nativeFetch === 'function') {
      try {
        return await Reflect.apply(nativeFetch, pageWindow, [input, init]);
      } catch {
        // Fall back to the allowlisted Tampermonkey transport below.
      }
    }

    const client = state.youtubeSessionClient || {};
    const headers = new Headers(init.headers || undefined);
    headers.set('origin', 'https://www.youtube.com');
    headers.set('referer', 'https://www.youtube.com/');
    if (client.visitorData) headers.set('x-goog-visitor-id', client.visitorData);
    if (client.clientName) {
      headers.set('x-youtube-client-name', String(
        typeof client.clientName === 'number'
          ? client.clientName
          : YOUTUBE_CLIENT_NAME_IDS[client.clientName] || YOUTUBE_CLIENT_NAME_IDS.WEB
      ));
    }
    if (client.clientVersion) headers.set('x-youtube-client-version', client.clientVersion);
    return await gmFetch(input, { ...init, headers });
  }

  async function remuxYoutubeSabrFormat(info, pair, fileHandle, onProgress) {
    const rawServerUrl = info?.streaming_data?.server_abr_streaming_url;
    const ustreamerConfig = info?.player_config?.media_common_config
      ?.media_ustreamer_request_config?.video_playback_ustreamer_config;
    if (!rawServerUrl) throw new Error('YouTube SABR 缺少 serverAbrStreamingUrl。');
    if (!ustreamerConfig) throw new Error('YouTube SABR 缺少播放器 Ustreamer 配置。');
    const serverUrl = await decipherYoutubeServerAbrUrl(info, rawServerUrl);

    const durationSeconds = Number(
      info.basic_info?.duration ||
      info.basic_info?.length_seconds ||
      info.video_details?.length_seconds ||
      0
    );
    const formatPairs = getYoutubeSabrFormatPairs(info);
    const sabr = new SabrStream({
      fetch: youtubeSabrFetch,
      serverAbrStreamingUrl: serverUrl,
      videoPlaybackUstreamerConfig: ustreamerConfig,
      clientInfo: youtubeSabrClientInfo(info),
      poToken: info?.actions?.session?.po_token || state.youtubeSessionPoToken || undefined,
      durationMs: durationSeconds > 0 ? durationSeconds * 1000 : undefined,
      formats: formatPairs.flatMap((item) => [item.video, item.audio])
    });
    let sabrFinished = false;
    sabr.on('finish', () => { sabrFinished = true; });

    const { videoStream, audioStream } = await sabr.start({
      videoFormat: pair.video,
      audioFormat: pair.audio,
      preferMP4: true,
      preferH264: true,
      maxRetries: 6
    });

    const videoInput = new Input({
      source: new ReadableStreamSource(videoStream, { maxCacheSize: 64 * 1024 * 1024 }),
      formats: ALL_FORMATS
    });
    const audioInput = new Input({
      source: new ReadableStreamSource(audioStream, { maxCacheSize: 32 * 1024 * 1024 }),
      formats: ALL_FORMATS
    });

    try {
      const [videoTrack, audioTrack] = await Promise.all([
        videoInput.getPrimaryVideoTrack(),
        audioInput.getPrimaryAudioTrack()
      ]);
      if (!videoTrack) throw new Error('SABR 视频流中找不到视频轨。');
      if (!audioTrack) throw new Error('SABR 音频流中找不到音频轨。');

      return await remuxTracksToFile({
        videoTrack,
        audioTrack,
        inputs: [videoInput, audioInput],
        fileHandle,
        preferredKind: mimeContainer(pair.rawVideo?.mime_type),
        expectedBytes: Number(pair.video.contentLength || 0) + Number(pair.audio.contentLength || 0),
        onProgress
      });
    } finally {
      try { videoInput.dispose(); } catch { /* ignore */ }
      try { audioInput.dispose(); } catch { /* ignore */ }
      if (!sabrFinished) {
        try { sabr.abort(); } catch { /* ignore */ }
      }
    }
  }

  async function analyzeXHls(url) {
    const input = createRemoteInput(url, HLS_FORMATS);
    try {
      const videoTracks = await input.getVideoTracks();
      if (!videoTracks.length) throw new Error('HLS 中没有视频轨。');

      const enriched = await Promise.all(videoTracks.map(async (track) => ({
        track,
        width: await track.getDisplayWidth(),
        height: await track.getDisplayHeight(),
        bitrate: (await track.getAverageBitrate()) || (await track.getBitrate()) || 0
      })));

      enriched.sort((a, b) =>
        (b.height || 0) - (a.height || 0) ||
        (b.width || 0) - (a.width || 0) ||
        (b.bitrate || 0) - (a.bitrate || 0)
      );

      const selectedVideo = enriched[0];
      const audioTrack =
        await selectedVideo.track.getPrimaryPairableAudioTrack() ||
        (await input.getAudioTracks())[0] ||
        null;
      if (!audioTrack) throw new Error('HLS 中找不到与视频匹配的音频轨。');

      const output = await chooseOutputForTracks(selectedVideo.track, audioTrack, 'mp4');
      return {
        input,
        videoTrack: selectedVideo.track,
        audioTrack,
        width: selectedVideo.width,
        height: selectedVideo.height,
        bitrate: selectedVideo.bitrate,
        extension: output.extension,
        videoCodec: output.videoCodec,
        audioCodec: output.audioCodec
      };
    } catch (error) {
      try { input.dispose(); } catch { /* ignore */ }
      throw error;
    }
  }

  async function analyzeXMp4(url, relatedUrls = []) {
    const inputs = [];
    try {
      const header = await inspectXMp4(url);
      if (!header.hasMediaData) {
        throw new Error('X MP4 is only an initialization/partial segment; refresh after the video starts playing.');
      }
      const input = createRemoteInput(url, ALL_FORMATS);
      inputs.push(input);

      const videoTrack = await input.getPrimaryVideoTrack();
      if (!videoTrack) throw new Error('X MP4 中找不到视频轨。');

      let audioTrack = await input.getPrimaryAudioTrack();
      let pairedInput = null;

      // X/DASH may expose the video and audio as separate MP4 resources. Try
      // the other captured MP4 URLs before treating this as an unusable file.
      if (!audioTrack) {
        for (const candidateUrl of relatedUrls) {
          if (candidateUrl === url) continue;
          let candidateHeader;
          try {
            candidateHeader = await inspectXMp4(candidateUrl);
          } catch {
            continue;
          }
          if (!candidateHeader.hasMediaData) continue;
          const candidateInput = createRemoteInput(candidateUrl, ALL_FORMATS);
          try {
            const [candidateAudio, candidateVideos] = await Promise.all([
              candidateInput.getPrimaryAudioTrack(),
              candidateInput.getVideoTracks()
            ]);
            if (candidateAudio && candidateVideos.length === 0) {
              audioTrack = candidateAudio;
              pairedInput = candidateInput;
              inputs.push(candidateInput);
              break;
            }
          } catch {
            // This candidate is not a readable audio resource; try the next.
          }
          if (pairedInput !== candidateInput) candidateInput.dispose();
        }
      }

      if (!audioTrack) {
        throw new Error('X MP4 只有视频轨，未找到可配对的音频轨；请播放视频后刷新，或使用检测到的 HLS 入口。');
      }

      const [width, height, videoCodec, audioCodec] = await Promise.all([
        videoTrack.getDisplayWidth(),
        videoTrack.getDisplayHeight(),
        videoTrack.getCodec(),
        audioTrack.getCodec()
      ]);

      // A URL is eligible for direct download only when the probe contains
      // both the MP4 index and actual media data. Init fragments, range
      // captures, and DASH/fMP4 resources must be remuxed or rejected.
      if (
        !header.fragmented &&
        !pairedInput &&
        header.hasMoov &&
        header.hasMdat &&
        (header.hasCompleteMdat || header.totalBytes == null || header.totalBytes > header.bytesRead)
      ) {
        inputs.forEach((entry) => entry.dispose());
        return {
          mode: 'direct',
          width,
          height,
          videoCodec,
          audioCodec,
          suggestedName: header.suggestedName
        };
      }

      const output = await chooseOutputForTracks(videoTrack, audioTrack, 'mp4');
      return {
        mode: 'remux',
        inputs,
        videoTrack,
        audioTrack,
        width,
        height,
        videoCodec,
        audioCodec,
        extension: output.extension,
        suggestedName: header.suggestedName,
        fragmented: header.fragmented,
        paired: Boolean(pairedInput)
      };
    } catch (error) {
      inputs.forEach((entry) => {
        try { entry.dispose(); } catch { /* ignore */ }
      });
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Save / direct download
  // ---------------------------------------------------------------------------
  async function pickSaveFile(suggestedName, extension) {
    if (typeof window.showSaveFilePicker !== 'function') {
      throw new Error('当前浏览器不支持 File System Access API。1080p+ 浏览器内合并建议使用最新版 Chrome/Edge。');
    }

    const mime = extension === 'webm' ? 'video/webm' : 'video/mp4';
    return await window.showSaveFilePicker({
      suggestedName,
      types: [{
        description: extension.toUpperCase(),
        accept: { [mime]: [`.${extension}`] }
      }]
    });
  }

  function directDownload(url, name, onProgress) {
    assertAllowedNetworkUrl(url);
    return new Promise((resolve, reject) => {
      const fail = (error) => {
        const code = error?.error || 'not_succeeded';
        const hints = {
          not_enabled: 'Tampermonkey 下载功能未启用',
          not_whitelisted: '文件扩展名未列入 Tampermonkey 下载白名单',
          not_permitted: 'Tampermonkey 没有浏览器下载权限',
          not_supported: '当前浏览器或下载模式不支持 GM_download',
          not_succeeded: '下载没有成功启动或已失败'
        };
        reject(new Error(`直接下载失败：${hints[code] || code}${error?.details ? `；${error.details}` : ''}`));
      };

      try {
        GM_download({
          url,
          name,
          saveAs: true,
          conflictAction: 'uniquify',
          onprogress(event) {
            if (typeof onProgress !== 'function') return;
            const loaded = Number(event?.loaded || 0);
            const total = Number(event?.total || 0);
            onProgress({
              loaded,
              total,
              ratio: total > 0 ? Math.min(loaded / total, 1) : null
            });
          },
          onload(details) {
            resolve(details);
          },
          onerror: fail,
          ontimeout(error) {
            fail({ error: 'not_succeeded', details: error?.details || '下载超时' });
          }
        });
      } catch (error) {
        fail({ error: error?.message || 'not_succeeded', details: error?.details });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .${BUTTON_CLASS} {
        display: inline-flex !important; align-items: center !important; justify-content: center !important;
        flex: 0 0 auto !important; width: auto !important; min-width: 0 !important;
        min-height: 36px !important; padding: 0 14px !important; margin: 0 !important;
        position: relative !important; inset: auto !important;
        border: 0 !important; border-radius: 18px !important;
        background: #f1f1f1 !important; color: #0f0f0f !important;
        font: 600 13px/1.2 Arial,sans-serif !important;
        cursor: pointer !important; white-space: nowrap !important; box-shadow: none !important;
        appearance: none !important; opacity: 1 !important; visibility: visible !important;
      }
      .${BUTTON_CLASS}:hover { background: #d9d9d9 !important; }
      .${BUTTON_CLASS}.ytx-x-button {
        min-height: 34px !important; border-radius: 17px !important;
        background: #1d9bf0 !important; color: #fff !important;
      }
      .${BUTTON_CLASS}.ytx-x-button:hover { background: #1687d4 !important; }
      .ytx-x-download-slot {
        display: flex !important; justify-content: flex-end !important; align-items: center !important;
        flex: 0 0 auto !important; width: 100% !important; min-height: 38px !important;
        margin: 6px 0 2px !important; padding: 0 4px !important;
        position: relative !important; z-index: 2 !important; box-sizing: border-box !important;
      }
      #${PANEL_ID} {
        position: fixed; left: 20px; top: 20px; width: 460px;
        max-width: calc(100vw - 16px); max-height: min(72vh, 720px);
        overflow: auto; box-sizing: border-box; padding: 14px;
        border: 1px solid rgba(255,255,255,.14); border-radius: 12px;
        background: #141414; color: #eee; z-index: 2147483647;
        box-shadow: 0 10px 38px rgba(0,0,0,.5);
        font: 13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;
        isolation: isolate; opacity: 1 !important; pointer-events: auto !important;
      }
      #${PANEL_ID} * { box-sizing: border-box; }
      #${PANEL_ID} .ytx-head { display:flex; align-items:center; gap:8px; margin-bottom:10px; }
      #${PANEL_ID} .ytx-title { font-size:15px; font-weight:700; flex:1; }
      #${PANEL_ID} button { border:0; border-radius:7px; padding:7px 10px; cursor:pointer; background:#333; color:#fff; }
      #${PANEL_ID} button:hover { background:#444; }
      #${PANEL_ID} .ytx-format { padding:10px; margin:7px 0; border-radius:8px; background:#292929; cursor:pointer; }
      #${PANEL_ID} .ytx-format:hover { background:#363636; }
      #${PANEL_ID} .ytx-primary { font-weight:650; font-size:14px; }
      #${PANEL_ID} .ytx-secondary { color:#aaa; margin-top:3px; font-size:12px; word-break:break-word; }
      #${PANEL_ID} .ytx-tip { color:#aaa; padding:8px 1px; }
      #${PANEL_ID} .ytx-status { margin:9px 0 2px; padding:9px; border-radius:7px; background:#222; white-space:pre-wrap; }
      #${PANEL_ID} .ytx-status.error { color:#ff9f9f; }
      #${PANEL_ID} .ytx-status.ok { color:#9fffb5; }
      #${PANEL_ID} .ytx-security { margin-top:12px; padding-top:9px; border-top:1px solid #383838; color:#888; font-size:11px; }
      #${PANEL_ID} .ytx-loading { padding:18px 4px; color:#bbb; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function panel() {
    return document.getElementById(PANEL_ID);
  }

  function panelBody() {
    return panel()?.querySelector('[data-role="body"]') || null;
  }

  function setBodyMessage(body, className, text) {
    const message = document.createElement('div');
    message.className = className;
    message.textContent = text;
    body.replaceChildren(message);
    return message;
  }

  function positionPanel(anchor = state.activeAnchor) {
    const p = panel();
    if (!p || !anchor?.getBoundingClientRect) return;

    const rect = anchor.getBoundingClientRect();
    const padding = 8;
    const gap = 8;
    const viewportWidth = Math.max(0, window.innerWidth);
    const viewportHeight = Math.max(0, window.innerHeight);
    const maxWidth = Math.max(240, viewportWidth - padding * 2);
    const maxHeight = Math.max(160, viewportHeight - padding * 2);

    // Set the viewport-aware limit before measuring. The first render is only a
    // small loading shell; asynchronous X/HLS analysis can make the panel much
    // taller a moment later.
    p.style.maxWidth = `${Math.round(maxWidth)}px`;
    p.style.maxHeight = `${Math.round(maxHeight)}px`;

    const width = Math.min(p.offsetWidth || 460, maxWidth);
    const height = Math.min(p.offsetHeight || 320, maxHeight);
    let left = rect.right - width;
    if (left < padding) left = rect.left;
    left = Math.min(Math.max(padding, left), Math.max(padding, viewportWidth - width - padding));

    const belowTop = rect.bottom + gap;
    const belowSpace = viewportHeight - belowTop - padding;
    const aboveTop = rect.top - height - gap;
    const aboveSpace = rect.top - gap - padding;
    let top;
    if (belowSpace >= height) {
      top = belowTop;
    } else if (aboveTop >= padding) {
      top = aboveTop;
    } else {
      // If neither side can contain the panel, use the side with more room and
      // let the panel scroll internally instead of letting the page clip it.
      top = belowSpace >= aboveSpace ? belowTop : aboveTop;
    }
    top = Math.min(Math.max(padding, top), Math.max(padding, viewportHeight - height - padding));

    p.style.left = `${Math.round(left)}px`;
    p.style.top = `${Math.round(top)}px`;
  }

  function setStatus(text, type = '') {
    const p = panel();
    if (!p) return;
    let status = p.querySelector('[data-role="status"]');
    if (!status) {
      status = document.createElement('div');
      status.dataset.role = 'status';
      p.appendChild(status);
    }
    status.className = `ytx-status ${type}`.trim();
    status.textContent = text;
  }

  function makePanelShell(title, anchor) {
    const old = panel();
    state.panelResizeObserver?.disconnect();
    state.panelResizeObserver = null;
    old?.remove();
    state.activeAnchor = anchor || null;

    const p = document.createElement('div');
    p.id = PANEL_ID;

    const head = document.createElement('div');
    head.className = 'ytx-head';

    const titleElement = document.createElement('div');
    titleElement.className = 'ytx-title';
    titleElement.textContent = title;

    const refreshButton = document.createElement('button');
    refreshButton.type = 'button';
    refreshButton.dataset.role = 'refresh';
    refreshButton.textContent = '刷新';

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.dataset.role = 'close';
    closeButton.textContent = '关闭';

    const body = document.createElement('div');
    body.dataset.role = 'body';

    const security = document.createElement('div');
    security.className = 'ytx-security';
    security.textContent = '运行时网络白名单：YouTube / googlevideo.com / video.twimg.com；无第三方解析站、广告、统计、返利链接。';

    head.append(titleElement, refreshButton, closeButton);
    p.append(head, body, security);

    closeButton.onclick = () => {
      state.panelResizeObserver?.disconnect();
      state.panelResizeObserver = null;
      p.remove();
      state.activeAnchor = null;
    };
    refreshButton.onclick = () => refreshPanel(true);
    document.body.appendChild(p);
    positionPanel(anchor);

    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(() => {
        if (panel() !== p) {
          observer.disconnect();
          return;
        }
        positionPanel(anchor);
      });
      observer.observe(p);
      state.panelResizeObserver = observer;
    }
    return p;
  }

  function createFormatRow(primary, secondary, onClick) {
    const row = document.createElement('div');
    row.className = 'ytx-format';

    const primaryElement = document.createElement('div');
    primaryElement.className = 'ytx-primary';
    primaryElement.textContent = primary;

    const secondaryElement = document.createElement('div');
    secondaryElement.className = 'ytx-secondary';
    secondaryElement.textContent = secondary;

    row.append(primaryElement, secondaryElement);
    row.addEventListener('click', onClick);
    return row;
  }

  async function renderYoutube(force = false) {
    const id = getYoutubeVideoId();
    const body = panelBody();
    if (!body) return;

    if (!id) {
      setBodyMessage(body, 'ytx-tip', '请先打开 YouTube 视频/Shorts 页面。');
      return;
    }

    setBodyMessage(body, 'ytx-loading', '正在读取 YouTube 媒体信息……');
    setStatus('');

    try {
      const loaded = await loadYoutubeInfo(id, force);
      const merged = mergeCapturedYoutubeFormats(id, loaded.info);
      const { info, capturedCount, observedCount, capturedSummary } = merged;
      const sabrInfo = loaded.sabrInfo || null;
      const sabrPairs = getYoutubeSabrFormatPairs(sabrInfo);
      const client = loaded.client;
      const formats = getYoutubeVideoFormats(info);
      const title = sanitizeFilename(info.basic_info?.title || document.title.replace(/\s*-\s*YouTube\s*$/i, ''));

      body.replaceChildren();
      const tip = document.createElement('div');
      tip.className = 'ytx-tip';
      tip.textContent = `InnerTube client: ${client}；播放器请求捕获${state.youtubeNetworkCaptureInstalled ? '已启用' : '不可用'}${observedCount ? `；观察到 ${observedCount} 条媒体轨，新增 ${capturedCount} 条` : ''}${sabrPairs.length ? `；SABR 本地轨道 ${sabrPairs.length} 条` : ''}。1080p 以上通常是独立视频轨，点击后会自动选择同容器的最高质量音频并在浏览器内无损合并。`;
      body.appendChild(tip);

      if (!formats.length && !sabrPairs.length) {
        body.appendChild(document.createTextNode(
          hasYoutubeSabrStreaming(info)
            ? 'YouTube 当前只返回 SABR/分段流，没有可直接解码的媒体 URL；当前版本不会把它伪装成可下载项。'
            : '没有找到可用视频格式。'
        ));
        return;
      }

      const highestHeight = Math.max(
        0,
        ...formats.map((format) => Number(format.height || 0)),
        ...sabrPairs.map((pair) => Number(pair.video.height || 0))
      );
      if (highestHeight <= 360) {
        const captureHint = document.createElement('div');
        captureHint.className = 'ytx-tip';
        captureHint.textContent = `仍只有 360p：请先在 YouTube 播放器中手动选择 4K/最高画质并播放 3～5 秒，再点击“刷新”；脚本会捕获实际 googlevideo 视频轨和音频轨。${capturedSummary ? ` 当前观察：${capturedSummary}` : ' 当前没有观察到可识别的 videoplayback itag。'}`;
        body.appendChild(captureHint);
      }

      const directItags = new Set(formats.map((format) => Number(format.itag)));
      const sabrOnlyPairs = sabrPairs.filter((pair) => !directItags.has(Number(pair.video.itag)));
      for (const pair of sabrOnlyPairs) {
        const rawVideo = pair.rawVideo;
        const container = mimeContainer(rawVideo.mime_type) || 'mp4';
        const quality = pair.video.qualityLabel || (pair.video.height ? `${pair.video.height}p` : `itag ${pair.video.itag}`);
        const fps = rawVideo.fps ? `${rawVideo.fps}fps` : '';
        const size = formatBytes(pair.video.contentLength);
        const codec = codecLabel(rawVideo.mime_type);
        const primary = [quality, fps, container.toUpperCase(), 'SABR 本地合并'].filter(Boolean).join(' · ');
        const secondary = `${codec} · ${size} · itag ${pair.video.itag} · YouTube Server ABR，浏览器内合并音频`;

        const row = createFormatRow(primary, secondary, async () => {
          if (state.busy) {
            setStatus('已有下载/合并任务正在进行，请完成后再开始下一个。');
            return;
          }

          try {
            const fileHandle = await pickSaveFile(
              `${title} [${quality}${fps ? ` ${fps}` : ''}].${container}`,
              container
            );
            state.busy = true;
            setStatus(`正在通过 YouTube SABR 拉取 ${quality} 视频和音频……`);
            await remuxYoutubeSabrFormat(sabrInfo, pair, fileHandle, ({ bytes, ratio }) => {
              if (ratio == null) {
                setStatus(`正在浏览器内合并 SABR 流……\n已写入 ${formatBytes(bytes)}`);
              } else {
                setStatus(`正在浏览器内合并 SABR 流……\n${(ratio * 100).toFixed(1)}% · 已写入 ${formatBytes(bytes)}`);
              }
            });
            setStatus('完成：SABR 视频和音频已经在浏览器内无损合并并写入文件。', 'ok');
          } catch (error) {
            if (error?.name !== 'AbortError') showError(error);
          } finally {
            state.busy = false;
          }
        });
        body.appendChild(row);
      }

      // Validate the real result of Format.decipher before creating a row. The
      // Save File picker must be the first awaited operation in the click
      // handler, so discovering this failure on click would be too late.
      const preparedFormats = [];
      let rejectedFormatError = null;
      for (const format of formats) {
        const container = mimeContainer(format.mime_type);
        if (!container) continue;

        const hasSeparateAudio = !format.has_audio;
        const audio = hasSeparateAudio ? selectYoutubeAudioFormat(info, format) : null;
        if (hasSeparateAudio && !audio) continue;

        try {
          await decipherYoutubeFormat(info, format);
          if (audio) await decipherYoutubeFormat(info, audio);
          preparedFormats.push({ format, audio });
        } catch (error) {
          rejectedFormatError = error;
        }
      }

      if (!preparedFormats.length && !sabrOnlyPairs.length) {
        body.appendChild(document.createTextNode(
          rejectedFormatError?.message ||
          'YouTube 返回的格式无法解码，可能是 SABR/分段流；没有打开保存对话框。'
        ));
        return;
      }

      for (const { format, audio } of preparedFormats) {
        const container = mimeContainer(format.mime_type);
        if (!container) continue;

        const hasSeparateAudio = !format.has_audio;
        const quality = format.quality_label || (format.height ? `${format.height}p` : `itag ${format.itag}`);
        const fps = format.fps ? `${format.fps}fps` : '';
        const size = formatBytes(format.content_length);
        const codec = codecLabel(format.mime_type);
        const mode = hasSeparateAudio ? `浏览器内合并 + ${codecLabel(audio.mime_type)}` : '自带音频，直接下载';
        const flags = [format.ytx_captured ? '播放器捕获' : '', format.is_sr ? 'SR' : '', format.is_drc ? 'DRC' : ''].filter(Boolean).join(' ');
        const primary = [quality, fps, container.toUpperCase(), flags].filter(Boolean).join(' · ');
        const secondary = `${codec} · ${size} · itag ${format.itag} · ${mode}`;

        const row = createFormatRow(primary, secondary, async () => {
          if (state.busy) {
            setStatus('已有下载/合并任务正在进行，请完成后再开始下一个。');
            return;
          }

          try {
            if (hasSeparateAudio) {
              // Must be called directly from the user's click to preserve transient
              // user activation required by showSaveFilePicker().
              const extension = container;
              const fileHandle = await pickSaveFile(
                `${title} [${quality}${fps ? ` ${fps}` : ''}].${extension}`,
                extension
              );

              state.busy = true;
              setStatus('正在解析 YouTube 签名并准备媒体流……');

              await remuxYoutubeFormat(info, format, audio, fileHandle, ({ bytes, ratio }) => {
                if (ratio == null) {
                  setStatus(`正在浏览器内无损合并……\n已写入 ${formatBytes(bytes)}`);
                } else {
                  setStatus(`正在浏览器内无损合并……\n${(ratio * 100).toFixed(1)}% · 已写入 ${formatBytes(bytes)}`);
                }
              });

              setStatus('完成：视频和音频已经在浏览器内无损合并并写入文件。', 'ok');
            } else {
              state.busy = true;
              setStatus('正在解析 YouTube 媒体直链……');
              const url = await decipherYoutubeFormat(info, format);
              setStatus('已请求 Tampermonkey 开始下载。若未出现保存窗口，文件会进入浏览器默认下载目录；正在等待进度……');
              await directDownload(url, `${title} [${quality}].${container}`, ({ loaded, ratio }) => {
                if (ratio == null) {
                  setStatus(`Tampermonkey 正在下载……\n已接收 ${formatBytes(loaded)}`);
                } else {
                  setStatus(`Tampermonkey 正在下载……\n${(ratio * 100).toFixed(1)}% · 已接收 ${formatBytes(loaded)}`);
                }
              });
              setStatus('下载完成：Tampermonkey 已将文件保存到本机。', 'ok');
            }
          } catch (error) {
            if (error?.name !== 'AbortError') showError(error);
          } finally {
            state.busy = false;
          }
        });

        body.appendChild(row);
      }
    } catch (error) {
      body.replaceChildren();
      showError(error);
    }
  }

  async function renderX() {
    const body = panelBody();
    if (!body) return;

    setBodyMessage(body, 'ytx-loading', '正在检查当前页面已经加载的 X 视频资源……');
    setStatus('');

    const media = getRecentXMedia();
    if (!media.length) {
      setBodyMessage(body, 'ytx-tip', '还没有检测到 video.twimg.com 媒体。请先播放目标视频 1～2 秒，再点“刷新”。在单条推文详情页操作最准确。');
      return;
    }

    body.replaceChildren();
    const tip = document.createElement('div');
    tip.className = 'ytx-tip';
    tip.textContent = '只显示可用的视频源。初始化片段、单独音频、无视频轨的 HLS 清单和播放器临时请求会自动隐藏。';
    body.appendChild(tip);

    const latest = media.slice(0, 12);
    const mp4Urls = latest.filter((entry) => entry.type === 'mp4').map((entry) => entry.url);
    let hiddenCount = 0;
    for (const [itemIndex, item] of latest.entries()) {
      if (item.type === 'mp4') {
        const label = item.url.match(/\/(\d+)x(\d+)\//)?.slice(1).join('×') || 'MP4';
        const placeholder = createFormatRow(`X · ${label} · MP4（分析中…）`, '正在确认是否为完整 MP4、DASH/fMP4 或视频分片。', () => {});
        body.appendChild(placeholder);

        try {
          const analysis = await analyzeXMp4(item.url, mp4Urls);
          const primary = `X · ${analysis.width || '?'}×${analysis.height || '?'} · ${analysis.mode === 'direct' ? 'MP4' : '本地封装'}`;

          if (analysis.mode === 'direct') {
            const row = createFormatRow(primary, `${analysis.videoCodec || '视频'} + ${analysis.audioCodec || '音频'} · 已确认是完整 MP4，直接下载`, async () => {
              if (state.busy) {
                setStatus('已有下载任务正在进行，请完成后再开始下一个。');
                return;
              }

              state.busy = true;
              try {
                const downloadName = getXDownloadName(item, analysis, 'mp4', itemIndex);
                setStatus(`正在通过 Tampermonkey 下载 ${downloadName}…`);
                await directDownload(item.url, downloadName, ({ loaded, ratio }) => {
                  if (ratio == null) {
                    setStatus(`Tampermonkey 正在下载…\n已接收 ${formatBytes(loaded)}`);
                  } else {
                    setStatus(`Tampermonkey 正在下载…\n${(ratio * 100).toFixed(1)}% · 已接收 ${formatBytes(loaded)}`);
                  }
                });
                setStatus(`下载完成：${downloadName}`, 'ok');
              } catch (error) {
                if (error?.name !== 'AbortError') showError(error);
              } finally {
                state.busy = false;
              }
            });
            placeholder.replaceWith(row);
            continue;
          }

          const reason = [
            analysis.fragmented ? 'DASH/fMP4' : '',
            analysis.paired ? '视频/音频跨资源配对' : ''
          ].filter(Boolean).join(' + ');
          const primaryText = `${primary}${reason ? ` · ${reason}` : ''}`;
          const secondary = `${analysis.videoCodec || '视频'} + ${analysis.audioCodec || '音频'} · 浏览器内无损封装`;
          placeholder.replaceWith(createFormatRow(primaryText, secondary, async () => {
            if (state.busy) {
              setStatus('已有下载/合并任务正在进行，请完成后再开始下一个。');
              return;
            }

            try {
              const downloadName = getXDownloadName(item, analysis, 'mp4', itemIndex);
              const fileHandle = await pickSaveFile(downloadName, 'mp4');
              state.busy = true;
              setStatus(`正在读取 X ${reason || 'MP4'} 并在浏览器内无损封装……`);

              await remuxTracksToFile({
                videoTrack: analysis.videoTrack,
                audioTrack: analysis.audioTrack,
                inputs: analysis.inputs,
                fileHandle,
                preferredKind: 'mp4',
                expectedBytes: 0,
                onProgress: ({ bytes }) => {
                  setStatus(`正在读取 X ${reason || 'MP4'} 并封装……\n已写入 ${formatBytes(bytes)}`);
                }
              });

              setStatus('完成：X 视频和音频已在浏览器内封装为可播放文件。', 'ok');
            } catch (error) {
              if (error?.name !== 'AbortError') showError(error);
            } finally {
              state.busy = false;
            }
          }));
        } catch (error) {
          hiddenCount += 1;
          placeholder.remove();
          console.debug(`[${APP}] Ignored unusable X MP4 resource`, error?.message || error);
        }
        continue;
      }

      // HLS analysis is intentionally performed while rendering, not on the
      // download click. This lets the actual click immediately open the native
      // save picker (required by browser user-activation rules).
      const placeholder = createFormatRow('X · HLS（分析中…）', item.url, () => {});
      body.appendChild(placeholder);

      try {
        const analysis = await analyzeXHls(item.url);
        const primary = `X · ${analysis.width || '?'}×${analysis.height || '?'} · ${analysis.extension.toUpperCase()}`;
        const secondary = `${analysis.videoCodec} + ${analysis.audioCodec} · 浏览器内无损封装`;
        placeholder.querySelector('.ytx-primary').textContent = primary;
        placeholder.querySelector('.ytx-secondary').textContent = secondary;

        placeholder.onclick = null;
        placeholder.replaceWith(createFormatRow(primary, secondary, async () => {
          if (state.busy) {
            setStatus('已有下载/合并任务正在进行，请完成后再开始下一个。');
            return;
          }

          try {
            const downloadName = getXDownloadName(item, analysis, analysis.extension, itemIndex);
            const fileHandle = await pickSaveFile(downloadName, analysis.extension);
            state.busy = true;
            setStatus('正在读取 X HLS 分片并在浏览器内无损封装……');

            await remuxTracksToFile({
              videoTrack: analysis.videoTrack,
              audioTrack: analysis.audioTrack,
              inputs: [analysis.input],
              fileHandle,
              preferredKind: analysis.extension,
              expectedBytes: 0,
              onProgress: ({ bytes }) => {
                setStatus(`正在读取 X HLS 并封装……\n已写入 ${formatBytes(bytes)}`);
              }
            });

            setStatus('完成：X 视频已写入本地文件。', 'ok');
          } catch (error) {
            try { analysis.input.dispose(); } catch { /* ignore */ }
            if (error?.name !== 'AbortError') showError(error);
          } finally {
            state.busy = false;
          }
        }));
      } catch (error) {
        hiddenCount += 1;
        placeholder.remove();
        console.debug(`[${APP}] Ignored unusable X HLS resource`, error?.message || error);
      }
    }

    if (hiddenCount) {
      tip.textContent = `只显示可用的视频源；已自动隐藏 ${hiddenCount} 个初始化片段、单独音频或不可解析的播放器请求。`;
    }
    if (!body.querySelector('.ytx-format')) {
      const empty = document.createElement('div');
      empty.className = 'ytx-tip';
      empty.textContent = '当前没有找到可独立读取的视频源。请确认视频已播放，然后点击“刷新”；播放器产生的无效分片不会显示。';
      body.appendChild(empty);
    }
  }

  async function refreshPanel(forceYoutube = false) {
    if (!panel()) return;
    if (isYoutubeHost()) await renderYoutube(forceYoutube);
    else if (isXHost()) await renderX();
    positionPanel();
  }

  function togglePanel(anchor) {
    if (panel() && state.activeAnchor === anchor) {
      state.panelResizeObserver?.disconnect();
      state.panelResizeObserver = null;
      panel().remove();
      state.activeAnchor = null;
      return;
    }

    panel()?.remove();
    makePanelShell(isYoutubeHost() ? 'YouTube 直接下载' : 'X 直接下载', anchor);
    void refreshPanel(false).catch((error) => showError(error));
  }

  function findContextButtonFromEvent(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    for (const node of path) {
      if (node?.nodeType === 1 && node.matches?.(`.${BUTTON_CLASS}[data-ytx-action]`)) {
        return node;
      }
    }
    return event.target?.closest?.(`.${BUTTON_CLASS}[data-ytx-action]`) || null;
  }

  function handleContextButtonActivation(event) {
    const button = findContextButtonFromEvent(event);
    if (!button) return;

    // Handle the event at window-capture level. YouTube/X may clone or replace
    // the inserted node; delegated handling survives that replacement.
    event.preventDefault();
    event.stopImmediatePropagation();

    const now = Date.now();
    if (
      event.type === 'click' &&
      state.lastActivationButton === button &&
      now - state.lastActivationAt < 600
    ) {
      return;
    }

    state.lastActivationAt = now;
    state.lastActivationButton = button;
    togglePanel(button);
  }

  function installContextButtonActivation() {
    if (state.activationInstalled) return;
    state.activationInstalled = true;
    window.addEventListener('pointerup', handleContextButtonActivation, true);
    window.addEventListener('click', handleContextButtonActivation, true);
  }

  function createContextButton(label, title, className, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `${BUTTON_CLASS} ${className || ''}`.trim();
    button.dataset.ytxDownloadButton = 'true';
    button.dataset.ytxAction = action;
    button.setAttribute('aria-label', title);
    button.textContent = label;
    button.title = title;
    return button;
  }

  function ensureYoutubeButton() {
    if (!document.body) return;
    injectStyle();
    const selectors = [
      'ytd-watch-metadata #top-level-buttons-computed',
      '#below #top-level-buttons-computed',
      'ytd-watch-metadata #actions-inner',
      '#below #actions-inner'
    ];
    const mount = selectors.map((selector) => document.querySelector(selector)).find(Boolean);
    const existingButtons = [...document.querySelectorAll(`.${BUTTON_CLASS}.ytx-youtube-button`)];
    if (!mount) {
      existingButtons.forEach((button) => button.remove());
      return;
    }

    const existing = existingButtons.find((button) => mount.contains(button));
    existingButtons
      .filter((button) => button !== existing)
      .forEach((button) => button.remove());
    if (existing) return;

    const button = createContextButton('↓ 高清下载', '在当前 YouTube 视频下方打开下载选项', 'ytx-youtube-button', 'youtube');
    mount.appendChild(button);
  }

  function findXActionBar(article) {
    if (!article) return null;
    const action = article.querySelector(
      '[data-testid="reply"], [data-testid="retweet"], [data-testid="like"], [data-testid="unlike"]'
    );
    return action?.closest?.('[role="group"]') || null;
  }

  function ensureXButtons() {
    if (!document.body) return;
    injectStyle();

    const tweetSelector = 'article, [role="article"], [data-testid="tweet"]';
    const players = new Set([
      ...document.querySelectorAll('[data-testid="videoPlayer"], [data-testid="videoComponent"]'),
      ...[...document.querySelectorAll('video')]
        .map((video) => video.closest('[data-testid="videoPlayer"], [data-testid="videoComponent"]') || video.parentElement)
        .filter(Boolean)
    ]);

    for (const player of players) {
      const article = player.closest(tweetSelector);
      const existingSlot = article?.querySelector('.ytx-x-download-slot') ||
        (player.nextElementSibling?.matches?.('.ytx-x-download-slot') ? player.nextElementSibling : null);
      if (existingSlot?.querySelector(`.${BUTTON_CLASS}.ytx-x-button`)) continue;

      const slot = document.createElement('div');
      slot.className = 'ytx-x-download-slot';
      slot.dataset.ytxVideoDownload = 'true';
      const button = createContextButton('↓ 视频下载', '在这条 X 视频下方打开下载选项', 'ytx-x-button', 'x');
      slot.appendChild(button);

      // Prefer the stable gap immediately before X's reply/retweet/like bar.
      // This keeps the button below the media and out of the player's clipped
      // overlay tree. Fall back to the player's nearest top-level tweet block.
      const actionBar = findXActionBar(article);
      if (actionBar?.parentElement) {
        actionBar.parentElement.insertBefore(slot, actionBar);
      } else if (article) {
        let topLevelMedia = player;
        while (topLevelMedia.parentElement && topLevelMedia.parentElement !== article) {
          topLevelMedia = topLevelMedia.parentElement;
        }
        topLevelMedia.insertAdjacentElement('afterend', slot);
      } else {
        player.insertAdjacentElement('afterend', slot);
      }
    }

    // Remove slots whose video tweet was replaced by X's virtualized timeline.
    for (const slot of document.querySelectorAll('.ytx-x-download-slot')) {
      const owner = slot.closest(tweetSelector);
      const previous = slot.previousElementSibling;
      const hasPlayer = Boolean(
        previous?.matches?.('[data-testid="videoPlayer"], [data-testid="videoComponent"]') ||
        previous?.querySelector?.('video, [data-testid="videoPlayer"], [data-testid="videoComponent"]') ||
        owner?.querySelector('video, [data-testid="videoPlayer"], [data-testid="videoComponent"]')
      );
      if (!hasPlayer) slot.remove();
    }
  }

  function removeContextButtonsForOtherHost() {
    if (!isYoutubeHost()) {
      document.querySelectorAll(`.${BUTTON_CLASS}.ytx-youtube-button`).forEach((button) => button.remove());
    }
    if (!isXHost()) {
      document.querySelectorAll('.ytx-x-download-slot').forEach((slot) => slot.remove());
    }
  }

  function ensureContextButtons() {
    // Remove the old global control if a previous script version left it behind.
    document.getElementById(`${APP}-button`)?.remove();
    removeContextButtonsForOtherHost();
    if (isYoutubeHost()) ensureYoutubeButton();
    else if (isXHost()) ensureXButtons();
  }

  function scheduleEnsureContextButtons() {
    if (state.ensureScheduled) return;
    state.ensureScheduled = true;
    requestAnimationFrame(() => {
      state.ensureScheduled = false;
      try {
        handleLocationChange();
        ensureContextButtons();
      } catch (error) {
        console.error(`[${APP}] Failed to mount context buttons`, error);
      }
    });
  }

  function observeDynamicPage() {
    if (state.domObserver || !document.body) return;
    state.domObserver = new MutationObserver(() => scheduleEnsureContextButtons());
    state.domObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
    window.addEventListener('popstate', scheduleEnsureContextButtons);
    window.addEventListener('yt-navigate-finish', scheduleEnsureContextButtons);
    window.addEventListener('resize', () => positionPanel());
  }

  function handleLocationChange() {
    if (location.href === state.lastHref) return;
    state.lastHref = location.href;
    state.panelResizeObserver?.disconnect();
    state.panelResizeObserver = null;
    panel()?.remove();
    state.activeAnchor = null;

    // YouTube info is keyed by video ID and remains safe to cache. X media is
    // page-specific, so clear it to avoid offering an old tweet's stream.
    if (isYoutubeHost()) {
      state.youtubeNavigationStartedAt = performance.now();
      state.youtubeMedia.clear();
    }
    if (isXHost()) state.xMedia.clear();
  }

  function init() {
    if (!isYoutubeHost() && !isXHost()) return;
    ensureContextButtons();
    installYoutubeNetworkCapture();
    scanPerformanceForYoutubeMedia();
    scanPerformanceForXMedia();
    observeDynamicPage();
    setInterval(() => {
      handleLocationChange();
      ensureContextButtons();
    }, 1000);
  }

  // Install delegated activation at document-start, before site frameworks can
  // register competing global handlers. init() remains DOM-dependent.
  installContextButtonActivation();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
