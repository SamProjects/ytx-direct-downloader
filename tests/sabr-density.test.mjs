import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { StreamerContext_ClientInfo as ClientInfo } from '../node_modules/googlevideo/dist/protos/generated/video_streaming/streamer_context.js';

const source = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const start = source.indexOf('  function youtubeSabrClientInfo(info)');
const end = source.indexOf('  async function decipherYoutubeServerAbrUrl', start);
assert(start >= 0 && end > start);

function clientInfo(devicePixelRatio) {
  const context = vm.createContext({
    window: { devicePixelRatio, screen: { width: 1920, height: 1080 }, innerWidth: 1280, innerHeight: 720 },
    navigator: { language: 'en-US', platform: 'Windows' },
    state: {}, YOUTUBE_CLIENT_NAME_IDS: { WEB: 1 }
  });
  vm.runInContext(source.slice(start, end), context);
  return context.youtubeSabrClientInfo({});
}

test('reproduces the reported error using the actual SABR encoder', () => {
  assert.throws(() => ClientInfo.encode({ screenPixelDensity: 1.5 }).finish(), /invalid int32: 1\.5/);
});

test('fractional display scaling encodes and preserves the precise ratio', () => {
  for (const ratio of [0.5, 0.8, 1, 1.25, 1.5, 1.75, 2, 2.625, 3]) {
    const info = clientInfo(ratio);
    const decoded = ClientInfo.decode(ClientInfo.encode(info).finish());
    assert.equal(decoded.screenPixelDensity, Math.max(1, Math.round(ratio)));
    assert(Math.abs(decoded.screenDensityFloat - ratio) < 0.000001);
  }
});

test('invalid densities are omitted without breaking serialization', () => {
  for (const ratio of [undefined, NaN, Infinity, -1, 0, 2147483648]) {
    const info = clientInfo(ratio);
    assert.equal(info.screenPixelDensity, undefined);
    assert.equal(info.screenDensityFloat, undefined);
    assert.doesNotThrow(() => ClientInfo.encode(info).finish());
  }
});
