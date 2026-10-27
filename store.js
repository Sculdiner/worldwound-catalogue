/*
 * The catalogue's shared data layer: the exported catalogue, the queue of
 * proposed changes (`pending.json` on the site repo's `edits` branch) and the
 * rules both pages use to read and write it. Imported by the phone app
 * (`app.js`) and the desktop studio (`studio.js`), so every save, wherever it
 * comes from, lands in the queue in exactly the same shape.
 *
 * Game vocabulary (rarities, node types, enemy stats, ...) is not written
 * here: it comes from `catalogue.json` → `vocab`, which `catalogue/export.ts`
 * fills from the game. See `vocab()` below.
 */

/** Shared state. Each page adds its own fields. */
const S = {
  cat: null,
  pending: { version: 1, edits: [], applied: [] },
  sha: null,
  pendingLoaded: false,
  pendingError: null,
  proposed: true,
};

/** What the data layer tells the page: sync state, messages, queue changed, token needed. */
const hooks = {
  sync() {},
  toast() {},
  changed() {},
  needToken() {},
};

const DEFAULT_REPO = 'Sculdiner/worldwound-catalogue';
const EDITS_BRANCH = 'edits';
const EDITS_FILE = 'pending.json';
const API = 'https://api.github.com';

// ------------------------------------------------------------------ storage

const LS_PREFIX = 'wwc.';
const LS = {
  get(k, d) {
    try {
      const v = localStorage.getItem(LS_PREFIX + k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(LS_PREFIX + k, JSON.stringify(v));
    } catch {
      /* private mode: settings just won't stick */
    }
  },
};

const token = () => LS.get('token', '');
const repo = () => LS.get('repo', DEFAULT_REPO) || DEFAULT_REPO;

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
const slug = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const clone = (v) => JSON.parse(JSON.stringify(v ?? null));
const stable = (v) =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x,
  );
