# Sydney Hoops Stats

Look up any player by name and see their stats across Sydney local basketball competitions in one place.

| Source | Site | How it's scraped |
|---|---|---|
| Sydney Social Basketball | sydneysocialbasketball.com.au | SportsPress REST API (`/wp-json/sportspress/v2/players`), falling back to player profile pages found in the sitemap |
| The U League | theuleague.au | Cup Manager statistics pages (`/<year>,<edition>/result/statistics` and per-category pages) |
| The U League (archive) | theuleague.org.au | SportsPress `/player-stats/<division>/` list pages |

Sources are configured in [`scraper/sources.json`](scraper/sources.json). To add another competition that runs on SportsPress or Cup Manager, add an entry there. For a different platform, add a module in `scraper/lib/` and register it in `scrape.mjs`.

## Run it

```bash
cd hoops/scraper
npm install
npm test          # parser + crawler tests against local fixtures
npm run scrape    # writes ../data/players.json (npm run scrape -- ssb  scrapes a single source)
cd .. && npx serve .   # or: python3 -m http.server
```

Open `http://localhost:3000/?demo=1` to try the site with made-up demo data.

## How it works

- **Scraper** (`scraper/`): Node 18+ and cheerio. Requests are polite: one at a time per site with a delay, retries, a descriptive User-Agent, and `robots.txt` is honoured. Column headers are matched against synonyms (`PTS`/`Points`, `GP`/`Games`/`Apps`, …), so small layout changes don't break it. If a source fails, its previous data is kept and flagged as older data on the site.
- **Data** (`data/players.json`): every stat line is grouped under a player, matched by normalised name (case, accents and punctuation ignored).
- **Site** (`index.html`, `app.js`, `styles.css`): static, with no build step. It has name search with keyboard navigation, a leaders table, and a player page with career totals, per-game averages, a points-per-game chart and every competition line linked back to its source. Player pages have shareable URLs (`#/player/<id>`).
- **Automation** (`.github/workflows/hoops-scrape.yml`): scrapes daily, commits the updated `players.json`, and deploys `hoops/` to GitHub Pages. Enable Pages with *Settings → Pages → Source: GitHub Actions*. Scheduled runs only fire once the workflow is on the default branch.

## Caveats

- Players are matched by name. Two people with the same name will be merged, and one person whose name is spelt differently between leagues shows up twice.
- Only stats the leagues publish publicly can be shown. Check each competition's terms before publishing the site widely.
