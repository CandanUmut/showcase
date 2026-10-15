// Posts ONE queued announcement per run to Mastodon and/or Bluesky.
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
    console.log(`Nothing due (queue: ${files.length}).`);
    return;
  }
  const path = join(QUEUE, due);
  const item = JSON.parse(await readFile(path, 'utf8'));
  check(item.text, due);
  item.posted ??= {};

  for (const n of dry ? Object.keys(networks) : enabled) {
    if (item.posted[n]) continue;
    if (dry) {
      console.log(`[dry run] ${n}: ${JSON.stringify(item.text)}`);
      if (n === 'bluesky') console.log('[dry run] bluesky facets:', JSON.stringify(facets(item.text)));
      continue;
    }
    try {
      item.posted[n] = n === 'mastodon' ? await postMastodon(item.text, due) : await postBluesky(item.text);
      console.log(`Posted ${due} to ${n}: ${item.posted[n]}`);
    } catch (e) {
      console.error(`Failed to post ${due} to ${n}: ${e.message}`);
      process.exitCode = 1;
    }
  }
  if (dry) return;
  await writeFile(path, JSON.stringify(item, null, 2) + '\n');
  if (enabled.every((n) => item.posted[n])) {
    await mkdir(POSTED, { recursive: true });
    await rename(path, join(POSTED, due));
  }
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