const same = (a, b) => stable(a) === stable(b);
const ago = (iso) => {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const b64enc = (str) => {
  let bin = '';
  for (const b of new TextEncoder().encode(str)) bin += String.fromCharCode(b);
  return btoa(bin);
};
const b64dec = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

// ------------------------------------------------------------------ vocab

/**
 * The game's vocabulary, as exported (`catalogue.json` → `vocab`, built in
 * `catalogue/export.ts`). The fallbacks only keep the pages from crashing on
 * an old or half-built export; the export is the one place these are set.
 */
const vocab = () => {
  const v = S.cat?.vocab ?? {};
  return {
    gameName: v.gameName ?? 'Catalogue',
    kinds: v.kinds ?? ['cards', 'relics', 'routes', 'encounters'],
    groupLabel: v.groupLabel ?? 'Group',
    actLabel: v.actLabel ?? 'Act',
    acts: v.acts ?? null,
    actNames: v.actNames ?? {},
    cardRarities: v.cardRarities ?? [],
    rarityOptional: !!v.rarityOptional,
    cardTypes: v.cardTypes ?? [],
    cardUpgrades: v.cardUpgrades ?? true,
    relicRarities: v.relicRarities ?? [],
    cardFlags: v.cardFlags ?? [],
    cardStats: v.cardStats ?? [],
    enemyStats: v.enemyStats ?? [],
    enemyRanks: v.enemyRanks ?? [],
    encounterCategories: v.encounterCategories ?? [],
    waves: v.waves ?? true,
    slotNames: v.slotNames ?? true,
    slotAbilities: v.slotAbilities ?? true,
    encounterPurpose: v.encounterPurpose ?? true,
    maxEnemies: v.maxEnemies ?? 0,
    nodeTypes: v.nodeTypes ?? [],
    branches: v.branches ?? [],
    fieldLabels: v.fieldLabels ?? {},
    artSizes: { cards: [600, 840], relics: [512, 512], ...(v.artSizes ?? {}) },
  };
};

/** A route node type's look: its colour, one-letter mark and name. */
const nodeStyle = (type) => {
  const t = vocab().nodeTypes.find((x) => x.id === type);
  return t ? { c: t.color ?? '#888', l: t.letter ?? '?', name: t.name ?? type, end: !!t.end, one: t.count === 'one' } : { c: '#888', l: '?', name: type ?? '?', end: false, one: false };
};
const nodeTypeIds = () => vocab().nodeTypes.map((t) => t.id);
const endNodeType = () => vocab().nodeTypes.find((t) => t.end)?.id ?? null;
const categoryName = (id) => vocab().encounterCategories.find((c) => c.id === id)?.name ?? cap(id ?? '');
/** "Sector 2 · Crystal": an encounter tier with its name, when the game names it. */
const actName = (n) => {
  const V = vocab();
  const name = V.actNames?.[n];
  return `${V.actLabel} ${n}${name ? ` · ${name}` : ''}`;
};
/** The tiers an encounter can be set to: the game's own list, else 1–5 plus any in use. */
const actChoices = (cur) =>
  vocab().acts ?? [...new Set([1, 2, 3, 4, 5, ...items('encounters').map((x) => x.data.act ?? 1), cur ?? 1])].sort((a, b) => a - b);
const rankName = (id) => vocab().enemyRanks.find((r) => r.id === id)?.name ?? cap(id ?? '');
const KIND = {
  cards: { one: 'Card', name: (c) => c.name || c.id },
  ships: { one: 'Ship', name: (c) => c.name || c.id },
  enemies: { one: 'Enemy', name: (c) => c.name || c.id },
  relics: { one: 'Relic', name: (r) => r.name || r.id },
  routes: { one: 'Route', name: (r) => r.name || r.id },
  encounters: { one: 'Encounter', name: (e) => e.name || e.id },
  abilities: { one: 'Enemy ability', name: (a) => a.name || a.id },
  general: { one: 'Note', name: () => 'General note' },
};

const group = (id) => S.cat?.groups?.find((g) => g.id === id);
const groupName = (id) => group(id)?.name ?? cap(id);
/**
 * An encounter slot's identity (its portrait): the enemy as proposed when the
 * export has enemies (so a queued edit of its name or Hull shows everywhere),
 * else the plain character.
 */
const characterDef = (id) => {
  if (!id) return undefined;
  if (S.cat?.enemies?.length) {
    const it = items('enemies').find((x) => x.key === id);
    if (it) return it.data;
  }
  return S.cat?.characters?.find((v) => v.id === id);
};
/** A slot's stat: its own value, else (a read-only stat) the enemy's own. */
const slotStat = (v, s) => v?.[s.key] ?? characterDef(v?.characterId)?.[s.key] ?? s.default ?? 0;
/** An enemy ability as proposed: queued edits and new abilities included. */
const ability = (id) => (id ? allAbilities().find((a) => a.id === id) : undefined);
/** Every enemy ability with the queue laid over it, proposed ones last. */
const allAbilities = () => (S.cat ? items('abilities').filter((x) => x.pending?.op !== 'delete').map((x) => x.data) : []);
const hasArt = (kind, id) => S.cat?.art?.[kind]?.includes(id);
const artUrl = (kind, id) => `art/${kind}/${encodeURIComponent(id)}.webp`;
/** The large cut behind the enlarge view; only cards, relics and characters have one. */
const artLargeUrl = (kind, id) => (['cards', 'ships', 'relics', 'characters'].includes(kind) ? `art/${kind}-lg/${encodeURIComponent(id)}.webp` : artUrl(kind, id));

async function loadCatalogue() {
  const r = await fetch(`data/catalogue.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`catalogue.json: HTTP ${r.status}`);
  S.cat = await r.json();
}

async function gh(path, opts = {}) {
  const r = await fetch(API + path, {
    ...opts,
    cache: 'no-store',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token()}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  return r;
}

/** Read the pending queue fresh. A missing file is an empty queue. */
async function fetchPending() {
  const r = await gh(`/repos/${repo()}/contents/${EDITS_FILE}?ref=${EDITS_BRANCH}&t=${Date.now()}`);
  if (r.status === 404) return { data: { version: 1, edits: [], applied: [] }, sha: null, missing: true };
  if (!r.ok) throw new Error(r.status === 401 ? 'GitHub token rejected (401)' : `GitHub: HTTP ${r.status}`);
  const j = await r.json();
  const data = JSON.parse(b64dec(j.content));
  data.edits ??= [];
  data.applied ??= [];
  return { data, sha: j.sha };
}

async function ensureBranch() {
  const r = await gh(`/repos/${repo()}/git/ref/heads/${EDITS_BRANCH}`);
  if (r.ok) return;
  const main = await gh(`/repos/${repo()}/git/ref/heads/main`);
  if (!main.ok) throw new Error(`Cannot find ${repo()} main branch (HTTP ${main.status})`);
  const sha = (await main.json()).object.sha;
  const c = await gh(`/repos/${repo()}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${EDITS_BRANCH}`, sha }) });
  if (!c.ok) throw new Error(`Cannot create the ${EDITS_BRANCH} branch (HTTP ${c.status})`);
}

async function refreshPending({ quiet = false } = {}) {
  if (!token()) {
    hooks.sync('', 'Read-only: add a GitHub token in Settings to see and save changes');
    return;
  }
  hooks.sync('busy');
  try {
    const { data, sha } = await fetchPending();
    S.pending = data;
    S.sha = sha;
    S.pendingLoaded = true;
    S.pendingError = null;
    hooks.sync('ok', 'Synced with GitHub');
  } catch (e) {
    S.pendingError = e.message;
    hooks.sync('err', e.message);
    if (!quiet) hooks.toast(e.message, true);
  }
  hooks.changed();
}

/**
 * Apply `mutate` to the freshest queue and write it back. Retries on a stale
 * sha, so an edit from another device (or Claude clearing applied ones) is
 * never overwritten.
 */
async function commitPending(mutate, message) {
  if (!token()) {
    hooks.toast('Add a GitHub token in Settings first', true);
    hooks.needToken();
    return false;
  }
  hooks.sync('busy');
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const fresh = await fetchPending();
      const next = clone(fresh.data);
      mutate(next);
      next.updatedAt = new Date().toISOString();
      const body = { message, content: b64enc(JSON.stringify(next, null, 2) + '\n'), branch: EDITS_BRANCH };
      if (fresh.sha) body.sha = fresh.sha;
      let r = await gh(`/repos/${repo()}/contents/${EDITS_FILE}`, { method: 'PUT', body: JSON.stringify(body) });
      if (r.status === 404 || (r.status === 422 && !fresh.sha)) {
        await ensureBranch();
        r = await gh(`/repos/${repo()}/contents/${EDITS_FILE}`, { method: 'PUT', body: JSON.stringify(body) });
      }
      if (r.ok) {
        S.pending = next;
        S.sha = (await r.json()).content.sha;
        S.pendingLoaded = true;
        hooks.sync('ok', 'Saved to GitHub');
        hooks.changed();
        return true;
      }
      if (r.status === 409 || r.status === 422) continue;
      throw new Error(r.status === 401 || r.status === 403 ? `GitHub refused the write (${r.status}) — check the token's Contents permission` : `GitHub: HTTP ${r.status}`);
    }
    throw new Error('Could not save: the queue kept changing underneath. Try again.');
  } catch (e) {
    hooks.sync('err', e.message);
    hooks.toast(e.message, true);
    return false;
  }
}

