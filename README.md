# FoxtelEPG

Foxtel TV Guide — FOX CRICKET HD (501) + FOX SPORTS 505 (505)
Auto-updated daily via GitHub Actions. Hosted free on GitHub Pages.
21 days of schedule history stored as JSON.

## Setup (one time only)

### 1. Enable GitHub Pages
- Go to repo Settings → Pages
- Source: Deploy from branch → `main` → `/docs`
- Save → your site will be at `https://jinx8004new.github.io/FoxtelEPG`

### 2. Enable GitHub Actions write permission
- Go to repo Settings → Actions → General
- Under "Workflow permissions" → select "Read and write permissions"
- Save

### 3. Run first fetch manually
- Go to Actions tab → "Fetch Foxtel Schedule" → "Run workflow"
- This populates the first day of data immediately

### 4. Done
After that, the Action runs automatically every day at midnight IST (18:30 UTC).

## File structure

```
FoxtelEPG/
├── .github/
│   └── workflows/
│       └── fetch-schedule.yml   ← runs daily, commits JSON
├── data/
│   ├── index.json               ← list of available dates per channel
│   ├── FS1/
│   │   ├── 2026-03-14.json
│   │   ├── 2026-03-15.json
│   │   └── ...
│   └── FSP/
│       ├── 2026-03-14.json
│       └── ...
└── docs/
    └── index.html               ← GitHub Pages frontend
```

## How it works

1. GitHub Action fetches Foxtel API daily at midnight IST
2. Strips `?maxheight=90` from image URLs → original quality
3. Saves JSON to `data/FS1/YYYY-MM-DD.json`
4. Deletes files older than 21 days
5. Updates `data/index.json` with list of available dates
6. Commits and pushes — GitHub Pages serves the frontend automatically

## Viewing past days

The frontend shows a date picker with all 21 days of history.
Click any date pill to view that day's schedule.
