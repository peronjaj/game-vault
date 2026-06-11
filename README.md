# PlayStation Gang Gang — auto-updating game catalogue

A static page (`index.html`) that lists every game in the shared library, ranked by
Metacritic score, with official key art pulled from [RAWG](https://rawg.io).
A GitHub Action rebuilds `games.json` every Monday from your Google Sheet — add a
game to the sheet, and it appears on the site automatically.

```
Google Sheet (games tab) ──▶ GitHub Action (weekly) ──▶ RAWG API ──▶ games.json ──▶ GitHub Pages
```

## One-time setup (≈15 minutes)

### 1. Make a SAFE games-only tab in your sheet
**Do not publish your main sheet — it contains emails.** In your spreadsheet,
add a new tab called `public-games` with a single header cell `Games` in A1, and in A2 put:

```
=FILTER('Sheet1'!C2:C, 'Sheet1'!C2:C<>"")
```

(adjust `Sheet1` and column `C` to wherever your Games column lives). This tab now
mirrors only the game names — no emails, no passwords, no names of who paid.

### 2. Publish that tab as CSV
File → Share → **Publish to web** → choose only the `public-games` tab → format **CSV** → Publish.
Copy the link (it ends in `output=csv`). Only this tab becomes public.

### 3. Get a free RAWG API key
Sign up at https://rawg.io/apidocs (free, 20k requests/month — a weekly run uses ~200).

### 4. Create the GitHub repo
1. Create a repository (e.g. `game-vault`), upload everything in this folder.
2. Settings → **Secrets and variables → Actions** → add two repository secrets:
   - `RAWG_API_KEY` — your key from step 3
   - `SHEET_CSV_URL` — the CSV link from step 2
3. Settings → **Pages** → Source: **GitHub Actions**.

### 5. Run it
Actions tab → "Update game catalogue" → **Run workflow**. After ~2 minutes the site
is live at `https://<your-username>.github.io/game-vault/`, and it re-runs every
Monday on its own. It also rebuilds whenever you edit `data/overrides.json`.

## How the messy sheet is handled
- Only the **Games** column is read; every other column and the guidelines/notes
  rows are ignored.
- Bracketed notes like `[PS+ EXTRA ACTIVE TIL ...]` are stripped; `PS+ Premium
  Library / monthly games / collection` entries are skipped.
- Shorthand is translated via the alias map in `scripts/build.mjs`
  (`FF9` → Final Fantasy IX, `Tony Hawk` → THPS 1+2, `Uncharted 1-3` → Nathan Drake
  Collection, `Tomb Raider 3` → Shadow of the Tomb Raider, …). Add new aliases there
  if you use new shorthand in the sheet.
- Cells that comma-splitting would break (`Dark Souls 1, 2, 3 …`) have explicit
  rewrites in `CELL_REWRITES`.
- Anything RAWG can't find is listed in `build-warnings.txt` after each run instead
  of silently disappearing — check it if a game is missing from the page.

## Scores
- **Metascore (critic)**: refreshed automatically from RAWG every run.
- **User score**: Metacritic has no public API for it, so it lives in
  `data/overrides.json` (pre-filled with a June 2026 snapshot). Edit that file on
  GitHub whenever you want — the site rebuilds automatically on commit. Games
  without a value show "–".
- `overrides.json` can also force a different cover (`img`), link (`link`),
  title, year, or DLC badge per game if RAWG ever picks the wrong match.

## Hosting alternatives
GitHub Pages is the default here because the updater and hosting live in one repo,
free. The same folder also deploys unchanged to **Cloudflare Pages** or **Netlify**
(point them at the repo; keep the GitHub Action for the weekly data refresh).