// ------------------------------------------------------------------ idea notes

/*
 * The user's free notes (relic ideas, card ideas): `notes.json` on the same
 * `edits` branch, beside the queue but never in it. They are not game changes,
 * so `pending.mjs` and the catalogue sync never see them as queued work.
 */
const NOTES_FILE = 'notes.json';
const NOTE_LISTS = ['cards', 'ships', 'enemies'];
const emptyNotes = () => ({ version: 1, cards: [], ships: [], enemies: [] });

/** Read the notes fresh. A missing file is no notes yet. */
async function fetchNotes() {
  const r = await gh(`/repos/${repo()}/contents/${NOTES_FILE}?ref=${EDITS_BRANCH}&t=${Date.now()}`);
  if (r.status === 404) return { data: emptyNotes(), sha: null };
  if (!r.ok) throw new Error(r.status === 401 ? 'GitHub token rejected (401)' : `GitHub: HTTP ${r.status}`);
  const j = await r.json();
  const data = { ...emptyNotes(), ...JSON.parse(b64dec(j.content)) };
  for (const k of NOTE_LISTS) data[k] ??= [];
  return { data, sha: j.sha };
}

/**
 * Apply `mutate` to the freshest notes and write them back, retrying on a
 * stale sha (another device, or another note saving at the same moment).
 * Resolves to the saved notes, or null when it could not save.
 */
