// Generic parsing of HTML stat tables into normalised stat lines.
// Column headers vary by platform (SportsPress, Cup Manager, hand-built pages),
// so columns are matched against a list of synonyms.

export const STAT_KEYS = ['gp', 'pts', 'reb', 'ast', 'stl', 'blk', 'threes', 'fouls'];
export const AVG_KEYS = { pts: 'ppg', reb: 'rpg', ast: 'apg', stl: 'spg', blk: 'bpg' };

const SYNONYMS = {
  name: ['name', 'player', 'playername', 'players', 'fullname', 'athlete'],
  number: ['#', 'no', 'num', 'number', 'jersey'],
  team: ['team', 'club', 'teamname'],
  season: ['season', 'year', 'competition', 'league', 'division', 'grade', 'category'],
  gp: ['gp', 'g', 'games', 'gamesplayed', 'played', 'apps', 'appearances', 'eventsplayed', 'matches', 'mp', 'gms'],
  pts: ['pts', 'points', 'totalpoints', 'p', 'goals', 'tp'],
  ppg: ['ppg', 'pts/g', 'ptsg', 'avgpts', 'pointspergame', 'averagepoints', 'ptspg', 'avg'],
  reb: ['reb', 'rebs', 'rebounds', 'r', 'trb', 'tot'],
  rpg: ['rpg', 'reb/g', 'rebg', 'reboundspergame'],
  ast: ['ast', 'asts', 'assists', 'a'],
  apg: ['apg', 'ast/g', 'astg', 'assistspergame'],
  stl: ['stl', 'stls', 'steals', 's'],
  spg: ['spg', 'stl/g', 'stealspergame'],
  blk: ['blk', 'blks', 'blocks', 'b', 'bs'],
  bpg: ['bpg', 'blk/g', 'blockspergame'],
  threes: ['3pm', '3pt', '3pts', 'threes', '3s', '3p', '3fgm', 'threepointers', '3pointers'],
  fouls: ['pf', 'fouls', 'f', 'personalfouls'],
};

const LOOKUP = new Map();
for (const [field, words] of Object.entries(SYNONYMS)) {
  for (const w of words) if (!LOOKUP.has(w)) LOOKUP.set(w, field);
}

export const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const headerKey = (s) => clean(s).toLowerCase().replace(/[^a-z0-9#/]/g, '');

export function fieldForHeader(text, className = '') {
  const key = headerKey(text);
  if (LOOKUP.has(key)) return LOOKUP.get(key);
  // SportsPress marks columns with classes like "data-pts" / "data-name".
  for (const cls of className.split(/\s+/)) {
    const m = /^data-(.+)$/.exec(cls);
    if (m && LOOKUP.has(headerKey(m[1]))) return LOOKUP.get(headerKey(m[1]));
  }
  return null;
}

export function toNumber(v) {
  const s = clean(v).replace(/,/g, '');
  if (!s || s === '-' || s === '—') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
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

// Fill totals from averages (and vice versa) where one is missing.
export function normaliseLine(line) {
  const out = { ...line };
  for (const [total, avg] of Object.entries(AVG_KEYS)) {
    if (out[total] == null && out[avg] != null && out.gp) out[total] = Math.round(out[avg] * out.gp);
    delete out[avg];
  }
  for (const k of STAT_KEYS) if (out[k] == null) delete out[k];
  return out;
}

const hasStats = (line) => STAT_KEYS.some((k) => k !== 'gp' && line[k] != null) || Object.values(AVG_KEYS).some((k) => line[k] != null);

function headingFor($, table) {
  const caption = clean($(table).find('caption').first().text());
  if (caption) return caption;
  let node = $(table);
  for (let depth = 0; depth < 6 && node.length; depth++) {
    const prev = node.prevAll('h1,h2,h3,h4,h5,.sp-table-caption,.title').first();
    if (prev.length) return clean(prev.text());
    node = node.parent();
  }
  return '';
}

/**
 * Parse every stat table on a page.
 * @param $ cheerio root
 * @param ctx { pageTitle, pageUrl, playerName? } — when playerName is set the page is a
 *            single player's profile, so tables need no name column.
 * @returns array of stat lines: { name, team, competition, season, gp, pts, ..., url, playerUrl }
 */
export function extractTables($, ctx) {
  const lines = [];
  $('table').each((_, table) => {
    const headRow = $(table).find('thead tr').last().length
      ? $(table).find('thead tr').last()
      : $(table).find('tr').first();
    const fields = [];
    headRow.find('th,td').each((i, th) => fields.push(fieldForHeader($(th).text(), $(th).attr('class') || '')));
    if (!fields.length) return;
    const nameIdx = fields.indexOf('name');
    if (nameIdx === -1 && !ctx.playerName) return;
    if (!fields.some((f) => f && f !== 'name' && f !== 'team' && f !== 'number' && f !== 'season')) return;

    const heading = headingFor($, table);
    const bodyRows = $(table).find('tbody tr').length ? $(table).find('tbody tr') : $(table).find('tr').slice(1);
    bodyRows.each((_, tr) => {
      const cells = $(tr).find('td,th');
      if (cells.length < 2) return;
      const line = {};
      let playerUrl = null;
      cells.each((i, td) => {
        const field = fields[i];
        if (!field) return;
        const text = clean($(td).text());
        if (field === 'name') {
          line.name = cleanName(text);
          const href = $(td).find('a').attr('href');
          if (href) playerUrl = new URL(href, ctx.pageUrl).href;
        } else if (field === 'team' || field === 'season') {
          line[field] = text;
        } else if (field !== 'number') {
          const n = toNumber(text);
          if (n != null) line[field] = n;
        }
      });
      if (ctx.playerName) line.name = ctx.playerName;
      if (!line.name || /^(total|totals|career|average|team)$/i.test(line.name)) return;
      if (line.season && /^(total|career)/i.test(line.season)) return;
      if (!hasStats(line)) return;
      lines.push(normaliseLine({
        ...line,
        competition: heading || ctx.pageTitle || '',
        url: ctx.pageUrl,
        playerUrl: playerUrl || (ctx.playerName ? ctx.pageUrl : null),
      }));
    });
  });
  return lines;
}

export function pageTitle($) {
  return clean($('h1').first().text()) || clean($('title').text()).replace(/\s*[-|–].*$/, '');
}
