import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { Parser } from 'youtubei.js/web';
import { FormatXTags } from '../node_modules/youtubei.js/dist/protos/generated/misc/common.js';
import {
  audioLanguage, audioLanguageOptions, browserAudioLanguage,
  preferredAudioLanguage, selectAudioLanguageFormat
} from '../src/audio-language.js';

const audio = (language, fields = {}) => ({
  itag: 140, has_audio: true, has_video: false, language,
  mime_type: 'audio/mp4', bitrate: 128000,
  url: 'https://test.googlevideo.com/audio', ...fields
});

test('browser language wins over original/default audio and higher bitrate', () => {
  const english = audio('en', { is_original: true, audio_track: { audio_is_default: true }, bitrate: 256000 });
  const chinese = audio('zh-CN');
  assert.equal(selectAudioLanguageFormat([english, chinese], '', 'zh-CN'), chinese);
  assert.equal(preferredAudioLanguage([english, chinese], 'zh-CN'), 'zh-cn');
});

test('exact locale precedes same language; same script precedes other Chinese script', () => {
  const en = audio('en'), enUS = audio('en-US'), enGB = audio('en-GB');
  assert.equal(selectAudioLanguageFormat([en, enUS, enGB], '', 'en-GB'), enGB);
  const hans = audio('zh-Hans'), hant = audio('zh-Hant', { bitrate: 256000 });
  assert.equal(selectAudioLanguageFormat([hant, hans], '', 'zh-CN'), hans);
  assert.equal(selectAudioLanguageFormat([hans, hant], '', 'zh-TW'), hant);
});

test('missing preferred language falls back, and explicit selection never silently changes language', () => {
  const en = audio('en', { audio_track: { audio_is_default: true } });
  const ja = audio('ja', { bitrate: 256000 });
  assert.equal(selectAudioLanguageFormat([ja, en], '', 'fr'), en);
  assert.equal(selectAudioLanguageFormat([en, ja], 'ja', 'en'), ja);
  assert.equal(selectAudioLanguageFormat([en], 'ja', 'en'), null);
  assert.equal(browserAudioLanguage({ language: 'fr', languages: ['en', 'zh'] }), 'fr');
});

test('track IDs identify languages, same-language variants deduplicate, unlabelled audio stays usable', () => {
  const en = audio(null, { audio_track: { id: 'en.4', display_name: 'English' } });
  const unknown = audio(null);
  assert.equal(audioLanguage(en), 'en');
  assert.equal(audioLanguage(audio('zh_CN')), 'zh-cn');
  assert.deepEqual(audioLanguageOptions([en, audio('en'), unknown]), [{ code: 'en', name: 'English' }]);
  assert.equal(selectAudioLanguageFormat([unknown], '', 'zh-CN'), unknown);
});

test('descriptive audio does not replace a normal track of the same language', () => {
  const normal = audio('en');
  const description = audio('en', { is_descriptive: true, audio_track: { audio_is_default: true }, bitrate: 512000 });
  assert.equal(selectAudioLanguageFormat([description, normal], 'en'), normal);
});

const source = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
function functions(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
const context = vm.createContext({
  audioLanguage, selectAudioLanguageFormat, Parser, URL,
  navigator: { language: 'zh-CN' },
  isDrmFormat: () => false,
  hasYoutubeFormatSource: (format) => !!format.url,
  mimeContainer: (mime) => mime?.split('/')[1],
  state: { youtubeFormatMetadata: new Map() },
  YOUTUBE_ITAG_FALLBACKS: new Map([[140, ['audio', 'mp4', 0, 0]]])
});
vm.runInContext(functions('  function youtubeSabrFormatFromFormat', '  function scoreYoutubeSabrInfo'), context);
vm.runInContext(functions('  function selectYoutubeAudioFormat', '  async function decipherYoutubeFormat'), context);
vm.runInContext(functions('  function getYoutubeVideoFormats', '  function hasYoutubeSabrStreaming'), context);
vm.runInContext(functions('  function capturedYoutubeFormat', '  function mergeCapturedYoutubeFormats'), context);

test('ordinary and SABR paths select the requested language and preserve its audioTrackId', () => {
  const en = audio('en', { audio_track: { id: 'en.0', audio_is_default: true } });
  const zh = audio('zh-CN', { audio_track: { id: 'zh-CN.4' } });
  const video = { itag: 137, has_video: true, mime_type: 'video/mp4', url: 'https://test.googlevideo.com/video' };
  const info = { streaming_data: { server_abr_streaming_url: 'https://test.googlevideo.com/sabr', adaptive_formats: [video, en, zh] } };
  assert.equal(context.selectYoutubeAudioFormat(info, video, 'zh-cn'), zh);
  assert.equal(context.selectYoutubeSabrAudioFormat(info, video, 'zh-cn'), zh);
  assert.equal(context.getYoutubeSabrFormatPairs(info, 'zh-cn')[0].audio.audioTrackId, 'zh-CN.4');
  assert.equal(context.selectYoutubeAudioFormat(info, video, 'ja'), null);
});

test('progressive versions sharing an itag retain their language variants', () => {
  const en = audio('en', { has_video: true, mime_type: 'video/mp4' });
  const zh = audio('zh', { has_video: true, mime_type: 'video/mp4' });
  assert.equal(context.getYoutubeVideoFormats({ streaming_data: { formats: [en, zh] } }).length, 2);
});

test('captured xtags decode real language metadata instead of inheriting another language', () => {
  const xtags = Buffer.from(FormatXTags.encode({ xtags: [{ key: 'lang', value: 'ja' }, { key: 'acont', value: 'dubbed' }] }).finish()).toString('base64url');
  context.state.youtubeFormatMetadata.set('video', new Map([['140', audio('en')]]));
  const captured = context.capturedYoutubeFormat('video', { itag: 140, xtags, kind: 'audio', url: 'https://test.googlevideo.com/audio' });
  assert.equal(audioLanguage(captured), 'ja');
  assert.equal(captured.xtags, xtags);
});
