export function normalizeAudioLanguage(value) {
  const code = String(value || '').trim().replace(/_/g, '-');
  try { return Intl.getCanonicalLocales(code)[0]?.toLowerCase() || ''; }
  catch { return ''; }
}

export function audioLanguage(format) {
  return normalizeAudioLanguage(format?.language || format?.audio_track?.language_code
    || format?.audio_track?.id?.split('.')[0] || format?.audio_track_id?.split('.')[0]);
}

export function audioLanguageOptions(formats) {
  const options = new Map();
  for (const format of formats) {
    if (!format?.has_audio) continue;
    const code = audioLanguage(format);
    if (code && !options.has(code)) options.set(code, { code, name: format.audio_track?.display_name || '' });
  }
  return [...options.values()];
}

export function browserAudioLanguage(browser = globalThis.navigator) {
  return normalizeAudioLanguage(browser?.language || browser?.languages?.[0] || 'en');
}

function matchLanguage(code, preferred) {
  if (!code || !preferred) return 0;
  if (code === preferred) return 3;
  if (code.split('-')[0] !== preferred.split('-')[0]) return 0;
  try {
    if (new Intl.Locale(code).maximize().script === new Intl.Locale(preferred).maximize().script) return 2;
  } catch { /* Basic language matching remains available. */ }
  return 1;
}

function qualityScore(format) {
  return (format.audio_track?.audio_is_default ? 10_000_000_000 : 0)
    + (format.is_original ? 1_000_000_000 : 0)
    - (format.is_descriptive ? 30_000_000_000 : 0)
    - (format.is_secondary ? 20_000_000_000 : 0)
    - (format.is_drc ? 2_000_000_000 : 0)
    - (format.is_vb ? 1_000_000_000 : 0)
    + Number(format.bitrate || format.average_bitrate || 0);
}

export function selectAudioLanguageFormat(formats, selected = '', preferred = browserAudioLanguage()) {
  selected = normalizeAudioLanguage(selected);
  preferred = normalizeAudioLanguage(preferred);
  const candidates = selected ? formats.filter((format) => audioLanguage(format) === selected) : [...formats];
  candidates.sort((a, b) =>
    (selected ? 0 : matchLanguage(audioLanguage(b), preferred) - matchLanguage(audioLanguage(a), preferred))
    || qualityScore(b) - qualityScore(a)
  );
  return candidates[0] || null;
}

export function preferredAudioLanguage(formats, preferred = browserAudioLanguage()) {
  return audioLanguage(selectAudioLanguageFormat(formats.filter((format) => format?.has_audio), '', preferred));
}

export function audioLanguageLabel(code, locale = globalThis.navigator?.language || 'en') {
  try { return new Intl.DisplayNames([locale], { type: 'language' }).of(code) || code; }
  catch { return code; }
}
