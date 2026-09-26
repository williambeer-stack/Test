// Shared helpers for normalising names and stat lines.

export const STAT_KEYS = ['gp', 'pts', 'reb', 'ast', 'stl', 'blk'];

export const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

export function toInt(v) {
  const n = parseInt(String(v ?? '').replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

export function cleanName(raw) {
  return clean(raw)
    .replace(/^#?\d+\s*[.\-–]?\s+/, '') // leading jersey number
    .replace(/\s*\(\s*#?\d+\s*\)\s*$/, '') // trailing "(12)"
    .replace(/\s*#\d+\s*$/, '');
}

// Key used to merge the same person across competitions.
export function nameKey(name) {
  return cleanName(name)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, '')
    .replace(/['-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// "Caringbah Monday (Mens) 2025 S1" -> { comp: "Caringbah Monday (Mens)", season: "2025 S1" }
export function splitSeason(label, fallbackYear = '') {
  const text = clean(label);
  const m = /^(.*?)[\s,–-]+((?:19|20)\d\d\b.*)$/.exec(text);
  if (m && m[1]) return { comp: m[1].trim(), season: m[2].trim() };
  return { comp: text, season: String(fallbackYear) };
}
