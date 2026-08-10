const BASE = import.meta.env.BASE_URL.replace(/\/+$/, '');

/** Build an internal, base-aware, trailing-slashed path. */
export function url(p = '') {
  const clean = String(p).replace(/^\/+/, '');
  if (!clean) return `${BASE}/`;
  const hasExt = /\.[a-z0-9]+$/i.test(clean);
  return `${BASE}/${clean}${hasExt || clean.endsWith('/') ? '' : '/'}`;
}

/** Absolute URL for canonical / Open Graph tags. */
export function absolute(p, site) {
  return new URL(url(p), site).href;
}

export function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Words that cannot end a phrase — repeated so runs like "between the" clear.
const DANGLING =
  /(?:[\s,]+(?:a|an|the|and|or|but|of|to|in|on|at|by|for|from|with|without|into|onto|under|over|between|across|through|about|as|that|which|who|so|its|it|your|you|their|his|her|our|my|is|are|was|were|be|been|can|will|not|no|one|each|every|all|some|any|more|most|then|than|when|while|where|how|why|what|up|out|off|down|per|via|like|near|until|after|before|since|during|within|upon|against)\b)+$/gi;

/**
 * Build a <title> from the project's own words that survives SERP truncation.
 *
 * Takes the opening clause of the blurb and trims it at a word boundary to fit
 * the remaining character budget, so the title stays specific without being
 * padded out with boilerplate or cut off mid-word by the search engine.
 */
export function seoTitle(name, blurb, budget = 62) {
  if (!blurb) return name;

  const room = budget - name.length - 3; // " — "
  if (room < 18) return name;

  const parts = blurb
    .split(/(?:\.\s|:\s|\s—\s|;\s)/)
    .map((s) => s.trim().replace(/\.$/, ''))
    .filter(Boolean);

  // Always prefer the opening clause: it carries what the project is. A later
  // sentence may fit whole and still be useless out of context ("This is the
  // case for it"), so a clipped-but-on-topic opener beats it.
  let clause = parts[0] || '';
  if (clause.length < 15) {
    clause = parts.find((s) => s.length >= 15 && s.length <= room) || clause;
  }

  if (clause.length > room) {
    clause = clause.slice(0, room).replace(/\s+\S*$/, '');
    // A hard cut often lands on a word that needs the next one to make sense
    // ("rotates under", "drifting between"). Drop those so the fragment reads
    // as a finished phrase rather than a truncation.
    clause = clause.replace(DANGLING, '');
  }
  clause = clause.replace(/[\s,–—-]+$/, '');

  return clause.length >= 15 ? `${name} — ${clause}` : name;
}

/** "12 March 2026" — spelled out, since the date is metadata, not a timestamp. */
export function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
}

/** Relative age, for the "still being worked on" signal on cards. */
export function relativeAge(iso) {
  const days = Math.floor((Date.now() - new Date(iso)) / 86_400_000);
  if (days <= 1) return 'updated today';
  if (days < 30) return `updated ${days} days ago`;
  const months = Math.round(days / 30);
  if (months < 24) return `updated ${months} month${months === 1 ? '' : 's'} ago`;
  return `updated ${Math.round(months / 12)} years ago`;
}
