# Sydney Hoops Stats

Look up any player by name and see their stats across Sydney local basketball competitions in one place.

| Source | Site | How it's collected |
|---|---|---|
| Sydney Social Basketball | sydneysocialbasketball.com.au | WordPress REST API (`/wp-json/wp/v2/match`): every match's box score. Stats are summed per player per division. A player's team is the one present in all their games. |
| The U League | theuleague.au | Cup Manager results API (`/rest/results_api/call`): season totals for every player in every division. |

Sources are configured in [`scraper/sources.json`](scraper/sources.json). To add a competition on another platform, add a module in `scraper/lib/` and register it in `scrape.mjs`.

## Run it

```bash
cd hoops/scraper
npm install
npm test              # parsers and crawlers against local fixtures
npm run scrape        # writes ../data/index.json and ../data/players/*.json
cd .. && npx serve .  # or: python3 -m http.server
```

The first Sydney Social Basketball scrape loads its whole match history (about 500 API pages) and takes a while. After that, runs only fetch matches changed since the last one. Open `http://localhost:3000/?demo=1` to try the site with made-up data.

## How it works

- **Scraper** (`scraper/`): Node 18+. Requests are polite: one at a time per site with a delay, retries, a descriptive User-Agent, and `robots.txt` is honoured. Only names, profile links and stats are kept. If a source fails, its last good data is reused and flagged as older data on the site.
- **Data** (`data/`, generated, not committed): `index.json` holds every player's name, teams and per-league totals, which is enough for search and leaders. `players/<n>.json` holds each player's individual lines and is loaded when you open a player. Players are matched across leagues by normalised name (case, accents and punctuation ignored).
- **Site** (`index.html`, `app.js`, `styles.css`): static, with no build step.
- **Automation** (`.github/workflows/hoops-scrape.yml`): scrapes daily, keeps the caches in the GitHub Actions cache, and deploys `hoops/` to GitHub Pages. Enable Pages with *Settings → Pages → Source: GitHub Actions*.

## Caveats

- Players are matched by name. Two people with the same name are merged, and one person whose name is spelt differently between leagues shows up twice.
- Sydney Social Basketball box scores don't record which team a player was on. When a player has only played one game in a division, both teams are shown.
- Only stats the leagues publish publicly are shown. Check each competition's terms before publishing the site widely.
