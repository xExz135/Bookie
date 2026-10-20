/**
 * Turns the dataset's language codes (mostly ISO 639-2 like "eng", "spa",
 * plus BCP 47 like "en-US") into BCP 47 tags. Unknown three-letter codes are
 * kept as they are (still valid BCP 47); "mul", "und" and blanks become null.
 */
const ISO_639_2_TO_1: Record<string, string> = {
  ara: 'ar',
  bul: 'bg',
  cat: 'ca',
  chi: 'zh',
  cze: 'cs',
  dan: 'da',
  dut: 'nl',
  eng: 'en',
  est: 'et',
  fil: 'fil',
  fin: 'fi',
  fre: 'fr',
  ger: 'de',
  gre: 'el',
  heb: 'he',
  hin: 'hi',
  hrv: 'hr',
  hun: 'hu',
  ind: 'id',
  ita: 'it',
  jpn: 'ja',
  kor: 'ko',
  lit: 'lt',
  lav: 'lv',
  may: 'ms',
  msa: 'ms',
  nob: 'nb',
  nor: 'no',
  per: 'fa',
  pol: 'pl',
  por: 'pt',
  rum: 'ro',
  rus: 'ru',
  scr: 'hr',
  slo: 'sk',
  slv: 'sl',
  spa: 'es',
  srp: 'sr',
  swe: 'sv',
  tha: 'th',
  tur: 'tr',
  ukr: 'uk',
  vie: 'vi',
  zho: 'zh',
};

export function toBcp47(code: unknown): string | null {
  if (typeof code !== 'string') return null;
  const trimmed = code.trim();
  if (trimmed === '' || trimmed === 'mul' || trimmed === 'und') return null;
  const lower = trimmed.toLowerCase();
  if (ISO_639_2_TO_1[lower]) return ISO_639_2_TO_1[lower];
  // BCP 47 with a region ("en-US"): language lowercase, region uppercase.
  const match = /^([a-z]{2,3})-([a-z]{2})$/i.exec(trimmed);
  if (match) return `${match[1]!.toLowerCase()}-${match[2]!.toUpperCase()}`;
  return /^[a-z]{2,3}$/.test(lower) ? lower : null;
}
