# Showcase

A static hub that discovers every live GitHub Pages site on the account and
presents them in one place, with an individually linkable page per project.

**Live:** https://candanumut.github.io/showcase/

Built with [Astro](https://astro.build) in static mode. All GitHub data is
resolved at build time — the browser fetches nothing. The only JavaScript that
ships is the ~40 lines that filter the already-rendered grid.

---

## How it works

```
scripts/fetch-projects.mjs  ──▶  src/data/projects.json  ──▶  astro build  ──▶  dist/
        │                                                        │
        └─ public/shots/*.png                                    └─ 65 static pages
           public/og-default.png
```

### 1. Discovery

`GET /users/{username}/repos`, paginated, then filtered to repos where
`has_pages` is true and the repo is not archived, not a fork and not private.

The live URL resolves in this order: a `CNAME` file at the repo root, then
`{username}.github.io` for the user site, then `{username}.github.io/{repo}/`.

**Every URL is then verified with a request.** This matters more than it
sounds: `has_pages` stays `true` after a Pages build breaks or a branch is
deleted, so trusting it produces dead links. Anything that doesn't answer 2xx
is dropped and logged. On the first full run that was 5 of 61.

### 2. Metadata

Per surviving repo, the script reads the README (first H1 as a title
candidate, first paragraph of actual prose as a blurb — badge lines, HTML
blocks, blockquotes, lists and tables are skipped) and the live page's HTML for
`og:title`, `og:description`, `og:image` and the favicon.

READMEs are deliberately **not** parsed for structure beyond that. Heading
conventions vary far too much between repos to derive categories from them.

### 3. Categories

Categories come from **GitHub topics**, mapped in `showcase.config.json`:

```json
{ "categories": { "Games": ["game", "arcade", "puzzle"] } }
```

Add a topic to a repo on GitHub and it files itself on the next build. Repos
matching no topic land in an `Other` bucket and are printed loudly at the end
of the build so you know which ones need attention.

At the time of writing, 1 of 160 repos had any topics set, so
`showcase.overrides.json` currently supplies them per repo (see below).

### 4. Cover images

Strict fallback order, first hit wins:

1. `overrides.image`
2. `og:image` from the live site — **copied into `public/shots/` at build
   time**, not hotlinked. Hotlinking would leave this site dependent on 56
   other sites keeping that exact asset path forever.
3. A Playwright screenshot of the live URL at 1280×800
4. A generated SVG letter-mark, with a colour derived from a hash of the repo
   name so it is stable across builds

Screenshots are cached in `.cache/shots.json`, keyed by the repo's last push
time, so unchanged sites are not re-captured on every build.

### 5. Resilience

Every network call is wrapped with a timeout and cannot throw. One unreachable
site degrades that single entry to the next image fallback and the build
continues. The build only fails if the repo list itself cannot be fetched.

---

## Overrides

`showcase.overrides.json` is keyed by repo name and wins over everything
auto-derived. This is how you fix a bad title without editing the other repo:

```json
{
  "hexodrop": {
    "title": "Hex Hive Drop",
    "blurb": "Tetris on a hexagonal hive that rotates under you.",
    "category": "Games",
    "topics": ["game", "puzzle", "arcade"],
    "featured": true
  }
}
```

Every field is optional: `title`, `blurb`, `category`, `topics`, `image`,
`url`, `featured`, `hidden`.

---

## Cross-linking — read this bit

`scripts/backlink-snippet.html` is a self-contained snippet to paste into each
individual project site. It is not decoration, and it is the difference
between this hub working and not working.

A hub that links out to 56 sites while none of them link back is, to a crawler,
a leaf node — a page that spends authority and receives none. Search engines
weight a page substantially by what links *to* it. Right now every one of those
56 project sites is an independent island with no inbound links; the hub can
list them, but listing alone doesn't make either end more findable.

Adding the backlink closes the loop in both directions:

- **Each project site gains an inbound link** from a page that is itself linked
  from every other project, so discovery no longer depends on someone already
  knowing the repo name.
- **The hub gains 56 inbound links**, which is what lets it rank for the
  author's name at all.
- **Crawlers get a connected component** instead of 57 disconnected pages.
  A crawler that finds any one project can now reach all of them.

The snippet is a plain `<a href>` with descriptive anchor text — no JavaScript,
because a link a crawler can't see contributes nothing. Paste it before
`</body>` on each project site.

---

## Local development

```bash
npm install
npm run fetch     # discover + verify + screenshot -> src/data/projects.json
npm run dev
```

`npm run fetch -- --no-shots` skips Playwright when you only want the data.

Set `GITHUB_TOKEN` to raise the API limit from 60 to 5,000 requests an hour;
with 160 repos to walk, the unauthenticated limit is not enough for a full run.

If `GET /users/{username}/repos` is unreachable — some sandboxed environments
proxy `api.github.com` and permit only repo-scoped paths — the script falls
back to `.cache/repos-dump.json`. That fallback is **refused when `CI` is set**,
so a scheduled run fails loudly rather than silently publishing stale data.

---

## Deployment

`.github/workflows/deploy.yml` runs on push to `main`, on manual dispatch, and
daily at 04:17 UTC so newly published repos appear without a push. It caches
npm, the Playwright browser download and the screenshot manifest between runs.

### Custom domain

There is no custom domain on this account, so there is deliberately **no
`public/CNAME`**. The site is served from the project path
`/showcase/`, which is why `astro.config.mjs` sets `base: '/showcase'`.

If you add a domain later: create `public/CNAME` containing the bare domain,
change `site` in `astro.config.mjs` to that origin, remove `base`, and update
the `Sitemap:` line in `public/robots.txt`. Every internal link goes through
the `url()` helper in `src/lib/paths.js`, so nothing else needs touching.

---

## Design notes

The subject is a body of shipped work, and the screenshots are the content —
the page's job is to frame them and get out of the way.

The measurement that drove the design: **42 of 52 screenshots are dark**, mean
luminance 57/255, mean saturation 19. On a light page, matting each of those on
white would put a hard edge around every card. So each card instead sits on a
dark "screen" surface (`#141b24`) that is flush with the dark shots and acts as
a bezel for the handful of light ones. The grid reads as a bank of monitors on
a pale wall.

Amber (`#e9a23b`) is the only saturated colour and is spent in exactly one
place: the rim-light that wakes a screen on hover **and on keyboard focus**.
Under `prefers-reduced-motion` the 2px rise is dropped but the rim-light stays,
because it is the affordance rather than the decoration.

Type is Archivo (variable, width axis pushed to 118%) for display and IBM Plex
Sans for body, both self-hosted as woff2 with `latin` and `latin-ext` subsets —
`latin-ext` because a third of these projects are bilingual Turkish/English and
`ğ`, `ş` and `İ` are not in the base subset.

Accessibility floor, all verified rather than assumed: responsive to 360px with
no horizontal overflow, visible focus on every interactive element, all text
at or above 4.5:1, explicit `width`/`height` and `aspect-ratio` on every image
so 56 lazy-loaded screenshots cause no layout shift.