async function commitNotes(mutate, message) {
  if (!token()) {
    hooks.toast('Add a GitHub token in Settings first', true);
    hooks.needToken();
    return null;
  }
  hooks.sync('busy');
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const fresh = await fetchNotes();
      const next = clone(fresh.data);
      mutate(next);
      next.updatedAt = new Date().toISOString();
      const body = { message, content: b64enc(JSON.stringify(next, null, 2) + '\n'), branch: EDITS_BRANCH };
      if (fresh.sha) body.sha = fresh.sha;
      let r = await gh(`/repos/${repo()}/contents/${NOTES_FILE}`, { method: 'PUT', body: JSON.stringify(body) });
      if (r.status === 404) {
        await ensureBranch();
        r = await gh(`/repos/${repo()}/contents/${NOTES_FILE}`, { method: 'PUT', body: JSON.stringify(body) });
      }
      if (r.ok) {
        hooks.sync('ok', 'Saved to GitHub');
        return next;
      }
      if (r.status === 409 || r.status === 422) continue;
      throw new Error(r.status === 401 || r.status === 403 ? `GitHub refused the write (${r.status}) — check the token's Contents permission` : `GitHub: HTTP ${r.status}`);
    }
    throw new Error('Could not save the note: the notes kept changing underneath. Try again.');
  } catch (e) {
    hooks.sync('err', e.message);
    hooks.toast(e.message, true);
    return null;
  }
}

// ------------------------------------------------------------------ uploaded images

/** Images uploaded from this browser, shown from memory until the page reloads. */
const UPLOADS = new Map();

/** Where an uploaded image (a path on the `edits` branch) is shown from. */
const uploadUrl = (path) =>
  UPLOADS.get(path) ?? `https://raw.githubusercontent.com/${repo()}/${EDITS_BRANCH}/${path.split('/').map(encodeURIComponent).join('/')}`;

async function blobB64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * Put an image on the `edits` branch under `uploads/` (its own file, beside
 * the queue). Returns its path, or null when it could not be saved.
 */
async function uploadImage(kind, id, blob) {
  if (!token()) {
    hooks.toast('Add a GitHub token in Settings first', true);
    hooks.needToken();
    return null;
  }
  const path = `uploads/${kind}/${id}-${uid()}.png`;
  hooks.sync('busy');
  try {
    const body = JSON.stringify({ message: `Upload an image for ${kind.slice(0, -1)} ${id}`, content: await blobB64(blob), branch: EDITS_BRANCH });
    let r = await gh(`/repos/${repo()}/contents/${path}`, { method: 'PUT', body });
    if (r.status === 404 || r.status === 422) {
      await ensureBranch();
      r = await gh(`/repos/${repo()}/contents/${path}`, { method: 'PUT', body });
    }
    if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? `GitHub refused the upload (${r.status}) — check the token's Contents permission` : `Upload failed: HTTP ${r.status}`);
    UPLOADS.set(path, URL.createObjectURL(blob));
    hooks.sync('ok', 'Uploaded to GitHub');
    return path;
  } catch (e) {
    hooks.sync('err', e.message);
    hooks.toast(e.message, true);
    return null;
  }
}

/** Fold a new change into the queue, merging with any change already pending on the same item. */
function stage(data, { kind, key, op, before, after, note }) {
  const edits = data.edits;
  const i = edits.findIndex((e) => e.kind === kind && e.targetId === key);
  const ex = i >= 0 ? edits[i] : null;
  const at = new Date().toISOString();
  const put = (rec) => (ex ? (edits[i] = rec) : edits.push(rec));
  if (op === 'delete') {
    if (ex?.op === 'add') return void edits.splice(i, 1);
    return put({ id: ex?.id ?? uid(), kind, op: 'delete', targetId: key, before: ex?.before ?? before, after: null, note, at });
  }
  if (ex?.op === 'add') return put({ ...ex, targetId: after.id, after, note, at });
  if (op === 'add') return put({ id: uid(), kind, op: 'add', targetId: after.id, before: null, after, note, at });
  const orig = ex?.before ?? before;
  if (same(orig, after) && !note) return ex ? void edits.splice(i, 1) : undefined;
  put({ id: ex?.id ?? uid(), kind, op: 'edit', targetId: key, before: orig, after, note, at });
}

