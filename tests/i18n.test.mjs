import assert from 'node:assert/strict';
import test from 'node:test';
import { usesChineseLanguage } from '../src/i18n.js';

test('Chinese locales use the Chinese UI', () => {
  for (const language of ['zh', 'zh-CN', 'zh-TW', 'zh-HK', 'zh-Hans', 'zh-Hant-TW', 'ZH_cn']) {
    assert.equal(usesChineseLanguage({ language }), true, language);
  }
});

test('Other preferred languages use English even if Chinese is secondary', () => {
  for (const language of ['en-US', 'ja', 'fr', 'de', 'ko', 'zhx']) {
    assert.equal(usesChineseLanguage({ language, languages: [language, 'zh-CN'] }), false, language);
  }
});

test('Missing language falls back to first language, then English', () => {
  assert.equal(usesChineseLanguage({ languages: ['zh-TW', 'en'] }), true);
  assert.equal(usesChineseLanguage({ languages: ['en', 'zh-CN'] }), false);
  assert.equal(usesChineseLanguage({}), false);
  assert.equal(usesChineseLanguage(null), false);
});
