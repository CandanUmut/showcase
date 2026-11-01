// Posts ONE announcement per run to Mastodon and/or Bluesky: the oldest due queue file, or, when
// nothing is queued, the next app in the daily rotation (see "Rotation" below).
//
// Queue: announce/queue/YYYY-MM-DD-<name>.json  →  { "text": "I made … https://… #opensource" }
// A file becomes due on its date (UTC). The oldest due file is posted; when every configured
// network has it, the file moves to announce/posted/ with the post links added.
// If one network fails, the ones that worked are recorded in the file so they are never posted twice.
//
// Accounts are optional and come only from environment variables (GitHub Actions secrets):
//   MASTODON_INSTANCE (e.g. https://mastodon.social), MASTODON_TOKEN (write:statuses)
//   BLUESKY_HANDLE (e.g. you.bsky.social), BLUESKY_APP_PASSWORD (an app password, not your login password)
// With no accounts configured it does nothing. DRY_RUN=1 prints what would be posted.

import { readdir, readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const QUEUE = 'announce/queue';
const POSTED = 'announce/posted';
const BSKY = process.env.BLUESKY_SERVICE || 'https://bsky.social';
const dry = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const today = new Date().toISOString().slice(0, 10);

const networks = {
  mastodon: !!(process.env.MASTODON_INSTANCE && process.env.MASTODON_TOKEN),
  bluesky: !!(process.env.BLUESKY_HANDLE && process.env.BLUESKY_APP_PASSWORD),
};

async function main() {
  const enabled = Object.keys(networks).filter((n) => networks[n]);
  if (!enabled.length && !dry) {
    console.log('No social accounts configured yet (see announce/README.md). Nothing to do.');
    return;
  }
  const files = (await readdir(QUEUE).catch(() => [])).filter((f) => /^\d{4}-\d{2}-\d{2}-.+\.json$/.test(f)).sort();
  const due = files.find((f) => f.slice(0, 10) <= today);
  if (!due) {
    console.log(`Nothing due in the queue (queue: ${files.length}). Using the rotation.`);
    return rotate(enabled);
  }
  const path = join(QUEUE, due);
  const item = JSON.parse(await readFile(path, 'utf8'));
  check(item.text, due);
  item.posted ??= {};

  await postEverywhere(item, enabled, due, due); // same Mastodon idempotency key as before
  if (dry) return;
  await writeFile(path, JSON.stringify(item, null, 2) + '\n');
  if (enabled.every((n) => item.posted[n])) {
    await mkdir(POSTED, { recursive: true });
    await rename(path, join(POSTED, due));
    // Tell the rotation this app was just announced, so it doesn't come round again straight away.
    const url = firstUrl(item.text);
    if (url) {
      const state = await readState();
      state.lastPosted[normUrl(url)] = today;
      await writeFile(STATE, JSON.stringify(state, null, 2) + '\n');
    }
  }
}

/** Posts item.text to every enabled network that doesn't have it yet; fills item.posted. */
async function postEverywhere(item, enabled, key, label) {
  for (const n of dry ? Object.keys(networks) : enabled) {
    if (item.posted[n]) continue;
    if (dry) {
      console.log(`[dry run] ${n}: ${JSON.stringify(item.text)}`);
      if (n === 'bluesky') console.log('[dry run] bluesky facets:', JSON.stringify(facets(item.text)));
      continue;
    }
    try {
      item.posted[n] = n === 'mastodon' ? await postMastodon(item.text, key) : await postBluesky(item.text);
      console.log(`Posted ${label} to ${n}: ${item.posted[n]}`);
    } catch (e) {
      console.error(`Failed to post ${label} to ${n}: ${e.message}`);
      process.exitCode = 1;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Rotation: when the queue is empty, post about one app a day, forever.
//
// announce/apps.json   — the apps with hand-written posts (several each), plus a "skip" list.
// announce/rotation.json — written by this script: when each app was last posted, which of its
//                          posts were used, and a short history with links.
// Live GitHub Pages sites on the account that aren't in apps.json get a short generic post built
// from the repo description (repos with no description are skipped). Repos on the skip list are
// never posted. The app posted longest ago (or never) goes next; its posts are used in order and
// start over once all are used. A site that doesn't load is skipped that day.
// ---------------------------------------------------------------------------------------------

const APPS = 'announce/apps.json';
const STATE = 'announce/rotation.json';

async function readState() {
  const s = JSON.parse(await readFile(STATE, 'utf8').catch(() => '{}'));
  return { lastPosted: s.lastPosted ?? {}, used: s.used ?? {}, pending: s.pending ?? null, history: s.history ?? [] };
}

async function rotate(enabled) {
  const cfg = JSON.parse(await readFile(APPS, 'utf8'));
  const state = await readState();
  let job = state.pending;

  if (job) {
    console.log(`Finishing yesterday's unfinished post for ${job.app}.`);
  } else {
    const pool = await buildPool(cfg);
    const order = new Map(pool.map((a, i) => [a.app, i]));
    pool.sort((a, b) =>
      (state.lastPosted[normUrl(a.url)] ?? '').localeCompare(state.lastPosted[normUrl(b.url)] ?? '') ||
      order.get(a.app) - order.get(b.app));
    let pick;
    for (const a of pool) {
      if (await isUp(a.url)) { pick = a; break; }
      console.warn(`Skipping ${a.app} today: ${a.url} did not load.`);
    }
    if (!pick) {
      console.log('No app available to post today.');
      return;
    }
    let used = state.used[pick.app] ?? [];
    let variant = pick.posts.findIndex((_, i) => !used.includes(i));
    if (variant === -1) {
      used = [];
      variant = 0;
    }
    job = { date: today, app: pick.app, url: pick.url, variant, text: pick.posts[variant], posted: {} };
    state.used[pick.app] = used;
  }

  check(job.text, job.app);
  await postEverywhere(job, enabled, `rotation-${job.date}-${job.app}-${job.variant}`, job.app);
  if (dry) return;

  if (enabled.every((n) => job.posted[n])) {
    state.pending = null;
    state.lastPosted[normUrl(job.url)] = today;
    state.used[job.app] = [...(state.used[job.app] ?? []), job.variant];
    state.history.unshift({ date: today, app: job.app, variant: job.variant, links: job.posted });
    state.history = state.history.slice(0, 120);
  } else {
    state.pending = job; // retried first on the next run; networks that worked are not posted again
  }
  await writeFile(STATE, JSON.stringify(state, null, 2) + '\n');
}

async function buildPool(cfg) {
  const skip = new Set((cfg.skip ?? []).map((s) => s.toLowerCase()));
  // Anything hidden on the showcase site is never announced either.
  const overrides = JSON.parse(await readFile('showcase.overrides.json', 'utf8').catch(() => '{}'));
  for (const [name, o] of Object.entries(overrides)) if (o?.hidden === true) skip.add(name.toLowerCase());
  const pool = Object.entries(cfg.apps ?? {})
    .filter(([app, v]) => !skip.has(app.toLowerCase()) && v.posts?.length)
    .map(([app, v]) => ({ app, url: v.url, posts: v.posts }));
  const known = new Set(pool.flatMap((a) => [a.app.toLowerCase(), normUrl(a.url)]));

  for (const r of await discover(cfg.owner)) {
    if (skip.has(r.name.toLowerCase()) || known.has(r.name.toLowerCase()) || known.has(normUrl(r.url))) continue;
    const desc = (r.description ?? '').trim();
    if (desc.length < 15) {
      console.log(`New site ${r.name} has no usable description on GitHub, so it isn't posted yet.`);
      continue;
    }
    console.log(`New site found: ${r.name} (generic post).`);
    pool.push({ app: r.name, url: r.url, posts: genericPosts(r.name, desc, r.url) });
  }
  return pool;
}

/** The account's live GitHub Pages sites (not forks or archived repos). Empty if the API can't be reached. */
async function discover(owner) {
  owner = owner || process.env.GITHUB_REPOSITORY_OWNER;
  if (!owner) return [];
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'showcase-announce' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const out = [];
  try {
    for (let page = 1; page < 20; page++) {
      const res = await fetch(`https://api.github.com/users/${owner}/repos?per_page=100&page=${page}`, { headers });
      if (!res.ok) throw new Error(`GitHub API ${res.status}`);
      const repos = await res.json();
      for (const r of repos) {
        if (!r.has_pages || r.fork || r.archived) continue;
        if (r.name.toLowerCase() === `${owner.toLowerCase()}.github.io`) continue;
        out.push({ name: r.name, description: r.description, url: `https://${owner.toLowerCase()}.github.io/${r.name}/` });
      }
      if (repos.length < 100) break;
    }
  } catch (e) {
    console.warn(`Could not look for new sites (${e.message}); using apps.json only.`);
    return [];
  }
  return out;
}

function genericPosts(name, desc, url) {
  const title = name.replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  const room = 300 - 120 - url.length; // keeps every variant under Bluesky's 300 characters
  let d = desc.length > room ? desc.slice(0, room - 1).replace(/\s+\S*$/, '') + '…' : desc;
  if (!/[.!?…]$/.test(d)) d += '.';
  return [
    `New from me: ${title}. ${d} Free and open source, and it runs in your browser. ${url} #opensource`,
    `${title}: ${d} Nothing to install, no account, just open the link. ${url} #opensource #webapp`,
  ];
}

async function isUp(url) {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
    return res.ok;
  } catch {
    return false;
  }
}

function firstUrl(text) {
  return text.match(/https?:\/\/[^\s)]+[^\s).,!?;:'"]/)?.[0];
}

function normUrl(url) {
  return url.toLowerCase().replace(/\/+$/, '');
}

function check(text, name) {
  if (typeof text !== 'string' || !text.trim()) throw new Error(`${name}: empty text`);
  const graphemes = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)].length;
  if (graphemes > 300) throw new Error(`${name}: ${graphemes} characters; Bluesky allows 300`);
}

async function postMastodon(text, key) {
  const base = process.env.MASTODON_INSTANCE.replace(/\/+$/, '');
  const res = await fetch(`${base}/api/v1/statuses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.MASTODON_TOKEN}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `announce-${key}`, // the server ignores a repeat of the same post
    },
    body: JSON.stringify({ status: text, visibility: 'public', language: 'en' }),
  });
  if (!res.ok) throw new Error(`Mastodon ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).url;
}

/** Links and hashtags need "facets" (UTF-8 byte ranges) to be clickable on Bluesky. */
export function facets(text) {
  const out = [];
  const bytes = (s) => Buffer.byteLength(s, 'utf8');
  for (const m of text.matchAll(/https?:\/\/[^\s)]+[^\s).,!?;:'"]/g)) {
    const start = bytes(text.slice(0, m.index));
    out.push({ index: { byteStart: start, byteEnd: start + bytes(m[0]) }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: m[0] }] });
  }
  for (const m of text.matchAll(/(^|\s)(#[\p{L}\p{N}_]+)/gu)) {
    const at = m.index + m[1].length;
    const start = bytes(text.slice(0, at));
    out.push({ index: { byteStart: start, byteEnd: start + bytes(m[2]) }, features: [{ $type: 'app.bsky.richtext.facet#tag', tag: m[2].slice(1) }] });
  }
  return out;
}

async function xrpc(method, body, jwt, raw) {
  const res = await fetch(`${BSKY}/xrpc/${method}`, {
    method: 'POST',
    headers: { ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}), 'Content-Type': raw ? raw.type : 'application/json' },
    body: raw ? raw.data : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Bluesky ${method} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** A link card (title, description, picture) for the first link, taken from the page's og: tags. Optional. */
async function linkCard(text, jwt) {
  const url = text.match(/https?:\/\/[^\s)]+[^\s).,!?;:'"]/)?.[0];
  if (!url) return undefined;
  try {
    const html = await (await fetch(url, { signal: AbortSignal.timeout(15000) })).text();
    const meta = (p) => html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]+content=["']([^"']*)["']`, 'i'))?.[1] ??
      html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${p}["']`, 'i'))?.[1];
    const external = { uri: url, title: meta('og:title') ?? '', description: meta('og:description') ?? '' };
    const img = meta('og:image');
    if (img) {
      const r = await fetch(new URL(img, url), { signal: AbortSignal.timeout(15000) });
      const data = Buffer.from(await r.arrayBuffer());
      if (r.ok && data.length < 950_000) {
        const { blob } = await xrpc('com.atproto.repo.uploadBlob', null, jwt, { type: r.headers.get('content-type') || 'image/png', data });
        external.thumb = blob;
      }
    }
    return { $type: 'app.bsky.embed.external', external };
  } catch (e) {
    console.warn(`No link card: ${e.message}`);
    return undefined;
  }
}

async function postBluesky(text) {
  const s = await xrpc('com.atproto.server.createSession', { identifier: process.env.BLUESKY_HANDLE, password: process.env.BLUESKY_APP_PASSWORD });
  const record = { $type: 'app.bsky.feed.post', text, createdAt: new Date().toISOString(), langs: ['en'], facets: facets(text) };
  const embed = await linkCard(text, s.accessJwt);
  if (embed) record.embed = embed;
  const r = await xrpc('com.atproto.repo.createRecord', { repo: s.did, collection: 'app.bsky.feed.post', record }, s.accessJwt);
  const id = r.uri.split('/').pop();
  return `https://bsky.app/profile/${s.handle}/post/${id}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