/** The catalogue with the pending queue laid over it. */
function items(kind) {
  const list = (S.cat?.[kind] ?? []).map((x) => ({ key: x.id, data: x, orig: x, pending: null }));
  for (const e of S.pending.edits) {
    if (e.kind !== kind) continue;
    if (e.op === 'add') {
      list.push({ key: e.targetId, data: e.after, orig: null, pending: e });
      continue;
    }
    const it = list.find((x) => x.key === e.targetId);
    if (!it) continue;
    it.pending = e;
    if (e.op === 'edit' && S.proposed) it.data = e.after;
  }
  return list;
}

/**
 * Switched off: kept in the game's data, but never offered, shown or rolled
 * (`disabled: true`; absent means active, so everything starts active).
 */
const isOff = (d) => !!d?.disabled;
const offTag = (d) => (isOff(d) ? '<span class="tag off">Off</span>' : '');

/** A copy of `draft` switched on or off. Active drops the field rather than storing `false`. */
function withActive(draft, active) {
  const d = clone(draft);
  if (active) delete d.disabled;
  else d.disabled = true;
  return d;
}

const findItem = (kind, key) => items(kind).find((x) => x.key === key) ?? items(kind).find((x) => x.data.id === key);

/** Per-stat totals of an encounter's enemies (e.g. total HP), in `vocab.enemyStats` order. */
function enemyTotals(e) {
  return vocab().enemyStats.map((s) => ({ ...s, total: (e.enemies ?? []).reduce((n, x) => n + (Number(slotStat(x, s)) || 0), 0) }));
}

/** A new enemy with every stat at its default. */
function blankEnemy(extra = {}) {
  const stats = Object.fromEntries(vocab().enemyStats.filter((s) => !s.readOnly).map((s) => [s.key, s.default ?? 0]));
  return { arriveAfterTurn: 0, ...(vocab().slotNames ? { name: '' } : {}), ...stats, ...extra };
}

// ------------------------------------------------------------------ route map

/** Every start → end walk, with how many of each node type it meets. */
function routePaths(r) {
  const byKey = Object.fromEntries(r.nodes.map((n) => [n.key, n]));
  const incoming = new Set(r.nodes.flatMap((n) => n.next ?? []));
  const starts = r.nodes.filter((n) => !incoming.has(n.key));
  const out = [];
  const walk = (n, path, seen) => {
    if (out.length > 60 || seen.has(n.key)) return;
    const p = [...path, n];
    const next = (n.next ?? []).map((k) => byKey[k]).filter(Boolean);
    if (!next.length) return void out.push(p);
    const s = new Set(seen).add(n.key);
    for (const m of next) walk(m, p, s);
  };
  for (const s of starts) walk(s, [], new Set());
  return out;
}

/**
 * The per-walk budget a route is held to (`catalogue.json` → `budgets`):
 * its own `budget` name, else `default`. `{ min: {type: n}, max: {type: n} }`,
 * or null when the game has no budget yet.
 */
function routeBudget(cat, r) {
  return cat?.budgets?.[r?.budget ?? 'default'] ?? null;
}

/** A new route: one node of the first ordinary type leading to the end node (as `vocab.nodeTypes` defines them). */
function blankRoute() {
  const end = endNodeType();
  const first = vocab().nodeTypes.find((t) => !t.end)?.id;
  const nodes = [];
  if (first) nodes.push({ key: 'n1', type: first, branch: 'shared', depth: 0, lane: 0, next: end ? ['end'] : [] });
  if (end) nodes.push({ key: 'end', type: end, branch: 'shared', depth: first ? 1 : 0, lane: 0, next: [] });
  return { id: '', name: '', nodes };
}

/** The node types a path table counts: everything but the end node. */
const pathColumns = () => vocab().nodeTypes.filter((t) => !t.end).map((t) => t.id);

