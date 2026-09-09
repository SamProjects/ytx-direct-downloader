// Use the preferred browser language, not any secondary language in the list.
export function usesChineseLanguage(browser = globalThis.navigator) {
  const language = browser?.language || browser?.languages?.[0] || 'en';
  return /^zh(?:[-_]|$)/i.test(language);
}

export const isChinese = usesChineseLanguage();
