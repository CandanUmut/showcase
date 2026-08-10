#!/usr/bin/env node
/**
 * Build-time data pipeline for the showcase.
 *
 * Discovers every live GitHub Pages site on the account, verifies each URL is
 * actually serving, enriches it with README + Open Graph metadata, resolves a
 * cover image, and writes src/data/projects.json.
 *
 * Nothing here runs in the browser. One unreachable site degrades to the next
 * image fallback; it never fails the build.
 */

import { readFile, writeFile, mkdir, access, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(ROOT, '.cache');
const SHOTS_DIR = path.join(ROOT, 'public', 'shots');
const OUT_FILE = path.join(ROOT, 'src', 'data', 'projects.json');

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const SKIP_SHOTS = process.argv.includes('--no-shots');
const API = 'https://api.github.com';

const log = {
  info: (...a) => console.log('  ', ...a),
  step: (...a) => console.log('\n▸', ...a),
  warn: (...a) => console.log('  !', ...a),
  drop: (...a) => console.log('  ✗', ...a)
};

/* ------------------------------------------------------------------ utils */

/** fetch with a hard timeout; never throws, returns null on any failure. */
async function safeFetch(url, { timeout = 15000, ...opts } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    return await fetch(url, { signal: ctrl.signal, redirect: 'follow', ...opts });
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function ghHeaders(accept = 'application/vnd.github+json') {
  const h = { Accept: accept, 'User-Agent': 'showcase-build' };
  if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
  return h;
}

/** Run tasks with bounded concurrency, preserving input order in the result. */
async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/* -------------------------------------------------------------- discovery */

/**
 * List every repo on the account.
 *
 * Primary path is the documented users/{user}/repos endpoint. Some sandboxed
 * build environments proxy api.github.com and only allow repo-scoped paths; in
 * that case we fall back to a checked-in dump so local iteration still works.
 */
async function listRepos(username) {
  const repos = [];
  for (let page = 1; page <= 20; page++) {
    const res = await safeFetch(
      `${API}/users/${username}/repos?per_page=100&sort=updated&page=${page}`,
      { headers: ghHeaders() }
    );
    if (!res || !res.ok) {
      if (page === 1) {
        log.warn(
          `users/${username}/repos unavailable (${res ? res.status : 'network error'}) — trying local dump`
        );
        // In CI, fall over loudly rather than shipping a snapshot that may be
        // months stale — the whole point of the daily run is fresh discovery.
        if (process.env.CI) {
          throw new Error(
            `Could not list repositories for ${username}. Refusing the local dump fallback in CI.`
          );
        }
        const dump = await readJson(path.join(CACHE_DIR, 'repos-dump.json'));
        if (dump) {
          log.info(`loaded ${dump.length} repos from .cache/repos-dump.json`);
          return dump;
        }
        throw new Error('Could not list repositories and no .cache/repos-dump.json fallback exists');
      }
      break;
    }
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos;
}

/**
 * has_pages tells us Pages was switched on, not that anything is being served.
 * A CNAME file at the repo root overrides the default *.github.io host.
 */
async function resolveUrl(repo, username) {
  const cname = await safeFetch(
    `https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch}/CNAME`,
    { timeout: 10000 }
  );
  if (cname && cname.ok) {
    const domain = (await cname.text()).trim().split('\n')[0].trim();
    if (domain && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) return `https://${domain}/`;
  }
  if (repo.name.toLowerCase() === `${username.toLowerCase()}.github.io`) {
    return `https://${username.toLowerCase()}.github.io/`;
  }
  return `https://${username.toLowerCase()}.github.io/${repo.name}/`;
}

/** A page only counts as live if it actually answers 2xx. */
async function verifyUrl(url) {
  let res = await safeFetch(url, { method: 'HEAD', timeout: 15000 });
  // Some static hosts mishandle HEAD; retry once with GET before giving up.
  if (!res || res.status === 405 || res.status === 403) {
    res = await safeFetch(url, { method: 'GET', timeout: 15000 });
  }
  return res && res.ok ? res.status : res ? res.status : 0;
}

/* --------------------------------------------------------------- metadata */

const BADGE_LINE = /^\s*(\[!\[|!\[|<)/;
const HEADING = /^\s{0,3}#{1,6}\s/;

/** First H1 and first real paragraph of prose. Badges, HTML and quotes skipped. */
function parseReadme(md) {
  if (!md) return { title: null, blurb: null };
  const lines = md.replace(/\r/g, '').split('\n');
  let title = null;
  const para = [];
  let inFence = false;
  let inComment = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (inComment) {
      if (line.includes('-->')) inComment = false;
      continue;
    }
    if (line.startsWith('<!--')) {
      if (!line.includes('-->')) inComment = true;
      continue;
    }
    if (line.startsWith('```') || line.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (!title) {
      const m = line.match(/^#\s+(.+)$/);
      if (m) {
        title = cleanInline(m[1]);
        continue;
      }
    }
    if (para.length === 0) {
      if (!line) continue;
      if (HEADING.test(line)) continue;
      if (BADGE_LINE.test(line)) continue;
      if (line.startsWith('>')) continue;
      if (/^([-*_])\1{2,}$/.test(line)) continue;
      if (/^[-*+]\s/.test(line) || /^\d+\.\s/.test(line)) continue;
      if (/^\|/.test(line)) continue;
      para.push(line);
      continue;
    }
    if (!line) break;
    if (HEADING.test(line)) break;
    para.push(line);
  }

  const blurb = cleanInline(para.join(' ')) || null;
  return { title, blurb };
}

/** Strip markdown emphasis/links/code so the text is safe as plain prose. */
function cleanInline(s) {
  return String(s)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchReadme(repo) {
  // Repo-scoped API first (works with a token), raw as a proxy-friendly backup.
  const api = await safeFetch(`${API}/repos/${repo.full_name}/readme`, {
    headers: ghHeaders('application/vnd.github.raw'),
    timeout: 15000
  });
  if (api && api.ok) return await api.text();

  for (const name of ['README.md', 'readme.md', 'README.MD', 'Readme.md']) {
    const raw = await safeFetch(
      `https://raw.githubusercontent.com/${repo.full_name}/${repo.default_branch}/${name}`,
      { timeout: 10000 }
    );
    if (raw && raw.ok) return await raw.text();
  }
  return null;
}

function metaTag(html, attr, value) {
  const re = new RegExp(
    `<meta[^>]+${attr}\\s*=\\s*["']${value}["'][^>]*>`,
    'i'
  );
  const tag = html.match(re)?.[0];
  if (!tag) return null;
  return decodeEntities(tag.match(/content\s*=\s*["']([^"']*)["']/i)?.[1] || '') || null;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/** Pull og:*, twitter:*, <title> and the favicon off the live page. */
async function fetchLiveMeta(url) {
  const res = await safeFetch(url, { timeout: 20000 });
  if (!res || !res.ok) return {};
  const html = (await res.text()).slice(0, 300_000);

  const abs = (href) => {
    if (!href) return null;
    try {
      return new URL(href, res.url || url).href;
    } catch {
      return null;
    }
  };

  const ogImage =
    metaTag(html, 'property', 'og:image') ||
    metaTag(html, 'name', 'og:image') ||
    metaTag(html, 'name', 'twitter:image');

  const iconHref = [...html.matchAll(/<link[^>]+>/gi)]
    .map((m) => m[0])
    .filter((t) => /rel\s*=\s*["'][^"']*icon[^"']*["']/i.test(t))
    .map((t) => t.match(/href\s*=\s*["']([^"']+)["']/i)?.[1])
    .find(Boolean);

  return {
    ogTitle:
      metaTag(html, 'property', 'og:title') ||
      metaTag(html, 'name', 'og:title') ||
      decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '') ||
      null,
    ogDescription:
      metaTag(html, 'property', 'og:description') ||
      metaTag(html, 'name', 'og:description') ||
      metaTag(html, 'name', 'description') ||
      null,
    ogImage: abs(ogImage),
    icon: abs(iconHref),
    themeColor: metaTag(html, 'name', 'theme-color')
  };
}

/* ------------------------------------------------------------------ cover */

const PALETTE = [
  ['#1B4D3E', '#8FD6BD'],
  ['#2B3A67', '#9DB4FF'],
  ['#5B2E4A', '#F2A8CF'],
  ['#4A3B1E', '#E8C46A'],
  ['#1F3F4D', '#7FD1E8'],
  ['#3D2A55', '#C4A6F5'],
  ['#4D2020', '#F0A08A'],
  ['#24402A', '#A8DD8C']
];

function hashInt(s) {
  return parseInt(crypto.createHash('sha1').update(s).digest('hex').slice(0, 8), 16);
}

/** Deterministic letter-mark: same repo always gets the same card. */
function letterMark(repo, title) {
  const [bg, fg] = PALETTE[hashInt(repo) % PALETTE.length];
  const initial = (title || repo).trim().charAt(0).toUpperCase() || '?';
  const angle = hashInt(repo + 'a') % 360;
  const safe = initial.replace(/[<>&"']/g, '');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 800" width="1280" height="800" role="img">` +
    `<defs><linearGradient id="g" gradientTransform="rotate(${angle} .5 .5)">` +
    `<stop offset="0" stop-color="${bg}"/><stop offset="1" stop-color="${shade(bg, -18)}"/></linearGradient></defs>` +
    `<rect width="1280" height="800" fill="url(#g)"/>` +
    `<circle cx="1060" cy="180" r="260" fill="${fg}" opacity="0.10"/>` +
    `<text x="640" y="400" font-family="Georgia, 'Times New Roman', serif" font-size="300" font-weight="700" ` +
    `fill="${fg}" text-anchor="middle" dominant-baseline="central">${safe}</text></svg>`
  );
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) =>
    Math.max(0, Math.min(255, v + amt))
  );
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}

const IMG_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/gif': '.gif'
};

/**
 * Copy a usable og:image into public/shots and return its local path.
 *
 * Hotlinking the origin would leave the showcase dependent on 56 other sites
 * staying up and keeping that exact asset path — one rename and a card renders
 * as a broken image. Returns null if the image is missing, not an image, or
 * implausibly small (favicons masquerading as og:image).
 */
async function localiseOgImage(repo, url) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const res = await safeFetch(url, { timeout: 15000 });
  if (!res || !res.ok) return null;

  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type && !type.startsWith('image/')) return null;
  if (type === 'image/svg+xml') return null;

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 5_000) return null;

  const ext = IMG_EXT[type] || path.extname(new URL(url).pathname).slice(0, 5) || '.png';
  const file = `${repo}-og${ext}`;
  await writeFile(path.join(SHOTS_DIR, file), buf);
  return `/shots/${file}`;
}

/* ------------------------------------------------------------ screenshots */

/**
 * Screenshots are keyed by the repo's head SHA, so a site that hasn't changed
 * is never re-shot. The manifest survives in .cache/ between CI runs.
 */
async function captureScreenshots(targets) {
  const manifestPath = path.join(CACHE_DIR, 'shots.json');
  const manifest = (await readJson(manifestPath, {})) || {};
  const stale = targets.filter(
    (t) => manifest[t.repo] !== t.sha || !existsSync(path.join(SHOTS_DIR, `${t.repo}.png`))
  );

  if (targets.length === 0) return manifest;
  log.info(`${targets.length} need a cover shot, ${targets.length - stale.length} already cached`);
  if (stale.length === 0) return manifest;

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    log.warn('playwright not installed — skipping screenshots, those entries fall back to letter-marks');
    return manifest;
  }

  // Chromium doesn't read HTTPS_PROXY from the environment the way fetch does.
  // In a proxied build sandbox it has to be told explicitly; in CI this is unset.
  // MITM proxies commonly reset Chromium's TLS 1.3 ClientHello, which surfaces
  // as ERR_CONNECTION_RESET on every navigation; capping at 1.2 gets through.
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || '';
  const launchOpts = {
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      ...(proxyUrl ? ['--ssl-version-max=tls1.2'] : [])
    ],
    ...(proxyUrl ? { proxy: { server: proxyUrl } } : {})
  };
  let browser;
  try {
    browser = await chromium.launch(launchOpts);
  } catch (err) {
    // Some images ship a pinned chromium whose build number doesn't match the
    // installed playwright. Point at whatever is actually on disk before giving up.
    const found = await findSystemChromium();
    if (found) {
      log.info(`using chromium at ${found}`);
      browser = await chromium
        .launch({ ...launchOpts, executablePath: found })
        .catch(() => null);
    }
    if (!browser) {
      log.warn(
        `could not launch chromium (${err.message.split('\n')[0]}) — falling back to letter-marks`
      );
      return manifest;
    }
  }

  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    colorScheme: 'dark'
  });

  await pool(stale, 4, async (t) => {
    const page = await ctx.newPage();
    try {
      await page.goto(t.url, { waitUntil: 'load', timeout: 30000 });
      // Games and WebGL scenes need a beat to render their first real frame;
      // waiting on networkidle never resolves for anything with a game loop.
      await page.waitForTimeout(4000);
      // Nudge dismissible intro dialogs out of the way so the shot shows the
      // actual product rather than a dimmed backdrop.
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(600);
      await page.screenshot({
        path: path.join(SHOTS_DIR, `${t.repo}.png`),
        clip: { x: 0, y: 0, width: 1280, height: 800 }
      });
      manifest[t.repo] = t.sha;
      log.info(`shot ${t.repo}`);
    } catch (err) {
      log.warn(`shot failed ${t.repo}: ${err.message.split('\n')[0]}`);
    } finally {
      await page.close().catch(() => {});
    }
  });

  await ctx.close().catch(() => {});
  await browser.close().catch(() => {});
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return manifest;
}

/**
 * Render the default social card: the same headline the hub leads with, over a
 * strip of real screenshots. Regenerated each build so the count stays true.
 */
async function makeSocialCard(projects, config) {
  const strip = projects
    .filter((p) => p.image && !p.image.startsWith('http'))
    .slice(0, 5)
    .map((p) => path.join(ROOT, 'public', p.image.replace(/^\//, '')))
    .filter((f) => existsSync(f));
  if (strip.length === 0) return false;

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return false;
  }

  const fontDir = path.join(ROOT, 'public', 'fonts');
  const asDataUri = async (file, mime) =>
    `data:${mime};base64,${(await readFile(file)).toString('base64')}`;

  const archivo = await asDataUri(
    path.join(fontDir, 'archivo-400-800-latin.woff2'),
    'font/woff2'
  ).catch(() => null);
  const plex = await asDataUri(
    path.join(fontDir, 'ibm-plex-sans-400-latin.woff2'),
    'font/woff2'
  ).catch(() => null);
  const tiles = await Promise.all(strip.map((f) => asDataUri(f, 'image/png')));

  const html = `<!doctype html><meta charset="utf-8"><style>
    ${archivo ? `@font-face{font-family:A;src:url(${archivo}) format('woff2');font-weight:400 800;font-stretch:100% 125%}` : ''}
    ${plex ? `@font-face{font-family:P;src:url(${plex}) format('woff2')}` : ''}
    *{box-sizing:border-box;margin:0}
    body{width:1200px;height:630px;background:#edf0f3;color:#16202b;
      font-family:P,sans-serif;display:flex;flex-direction:column;
      justify-content:space-between;padding:64px 64px 0}
    h1{font-family:A,sans-serif;font-weight:700;font-stretch:118%;font-size:76px;
      line-height:1.02;letter-spacing:-.02em;max-width:15ch}
    p{color:#54626f;font-size:25px;margin-top:22px;max-width:40ch}
    .strip{display:flex;gap:18px;margin-top:40px}
    .strip div{flex:1;aspect-ratio:16/10;background:#141b24;border-radius:10px 10px 0 0;
      border:1px solid rgba(22,32,43,.18);border-bottom:0;overflow:hidden}
    .strip img{width:100%;height:100%;object-fit:cover;object-position:top center;display:block}
  </style>
  <div><h1>${projects.length} things you can open right now.</h1>
  <p>${escapeHtml(config.tagline || '')}</p></div>
  <div class="strip">${tiles.map((t) => `<div><img src="${t}"></div>`).join('')}</div>`;

  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || '';
  const browser = await chromium
    .launch({
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
      ...((await findSystemChromium()) ? { executablePath: await findSystemChromium() } : {})
    })
    .catch(() => null);
  if (!browser) return false;

  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
    await page.setContent(html, { waitUntil: 'load' });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(ROOT, 'public', 'og-default.png') });
    return true;
  } catch {
    return false;
  } finally {
    await browser.close().catch(() => {});
  }
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

async function findSystemChromium() {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter(Boolean);
  const { readdir } = await import('node:fs/promises');
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    // Prefer the full chrome binary over headless_shell — the shell build is
    // stripped down and behaves differently behind a TLS-terminating proxy.
    for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell']) {
      for (const dir of entries.sort().reverse()) {
        const p = path.join(root, dir, rel);
        try {
          await access(p);
          return p;
        } catch {
          /* keep looking */
        }
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------- main */

async function main() {
  const config = await readJson(path.join(ROOT, 'showcase.config.json'), {});
  const overrides = (await readJson(path.join(ROOT, 'showcase.overrides.json'), {})) || {};
  const username = config.username;
  if (!username) throw new Error('showcase.config.json needs a "username"');

  await mkdir(CACHE_DIR, { recursive: true });
  await mkdir(SHOTS_DIR, { recursive: true });
  await mkdir(path.dirname(OUT_FILE), { recursive: true });

  log.step(`Listing repositories for ${username}${TOKEN ? '' : ' (unauthenticated — 60 req/hr)'}`);
  const all = await listRepos(username);
  log.info(`${all.length} repositories`);

  const candidates = all.filter(
    (r) => r.has_pages === true && r.archived === false && r.fork === false && !r.private
  );
  log.info(`${candidates.length} with Pages enabled, not archived, not forks`);

  log.step('Resolving and verifying live URLs');
  const verified = [];
  await pool(candidates, 8, async (repo) => {
    const o = overrides[repo.name] || {};
    const url = o.url || (await resolveUrl(repo, username));
    const status = await verifyUrl(url);
    if (status >= 200 && status < 300) {
      verified.push({ repo, url });
    } else {
      log.drop(`${repo.name} — ${url} returned ${status || 'no response'}`);
    }
  });
  verified.sort((a, b) => new Date(b.repo.pushed_at) - new Date(a.repo.pushed_at));
  log.info(`${verified.length} live, ${candidates.length - verified.length} dropped`);

  log.step('Reading READMEs and live page metadata');
  const enriched = await pool(verified, 6, async ({ repo, url }) => {
    const [md, meta] = await Promise.all([fetchReadme(repo), fetchLiveMeta(url)]);
    return { repo, url, readme: parseReadme(md), meta };
  });

  log.step('Resolving cover images');
  const needShot = [];
  const covers = await pool(enriched, 6, async (e) => {
    const o = overrides[e.repo.name] || {};
    if (o.image) return { kind: 'override', src: o.image };
    const og = await localiseOgImage(e.repo.name, e.meta.ogImage);
    if (og) return { kind: 'og', src: og };
    needShot.push({ repo: e.repo.name, url: e.url, sha: e.repo.pushed_at });
    return { kind: 'shot', src: null };
  });

  let manifest = {};
  if (SKIP_SHOTS) {
    log.info('--no-shots: skipping capture');
    manifest = (await readJson(path.join(CACHE_DIR, 'shots.json'), {})) || {};
  } else {
    manifest = await captureScreenshots(needShot);
  }

  log.step('Assembling projects.json');
  const uncategorized = [];
  const projects = [];

  for (let i = 0; i < enriched.length; i++) {
    const { repo, url, readme, meta } = enriched[i];
    const o = overrides[repo.name] || {};
    if (o.hidden === true) continue;

    const topics = o.topics || repo.topics || [];
    const category = o.category || categorize(topics, config.categories);
    if (!o.category && category === 'Other') uncategorized.push(repo.name);

    let cover = covers[i];
    if (cover.kind === 'shot') {
      const shotFile = path.join(SHOTS_DIR, `${repo.name}.png`);
      if (existsSync(shotFile)) {
        cover = { kind: 'shot', src: `/shots/${repo.name}.png` };
      } else {
        cover = { kind: 'letter', src: null };
      }
    }

    const title = o.title || pickTitle(repo, readme, meta);
    const blurb = o.blurb || pickBlurb(repo, readme, meta, title);

    const project = {
      repo: repo.name,
      slug: slugify(repo.name),
      title,
      blurb,
      description: repo.description || null,
      readmeBlurb: readme.blurb || null,
      url,
      source: repo.html_url,
      category,
      topics,
      language: repo.language || null,
      license: repo.license?.spdx_id && repo.license.spdx_id !== 'NOASSERTION' ? repo.license.spdx_id : null,
      stars: repo.stargazers_count || 0,
      pushedAt: repo.pushed_at,
      homepage: repo.homepage || null,
      featured: o.featured === true,
      image: cover.src,
      imageKind: cover.kind,
      letterMark: cover.kind === 'letter' ? letterMark(repo.name, title) : null,
      icon: meta.icon || null
    };
    projects.push(project);
  }

  // Featured first, then most recently pushed.
  projects.sort((a, b) => {
    if (a.featured !== b.featured) return a.featured ? -1 : 1;
    return new Date(b.pushedAt) - new Date(a.pushedAt);
  });

  const categories = {};
  for (const p of projects) categories[p.category] = (categories[p.category] || 0) + 1;

  await writeFile(
    OUT_FILE,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        username,
        counts: {
          repositories: all.length,
          pagesEnabled: candidates.length,
          live: verified.length,
          published: projects.length
        },
        categories,
        projects
      },
      null,
      2
    )
  );

  if (!SKIP_SHOTS) {
    const made = await makeSocialCard(projects, config);
    log.info(made ? 'social card written to public/og-default.png' : 'social card skipped');
  }

  log.step('Summary');
  log.info(`${projects.length} projects written to src/data/projects.json`);
  for (const [name, n] of Object.entries(categories).sort((a, b) => b[1] - a[1])) {
    log.info(`${String(n).padStart(3)}  ${name}`);
  }
  const byKind = projects.reduce((m, p) => ((m[p.imageKind] = (m[p.imageKind] || 0) + 1), m), {});
  log.info(`covers: ${Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join(', ')}`);

  if (uncategorized.length) {
    console.log(
      `\n⚠  ${uncategorized.length} repo(s) matched no category topic — add topics on GitHub or set "category" in showcase.overrides.json:`
    );
    console.log('   ' + uncategorized.join(', '));
  }
}

function categorize(topics, map = {}) {
  const set = new Set(topics.map((t) => t.toLowerCase()));
  for (const [name, keys] of Object.entries(map)) {
    if (keys.some((k) => set.has(k.toLowerCase()))) return name;
  }
  return 'Other';
}

/** Prefer a human-written title; fall back to a de-slugged repo name. */
function pickTitle(repo, readme, meta) {
  const candidates = [readme.title, meta.ogTitle].filter(Boolean);
  for (const c of candidates) {
    const t = c.replace(/\s*[|·—–-]\s*(GitHub Pages|Vite \+ React.*|React App)$/i, '').trim();
    if (t && t.length <= 60 && !/^(index|home|document|untitled|vite|react app)$/i.test(t)) return t;
  }
  return repo.name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/** Longest useful sentence-ish description we can find, trimmed for cards. */
function pickBlurb(repo, readme, meta, title) {
  const options = [readme.blurb, meta.ogDescription, repo.description].filter(
    (s) => s && s.trim().length > 12
  );
  if (options.length === 0) return null;
  let best = options.sort((a, b) => b.length - a.length)[0].trim();
  if (best.length > 320) {
    const cut = best.slice(0, 320);
    const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
    best = stop > 140 ? cut.slice(0, stop + 1) : cut.replace(/\s+\S*$/, '') + '…';
  }
  // Avoid a blurb that just repeats the title back at the visitor.
  if (best.toLowerCase() === String(title).toLowerCase()) return null;
  return best;
}

main().catch((err) => {
  console.error('\nfetch-projects failed:', err.message);
  process.exit(1);
});