function routeChecks(r) {
  const errs = [];
  const keys = r.nodes.map((n) => n.key);
  const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (dup.length) errs.push(`Duplicate node keys: ${[...new Set(dup)].join(', ')}`);
  if (keys.some((k) => !k)) errs.push('A node has no key');
  const types = vocab().nodeTypes;
  // A node type marked `count: 'one'` (e.g. the end node) appears exactly once.
  for (const t of types.filter((x) => x.count === 'one')) {
    const n = r.nodes.filter((x) => x.type === t.id).length;
    if (n !== 1) errs.push(`Needs exactly one ${t.name} node (has ${n})`);
  }
  for (const n of r.nodes) for (const k of n.next ?? []) if (!keys.includes(k)) errs.push(`${n.key} → “${k}” does not exist`);
  const warns = [];
  for (const n of r.nodes) if (types.length && !types.some((t) => t.id === n.type)) warns.push(`${n.key} has an unknown type “${n.type}”`);
  for (const n of r.nodes) if (!nodeStyle(n.type).end && !(n.next ?? []).length) warns.push(`${n.key} is a dead end`);
  const paths = routePaths(r);
  for (const t of types.filter((x) => x.count === 'one' && !x.end)) {
    if (r.nodes.some((n) => n.type === t.id) && paths.some((p) => !p.some((n) => n.type === t.id))) warns.push(`Some paths skip the ${t.name}`);
  }
  return { errs, warns, paths };
}

/** A select's value into a draft, with the derived field `_group` (a card's one group). */
function setField(draft, path, value) {
  if (path === '_group') {
    if (value) draft.group = value;
    else delete draft.group;
  } else setPath(draft, path, value === '' ? undefined : value);
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}
function setPath(obj, path, val) {
  const ks = path.split('.');
  let o = obj;
  for (let i = 0; i < ks.length - 1; i++) {
    o[ks[i]] ??= /^\d+$/.test(ks[i + 1]) ? [] : {};
    o = o[ks[i]];
  }
  const last = ks[ks.length - 1];
  if (val === undefined) delete o[last];
  else o[last] = val;
}

const KEEP_EMPTY = new Set(['enemies', 'nodes', 'next', 'upgrades', 'id', 'deck', 'moves', 'refits']);
/** Drop blank optional fields so the queue carries what was actually authored. */
function tidy(v, key = '') {
  if (Array.isArray(v)) return v.map((x) => tidy(x));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (k.startsWith('_')) continue;
      const t = tidy(x, k);
      if (t === undefined || t === null) continue;
      if (!KEEP_EMPTY.has(k) && (t === '' || t === false || (Array.isArray(t) && !t.length))) continue;
      if (t && typeof t === 'object' && !Array.isArray(t) && !Object.keys(t).length) continue;
      o[k] = t;
    }
    return o;
  }
  return typeof v === 'string' ? v.trim() : v;
}

/** An id for something new, derived from its name and never clashing with another. */
function freshId(kind, name, ownKey = null) {
  const base = slug(name) || kind.slice(0, -1);
  const taken = new Set(items(kind).filter((x) => x.key !== ownKey).map((x) => x.data.id));
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

export {
  allAbilities,
  API,
  DEFAULT_REPO,
  EDITS_BRANCH,
  EDITS_FILE,
  KEEP_EMPTY,
  KIND,
  LS,
  actChoices,
  actName,
  NOTE_LISTS,
  NOTES_FILE,
  S,
  ability,
  ago,
  artLargeUrl,
  artUrl,
  b64dec,
  b64enc,
  blankEnemy,
  blankRoute,
  cap,
  categoryName,
  characterDef,
  clone,
  commitNotes,
  commitPending,
  emptyNotes,
  endNodeType,
  enemyTotals,
  ensureBranch,
  esc,
  fetchNotes,
  fetchPending,
  findItem,
  freshId,
  getPath,
  gh,
  group,
  groupName,
  hasArt,
  hooks,
  isOff,
  items,
  loadCatalogue,
  nodeStyle,
  nodeTypeIds,
  offTag,
  pathColumns,
  rankName,
  refreshPending,
  repo,
  routeBudget,
  routeChecks,
  routePaths,
  same,
  setField,
  setPath,
  slotStat,
  slug,
  stable,
  stage,
  tidy,
  token,
  uid,
  uploadImage,
  uploadUrl,
  vocab,
  withActive,
};
