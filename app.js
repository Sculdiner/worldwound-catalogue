/*
 * Worldwound Catalogue — a phone-friendly view of the game's cards, ships,
 * enemies and Encounters (and relics and route layouts, for a game that has
 * them: `vocab.kinds` says which tabs show), plus a queue of proposed changes.
 *
 * The catalogue itself (data/catalogue.json) is exported from the game repo
 * and is read-only here. Every add / edit / delete made on this site is
 * written to `pending.json` on the site repo's `edits` branch through the
 * GitHub API; Claude reads that queue from the game project, implements the
 * changes in the real content files, republishes the catalogue and moves the
 * edits to the `applied` log. See catalogue/README.md in the game repo.
 */

import {
  allAbilities,
  DEFAULT_REPO,
  KIND,
  LS,
  S,
  ability,
  actChoices,
  actName,
  ago,
  artUrl,
  blankEnemy,
  blankRoute,
  cap,
  categoryName,
  characterDef,
  clone,
  commitPending,
  enemyTotals,
  esc,
  findItem,
  freshId,
  getPath,
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
  stage,
  tidy,
  token,
  uid,
  uploadImage,
  uploadUrl,
  vocab,
  withActive,
} from './store.js';
import { ZOOM_BADGE, zoomAttrs } from './zoom.js';
import { uploadAndFrame } from './upload.js';
import { flushNotes, initNotes, loadNotes, notesView } from './notes.js';
import { breakdownHtml } from './breakdown.js';

Object.assign(S, {
  proposed: LS.get('proposed', true),
  filters: { cards: {}, ships: {}, enemies: {}, relics: {}, encounters: {}, routes: {} },
  form: null,
});
hooks.sync = (state, title) => setSync(state, title);
hooks.toast = (msg, err) => toast(msg, err);
hooks.changed = () => renderBadge();
hooks.needToken = () => (location.hash = '#/settings');

// ------------------------------------------------------------------ helpers

const $ = (sel, root = document) => root.querySelector(sel);
let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), err ? 4500 : 2200);
}

function setSync(state, title = '') {
  const el = $('#sync');
  el.className = 'sync ' + state;
  el.title = title;
}

/** A small bottom sheet. Resolves to the note text (input) / true, or null on cancel. */
function ask({ title, body = '', input = false, placeholder = '', ok = 'OK', danger = false, value = '' }) {
  return new Promise((resolve) => {
    const m = $('#modal');
    m.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">
      <h3 style="margin-top:0">${esc(title)}</h3>
      ${body ? `<p>${esc(body)}</p>` : ''}
      ${input ? `<div class="field note-field"><textarea id="ask-in" placeholder="${esc(placeholder)}">${esc(value)}</textarea></div>` : ''}
      <div class="row"><button class="btn ghost" data-r="0">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${esc(ok)}</button></div>
    </div>`;
    m.hidden = false;
    autosize(m);
    const done = (r) => {
      m.hidden = true;
      m.innerHTML = '';
      resolve(r);
    };
    m.onclick = (e) => {
      if (e.target === m) return done(null);
      const b = e.target.closest('[data-r]');
      if (!b) return;
      if (b.dataset.r === '0') return done(null);
      done(input ? $('#ask-in').value.trim() : true);
    };
    if (input) setTimeout(() => $('#ask-in')?.focus(), 50);
  });
}

// ------------------------------------------------------------------ data

function pendingTag(it) {
  if (!it.pending) return '';
  const label = { add: 'New', edit: it.pending.note && same(it.pending.before, it.pending.after) ? 'Note' : 'Edited', delete: 'Delete' }[it.pending.op];
  return `<span class="tag p-${it.pending.op}">${label}</span>`;
}

const gameName = () => vocab().gameName;

// ------------------------------------------------------------------ router

const views = {};
const LIST_TABS = ['cards', 'ships', 'enemies', 'relics', 'routes', 'encounters'];
const TAB_TITLE = { cards: 'Cards', ships: 'Ships', enemies: 'Enemies', relics: 'Relics', routes: 'Routes', encounters: 'Encounters' };

/** Show only the list tabs the game has (`vocab.kinds`); the others stay hidden. */
function showTabs() {
  const kinds = vocab().kinds;
  const bar = $('#tabbar');
  let n = 0;
  for (const a of bar.querySelectorAll('a')) {
    const off = LIST_TABS.includes(a.dataset.tab) && !kinds.includes(a.dataset.tab);
    a.hidden = off;
    if (!off) n++;
  }
  bar.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
}

function parseHash() {
  const parts = (location.hash.replace(/^#\/?/, '') || 'cards').split('/').map(decodeURIComponent);
  return { tab: parts[0], id: parts[1], mode: parts[2] };
}

function render() {
  const r = parseHash();
  const isForm = r.mode === 'edit' || r.id === 'new' || r.mode === 'duplicate';
  for (const a of document.querySelectorAll('.tabbar a')) a.classList.toggle('on', a.dataset.tab === r.tab);
  if (S.cat) {
    showTabs();
    if (LIST_TABS.includes(r.tab) && !vocab().kinds.includes(r.tab)) {
      location.replace('#/cards');
      return;
    }
  }
  const listTab = LIST_TABS.includes(r.tab);
  $('#back').hidden = !r.id;
  const fab = $('#fab');
  fab.hidden = !(listTab && !r.id);
  fab.href = `#/${r.tab}/new`;
  const view = $('#view');
  if (!S.cat) {
    view.innerHTML = `<div class="empty">Loading the catalogue…</div>`;
    return;
  }
  let title = gameName();
  if (r.tab === 'settings') title = 'Settings';
  else if (r.tab === 'changes') title = 'Changes';
  else if (r.tab === 'notes') title = 'Notes';
  else if (r.tab === 'archetypes') title = 'Archetypes';
  else if (listTab && !r.id) title = TAB_TITLE[r.tab];
  if (INLINE_KINDS.includes(r.tab) && isForm) {
    location.replace(r.id === 'new' ? `#/${r.tab}` : `#/${r.tab}/${encodeURIComponent(r.id)}`);
    if (r.id === 'new') createItem(r.tab);
    return;
  }
  if (listTab && isForm) {
    if (S.form?.hash !== location.hash) {
      S.form = newForm(r);
      if (S.form) S.form.hash = location.hash;
    }
    if (!S.form) {
      view.innerHTML = `<div class="empty">Nothing called “${esc(r.id)}” here.</div>`;
      return;
    }
  } else S.form = null;
  const editor = $('#editor');
  if (listTab && isForm) {
    // The page stays underneath: the item itself, or the list when proposing something new.
    const base = r.id !== 'new' ? findItem(r.tab, r.id) : null;
    title = base ? KIND[r.tab].name(base.data) : TAB_TITLE[r.tab];
    view.innerHTML = base ? views.detail[r.tab](base) : views.list[r.tab]();
    $('#editor-title').textContent = S.form.op === 'add' ? `New ${KIND[r.tab].one.toLowerCase()}` : `Edit ${KIND[r.tab].one.toLowerCase()}`;
    const opening = editor.hidden;
    const body = $('#editor-body');
    const y = body.scrollTop;
    body.innerHTML = formHtml();
    editor.hidden = false;
    autosize(body);
    body.scrollTop = opening ? 0 : y;
    document.body.classList.add('locked');
  } else {
    editor.hidden = true;
    document.body.classList.remove('locked');
  }
  if (listTab && isForm) {
    /* drawn above */
  } else if (listTab && r.id) {
    const it = findItem(r.tab, r.id);
    title = it ? KIND[r.tab].name(it.data) : 'Not found';
    view.innerHTML = it ? views.detail[r.tab](it) : `<div class="empty">Nothing called “${esc(r.id)}” here.<br><a href="#/${r.tab}">Back to ${r.tab}</a></div>`;
  } else if (listTab) {
    view.innerHTML = views.list[r.tab]();
  } else if (views[r.tab]) {
    view.innerHTML = views[r.tab]();
    if (r.tab === 'notes') autosize(view);
  } else {
    location.hash = '#/cards';
    return;
  }
  $('#title').textContent = title;
  document.title = `${title} · ${gameName()} Catalogue`;
}

function renderBadge() {
  const n = S.pending.edits.length;
  const b = $('#badge');
  b.hidden = n === 0;
  b.textContent = n;
}

// ------------------------------------------------------------------ lists

function filterBar(kind, chipsets) {
  const f = S.filters[kind];
  return `<div class="search"><input type="search" placeholder="Search ${kind}…" value="${esc(f.q ?? '')}" data-filter="${kind}" autocomplete="off">
    ${chipsets
      .filter((cs) => cs.options.length)
      .map(
        (cs) => `<div class="chips">${[['', 'All'], ...cs.options]
          .map(([v, l]) => `<button class="chip ${(f[cs.key] ?? '') === v ? 'on' : ''}" data-chip="${kind}" data-key="${cs.key}" data-val="${esc(v)}">${esc(l)}</button>`)
          .join('')}</div>`,
      )
      .join('')}</div>`;
}

const matches = (q, ...fields) => !q || fields.some((s) => String(s ?? '').toLowerCase().includes(q.toLowerCase()));

/** The empty state of a list: nothing in the game yet, or nothing matching the filters. */
function emptyList(kind, filtered) {
  if (filtered) return `<div class="empty">No ${kind} match.</div>`;
  return `<div class="empty">No ${kind} yet.<br><span class="small">They appear here once the game defines them and the catalogue is republished. Tap + to propose one.</span></div>`;
}

const cardStats = () => vocab().cardStats;
const cardArtRatio = () => {
  const [w, h] = vocab().artSizes.cards;
  return `${w} / ${h}`;
};
/** A card's headline stats, short: "1 Cost". */
const statLine = (c) => cardStats().map((s) => `${c[s.key] ?? s.default ?? 0} ${s.short ?? s.label}`).join(' · ');

function cardCover(c, extra = '') {
  const v = cardStats().length ? `<span class="vbadge">${esc(statLine(c))}</span>` : '';
  const ar = `aspect-ratio:${cardArtRatio()}`;
  if (c.upload)
    return `<div class="cover zoomable ${extra}" ${zoomAttrs('url', uploadUrl(c.upload), c.name)} style="${ar};background-image:url('${uploadUrl(c.upload)}')">${v}${ZOOM_BADGE}</div>`;
  if (hasArt('cards', c.id))
    return `<div class="cover zoomable ${extra}" ${zoomAttrs('cards', c.id, c.name)} style="${ar};background-image:url('${artUrl('cards', c.id)}')">${v}${ZOOM_BADGE}</div>`;
  return `<div class="cover placeholder ${extra}" style="${ar}">${esc(c.name || c.id)}${v}</div>`;
}

const rarityRank = (r) => {
  const list = vocab().cardRarities;
  const i = list.indexOf(r);
  return i === -1 ? list.length : i;
};

/** A relic's icon: the one uploaded or picked from the set if the queue changes it, else its own. */
function relicIconUrl(c) {
  if (c.upload) return uploadUrl(c.upload);
  if (c.icon) return artUrl('library', c.icon);
  return hasArt('relics', c.id) ? artUrl('relics', c.id) : null;
}

/** The art a relic's icon is drawn from, as [kind, id], or null when it has none. */
function relicArt(c) {
  if (c.upload) return ['url', uploadUrl(c.upload)];
  if (c.icon) return ['library', c.icon];
  return hasArt('relics', c.id) ? ['relics', c.id] : null;
}

/** The icon set in a tall sheet, grouped by set; tapping one picks it for the open relic. */
function pickIcon() {
  const I = S.inline;
  if (!I || I.kind !== 'relics') return;
  const lib = S.cat.iconLibrary ?? [];
  const sets = [...new Set(lib.map((x) => x.set))].sort((a, b) => (a === 'Assorted') - (b === 'Assorted') || a.localeCompare(b));
  const m = $('#modal');
  const own = hasArt('relics', I.draft.id) ? artUrl('relics', I.draft.id) : null;
  const changed = I.draft.icon || I.draft.upload;
  m.innerHTML = `<div class="sheet tall icon-sheet" role="dialog" aria-modal="true">
    <div class="icon-head"><h3>Choose an icon</h3><button type="button" class="btn sm ghost" data-close>Close</button></div>
    <button type="button" class="keep-icon upload-own" data-upload><span>${UPLOAD_GLYPH}</span>Upload your own image</button>
    ${changed ? `<button type="button" class="keep-icon" data-icon=""><span ${own ? `style="background-image:url('${own}')"` : ''}></span>${own ? 'Keep the current icon' : 'No icon'}</button>` : ''}
    ${lib.length ? '' : '<p class="small muted">No icon set is published yet.</p>'}
    <div class="chips icon-sets">${sets.map((s) => `<button type="button" class="chip" data-jump="${esc(slug(s))}">${esc(s)}</button>`).join('')}</div>
    ${sets
      .map(
        (s) => `<div class="group-h" id="iconset-${esc(slug(s))}">${esc(s)} <span class="small muted">${lib.filter((x) => x.set === s).length}</span></div>
      <div class="icon-grid">${lib
        .filter((x) => x.set === s)
        .map((x) => `<button type="button" class="lib-icon ${I.draft.icon === x.id ? 'on' : ''}" data-icon="${esc(x.id)}"><img loading="lazy" src="${artUrl('library', x.id)}" alt=""></button>`)
        .join('')}</div>`,
      )
      .join('')}
  </div>`;
  m.hidden = false;
  const close = () => {
    m.hidden = true;
    m.innerHTML = '';
    m.onclick = null;
  };
  m.onclick = (e) => {
    if (e.target === m || e.target.closest('[data-close]')) return close();
    const jump = e.target.closest('[data-jump]');
    if (jump) return $(`#iconset-${jump.dataset.jump}`, m)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    if (e.target.closest('[data-upload]')) {
      close();
      return uploadArt('relics');
    }
    const pick = e.target.closest('[data-icon]');
    if (!pick) return;
    if (pick.dataset.icon) I.draft.icon = pick.dataset.icon;
    else delete I.draft.icon;
    delete I.draft.upload;
    close();
    inlineChanged();
    rerenderInline();
  };
}

const UPLOAD_GLYPH = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M5 15v4h14v-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/**
 * Upload your own image for the open card (its art) or relic (its icon):
 * choose a file, frame it, and it goes to the site repo's `uploads/` with the
 * draft pointing at it (`upload`). Replaces an icon picked from the set.
 */
async function uploadArt(kind) {
  const I = S.inline;
  if (!I || I.kind !== kind) return;
  const size = vocab().artSizes[kind];
  let blob;
  try {
    blob = await uploadAndFrame(kind === 'cards' ? { title: 'Frame the card art', size, shape: 'card' } : { title: 'Frame the icon', size, shape: 'icon' });
  } catch (e) {
    return toast(e.message, true);
  }
  if (!blob) return;
  toast('Uploading…');
  const path = await uploadImage(kind, I.draft.id || I.key, blob);
  if (!path) return;
  I.draft.upload = path;
  delete I.draft.icon;
  if (S.inline !== I) {
    I.dirty = true;
    return flushInline(I);
  }
  inlineChanged();
  rerenderInline();
}

/** "Change art": straight to the file chooser, or a choice once an upload is waiting. */
function pickCardArt() {
  const I = S.inline;
  if (!I || I.kind !== 'cards') return;
  if (!I.draft.upload) return uploadArt('cards');
  const m = $('#modal');
  m.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">
    <h3 style="margin-top:0">Card art</h3>
    <div class="cover-choices">
      <button type="button" class="btn primary" data-c="new">Upload another image</button>
      <button type="button" class="btn" data-c="drop">${hasArt('cards', I.draft.id) ? 'Back to the current art' : 'Remove the uploaded image'}</button>
      <button type="button" class="btn ghost" data-c="">Cancel</button>
    </div></div>`;
  m.hidden = false;
  m.onclick = (e) => {
    const c = e.target.closest('[data-c]');
    if (e.target !== m && !c) return;
    m.hidden = true;
    m.innerHTML = '';
    m.onclick = null;
    if (c?.dataset.c === 'new') return uploadArt('cards');
    if (c?.dataset.c === 'drop') {
      delete I.draft.upload;
      inlineChanged();
      rerenderInline();
    }
  };
}

/** A card's type name ("Attack"), from `vocab.cardTypes`. */
const typeName = (id) => vocab().cardTypes.find((t) => t.id === id)?.name ?? (id ? cap(id) : '');

/** Rarity pips, as the game draws them: one steel (Common), two silver (Uncommon), three gold (Rare). */
function pips(r) {
  const n = vocab().cardRarities.indexOf(r) + 1;
  return n > 0 ? `<span class="pips" data-rarity="${esc(r)}" title="${esc(cap(r))}">${'<i></i>'.repeat(n)}</span>` : '';
}

/** One card as a deck list row: rarity stripe, cropped art, name, headline stat. */
function cardRow(it) {
  const c = it.data;
  const art = c.upload ? uploadUrl(c.upload) : hasArt('cards', c.id) ? artUrl('cards', c.id) : null;
  const thumb = art
    ? `<span class="deck-thumb"><i style="background-image:url('${art}')"></i></span>`
    : `<span class="deck-thumb blank">${esc((c.name || '?')[0])}</span>`;
  const first = cardStats()[0];
  const sub = [typeName(c.kind), ...(c.flags ?? [])].filter(Boolean);
  return `<a class="deck-row ${esc(c.rarity ?? '')} ${it.pending?.op === 'delete' ? 'deleted' : ''} ${isOff(c) ? 'off' : ''}" href="#/cards/${encodeURIComponent(it.key)}">
    ${thumb}
    <span class="deck-name"><span class="deck-title name">${esc(c.name)}</span>${sub.length || c.rarity ? `<span class="deck-sub">${pips(c.rarity)}${esc(sub.join(' · '))}</span>` : ''}${archTags(c)}</span>
    ${offTag(c)}${pendingTag(it)}${first ? `<span class="deck-value" title="${esc(first.label)}">${esc(c[first.key] ?? first.default ?? '?')}</span>` : ''}</a>`;
}

/** A group header's colour dot (a class's or ship's own colour). */
const groupDot = (id) => (group(id)?.accent ? `<i class="gdot" style="--g:${esc(group(id).accent)}"></i>` : '');

/** The archetypes cards can be tagged with: name and colour (exported). */
const archetypes = () => S.cat.archetypes ?? [];
const archetype = (id) => archetypes().find((a) => a.id === id);
const archStyle = (id) => (archetype(id)?.color ? `style="--arch:${esc(archetype(id).color)}"` : '');
const archTags = (c) =>
  (c.archetypes ?? []).length
    ? `<span class="arch-tags">${c.archetypes.map((a) => `<i class="arch" ${archStyle(a)}>${esc(archetype(a)?.name ?? a)}</i>`).join('')}</span>`
    : '';

const cardGroupKey = (c) => c.group ?? '_none';

views.list = {
  cards() {
    const f = S.filters.cards;
    const V = vocab();
    const groups = S.cat.groups ?? [];
    const order = [...groups.map((g) => g.id), '_none'];
    const source = items('cards');
    const all = source.filter(
      ({ data: c }) =>
        matches(f.q, c.name, c.id, c.text) &&
        (!f.group || (f.group === '_none' ? !c.group : c.group === f.group)) &&
        (!f.rarity || c.rarity === f.rarity) &&
        (!f.archetype || (f.archetype === 'untagged' ? !(c.archetypes ?? []).length : (c.archetypes ?? []).includes(f.archetype))),
    );
    const extra = [...new Set(all.map((x) => cardGroupKey(x.data)))].filter((g) => !order.includes(g));
    const sections = [...order, ...extra]
      .map((g) => [g, all.filter((x) => cardGroupKey(x.data) === g).sort((a, b) => rarityRank(a.data.rarity) - rarityRank(b.data.rarity))])
      .filter(([, xs]) => xs.length);
    const label = (g) => (g === '_none' ? (groups.length ? `No ${V.groupLabel.toLowerCase()}` : 'Cards') : groupName(g));
    return (
      filterBar('cards', [
        { key: 'group', options: groups.length ? [...groups.map((g) => [g.id, g.name]), ['_none', `No ${V.groupLabel.toLowerCase()}`]] : [] },
        { key: 'rarity', options: V.cardRarities.map((r) => [r, cap(r)]) },
        { key: 'archetype', options: archetypes().length ? [...archetypes().map((a) => [a.id, a.name]), ['untagged', 'Untagged']] : [] },
      ]) +
      '<div id="results">' +
      (sections.length
        ? sections
            .map(
              ([g, xs]) => `<div class="group-h">${groupDot(g)}${esc(label(g))} <span class="small muted">${xs.length}</span></div>
          <div class="deck-list">${xs.map(cardRow).join('')}</div>`,
            )
            .join('')
        : emptyList('cards', source.length > 0)) +
      '</div>'
    );
  },

  ships() {
    const f = S.filters.ships;
    const source = items('ships');
    const all = source.filter(({ data: s }) => matches(f.q, s.name, s.role, s.passiveName, s.passive));
    return (
      filterBar('ships', []) +
      '<div id="results">' +
      (all.length ? `<div class="rows">${all.map(shipRow).join('')}</div>` : emptyList('ships', source.length > 0)) +
      '</div>'
    );
  },

  enemies() {
    const f = S.filters.enemies;
    const V = vocab();
    const source = items('enemies');
    const sectorOf = (e) => e.sectors?.[0] ?? 0;
    const acts = [...new Set(source.map((x) => sectorOf(x.data)))].sort((a, b) => (a || 99) - (b || 99));
    const rank = (e) => V.enemyRanks.findIndex((r) => r.id === e.rank);
    const all = source.filter(
      ({ data: e }) =>
        matches(f.q, e.name, e.blurb, ...(e.moves ?? []), ...(e.traits ?? [])) &&
        (!f.act || String(sectorOf(e)) === f.act) &&
        (!f.rank || e.rank === f.rank),
    );
    const groups = acts.map((a) => [a, all.filter((x) => sectorOf(x.data) === a).sort((x, y) => rank(x.data) - rank(y.data))]).filter(([, xs]) => xs.length);
    return (
      filterBar('enemies', [
        { key: 'act', options: acts.filter(Boolean).map((a) => [String(a), actName(a)]) },
        { key: 'rank', options: V.enemyRanks.map((r) => [r.id, r.name]) },
      ]) +
      '<div id="results">' +
      (groups.length
        ? groups
            .map(([a, xs]) => `<div class="group-h">${esc(a ? actName(a) : 'In no encounter')} <span class="small muted">${xs.length}</span></div><div class="rows">${xs.map(enemyListRow).join('')}</div>`)
            .join('')
        : emptyList('enemies', source.length > 0)) +
      '</div>'
    );
  },

  relics() {
    const f = S.filters.relics;
    const rarities = vocab().relicRarities;
    const source = items('relics');
    const all = source.filter(({ data: c }) => matches(f.q, c.name, c.id, c.text) && (!f.rarity || c.rarity === f.rarity));
    const groups = [...rarities.map((r) => [cap(r), all.filter((x) => x.data.rarity === r)]), ['Other', all.filter((x) => !rarities.includes(x.data.rarity))]].filter(([, xs]) => xs.length);
    return (
      filterBar('relics', [{ key: 'rarity', options: rarities.map((r) => [r, cap(r)]) }]) +
      '<div id="results">' +
      (groups.length
        ? groups
            .map(([g, xs]) => `<div class="group-h">${esc(g)} <span class="small muted">${xs.length}</span></div><div class="rows">${xs.map(relicRow).join('')}</div>`)
            .join('')
        : emptyList('relics', source.length > 0)) +
      '</div>'
    );
  },

  routes() {
    const f = S.filters.routes;
    const source = items('routes');
    const all = source.filter(({ data: r }) => matches(f.q, r.name, r.id));
    return (
      filterBar('routes', []) +
      '<div id="results">' +
      (all.length
        ? all
            .map(
              (it) => `<a class="route-card ${it.pending?.op === 'delete' ? 'deleted' : ''} ${isOff(it.data) ? 'off' : ''}" href="#/routes/${encodeURIComponent(it.key)}">
          <div class="name"><span>${esc(it.data.name)}</span>${offTag(it.data)}${pendingTag(it)}<span class="small muted" style="margin-left:auto">${it.data.nodes.length} nodes</span></div>
          <div class="map-wrap" style="margin:0">${routeSvg(it.data, { mini: true })}</div></a>`,
            )
            .join('')
        : emptyList('routes', source.length > 0)) +
      '</div>'
    );
  },

  encounters() {
    const f = S.filters.encounters;
    const V = vocab();
    const source = items('encounters');
    const acts = [...new Set(source.map((x) => x.data.act ?? 1))].sort((a, b) => a - b);
    const all = source.filter(
      ({ data: e }) =>
        matches(f.q, e.name, e.id, e.purpose, ...(e.enemies ?? []).map((v) => v.name)) &&
        (!f.act || String(e.act ?? 1) === f.act) &&
        (!f.category || e.category === f.category),
    );
    const actLabel = (s) => actName(s);
    const rank = (e) => V.encounterCategories.findIndex((c) => c.id === e.category);
    const groups = acts
      .map((s) => [s, all.filter((x) => (x.data.act ?? 1) === s).sort((a, b) => rank(a.data) - rank(b.data))])
      .filter(([, xs]) => xs.length);
    return (
      filterBar('encounters', [
        { key: 'act', options: acts.length > 1 ? acts.map((s) => [String(s), actLabel(s)]) : [] },
        { key: 'category', options: V.encounterCategories.map((c) => [c.id, c.name]) },
      ]) +
      '<div id="results">' +
      (groups.length
        ? groups
            .map(
              ([s, xs]) => `<div class="group-h">${actLabel(s)} <span class="small muted">${xs.length}</span></div><div class="rows">${xs
                .map((it) => {
                  const e = it.data;
                  const totals = enemyTotals(e).map((t) => `${t.total} ${t.short ?? t.label}`).join(' · ');
                  return `<a class="row-item enc-row ${it.pending?.op === 'delete' ? 'deleted' : ''} ${isOff(e) ? 'off' : ''}" href="#/encounters/${encodeURIComponent(it.key)}">
                  ${encShips(e)}
                  <div class="body"><div class="name">${esc(e.name)} ${offTag(e)} ${pendingTag(it)}</div>
                  <div class="tags" style="margin:4px 0 0">${e.category ? `<span class="tag">${esc(categoryName(e.category))}</span>` : ''}</div></div>
                  <div class="meta">${(e.enemies ?? []).length} ${(e.enemies ?? []).length === 1 ? 'enemy' : 'enemies'}${totals ? `<br>${esc(totals)}` : ''}</div></a>`;
                })
                .join('')}</div>`,
            )
            .join('')
        : emptyList('encounters', source.length > 0)) +
      '</div>'
    );
  },
};

/** An encounter's enemy ships, small, left to right. */
function encShips(e) {
  const list = e.enemies ?? [];
  return `<div class="enc-ships">${list
    .map((v) => (v.characterId && hasArt('characters', v.characterId) ? `<i style="background-image:url('${artUrl('characters', v.characterId)}')"></i>` : '<i class="blank"></i>'))
    .join('')}</div>`;
}

/** A sprite in a dark frame (ships, enemies): pixel art, whole, never cropped. */
function sprite(kind, id, name, cls = '') {
  if (!hasArt(kind, id)) return `<span class="sprite blank ${cls}">?</span>`;
  return `<span class="sprite zoomable ${cls}" ${zoomAttrs(kind, id, name)} style="background-image:url('${artUrl(kind, id)}')">${ZOOM_BADGE}</span>`;
}

const deckSize = (s) => (s.deck ?? []).reduce((n, x) => n + (Number(x.copies) || 0), 0);
const cardName = (id) => items('cards').find((x) => x.key === id)?.data.name ?? id;

function shipRow(it) {
  const s = it.data;
  return `<a class="row-item ship-row ${it.pending?.op === 'delete' ? 'deleted' : ''} ${isOff(s) ? 'off' : ''}" href="#/ships/${encodeURIComponent(it.key)}" style="--g:${esc(s.color ?? 'var(--accent)')}">
    ${hasArt('ships', s.id) ? `<span class="sprite sm" style="background-image:url('${artUrl('ships', s.id)}')"></span>` : '<span class="sprite sm blank">?</span>'}
    <div class="body"><div class="name">${esc(s.name)} ${offTag(s)} ${pendingTag(it)}</div>
      <div class="sub">${esc(s.role ?? '')}</div>
      <div class="ship-facts"><span>Hull <b>${esc(s.hull ?? '?')}</b></span><span>Deck <b>${deckSize(s)}</b></span>${s.passiveName ? `<span>${esc(s.passiveName)}</span>` : ''}</div></div></a>`;
}

function enemyListRow(it) {
  const e = it.data;
  const elite = e.rank && e.rank !== 'standard';
  return `<a class="row-item enemy-list-row ${it.pending?.op === 'delete' ? 'deleted' : ''}" href="#/enemies/${encodeURIComponent(it.key)}">
    ${hasArt('characters', e.id) ? `<span class="sprite sm" style="background-image:url('${artUrl('characters', e.id)}')"></span>` : '<span class="sprite sm blank">?</span>'}
    <div class="body"><div class="name">${esc(e.name)} ${elite ? `<span class="tag rank-${esc(e.rank)}">${esc(rankName(e.rank))}</span>` : ''} ${pendingTag(it)}</div>
      <div class="sub">${esc((e.moves ?? []).join(' → '))}</div>
      ${(e.traits ?? []).length ? `<div class="traits">${e.traits.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}</div>
    <div class="meta"><b class="hull">${esc(e.hp ?? '?')}</b><br>Hull</div></a>`;
}

function relicRow(it) {
  const c = it.data;
  const src = relicIconUrl(c);
  const icon = src ? `style="background-image:url('${src}')"` : '';
  return `<a class="row-item ${it.pending?.op === 'delete' ? 'deleted' : ''} ${isOff(c) ? 'off' : ''}" href="#/relics/${encodeURIComponent(it.key)}">
    <div class="relic-icon ${esc(c.rarity ?? '')}" ${icon}></div>
    <div class="body"><div class="name">${esc(c.name)} ${offTag(c)} ${pendingTag(it)}</div><div class="sub">${esc(c.text)}</div></div></a>`;
}

function routeSvg(r, { mini = false } = {}) {
  const nodes = r.nodes ?? [];
  if (!nodes.length) return `<div class="empty">No nodes</div>`;
  const colW = mini ? 34 : 62;
  const rowH = mini ? 13 : 30;
  const rad = mini ? 7 : 14;
  const pad = mini ? 12 : 26;
  const lanes = nodes.map((n) => Number(n.lane) || 0);
  const depths = nodes.map((n) => Number(n.depth) || 0);
  const minL = Math.min(...lanes);
  const maxL = Math.max(...lanes);
  const maxD = Math.max(...depths);
  const W = pad * 2 + maxD * colW;
  const H = pad * 2 + (maxL - minL) * rowH;
  const pos = (n) => [pad + (Number(n.depth) || 0) * colW, pad + ((Number(n.lane) || 0) - minL) * rowH];
  const byKey = Object.fromEntries(nodes.map((n) => [n.key, n]));
  let edges = '';
  for (const n of nodes) {
    const [x1, y1] = pos(n);
    for (const k of n.next ?? []) {
      const m = byKey[k];
      if (!m) continue;
      const [x2, y2] = pos(m);
      const mx = (x1 + x2) / 2;
      edges += `<path d="M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}" fill="none" stroke="var(--edge)" stroke-width="${mini ? 1.5 : 2.2}"/>`;
    }
  }
  let dots = '';
  for (const n of nodes) {
    const [x, y] = pos(n);
    const st = nodeStyle(n.type);
    const big = st.end ? 1.35 : 1;
    dots += `<g data-node="${esc(n.key)}"><circle cx="${x}" cy="${y}" r="${rad * big}" fill="${st.c}" stroke="var(--bg)" stroke-width="2"/>`;
    if (!mini)
      dots += `<text x="${x}" y="${y + 4.5}" text-anchor="middle" font-size="13" font-weight="700" fill="var(--bg)" font-family="system-ui">${esc(st.l)}</text>
        <text x="${x}" y="${y + rad * big + 12}" text-anchor="middle" font-size="9.5" fill="var(--ink3)" font-family="system-ui">${esc(n.key)}</text>`;
    dots += `</g>`;
  }
  return `<svg width="${W}" height="${H + (mini ? 0 : 12)}" viewBox="0 0 ${W} ${H + (mini ? 0 : 12)}" role="img" aria-label="Route map">${edges}${dots}</svg>`;
}

function routePathTable(r) {
  const paths = routePaths(r);
  if (!paths.length) return '';
  const cols = pathColumns();
  const budget = routeBudget(S.cat, r);
  const cell = (t, n) => {
    const bad = budget && ((budget.min?.[t] != null && n < budget.min[t]) || (budget.max?.[t] != null && n > budget.max[t]));
    return `<td style="${bad ? 'color:var(--danger);font-weight:700' : ''}">${n}</td>`;
  };
  return `<div class="table-wrap"><table class="paths"><thead><tr><th>Path</th>${cols
    .map((c) => `<th title="${esc(nodeStyle(c).name)}">${esc(nodeStyle(c).l)}</th>`)
    .join('')}</tr></thead><tbody>${paths
    .map(
      (p, i) =>
        `<tr><td title="${esc(p.map((n) => n.key).join(' → '))}">${i + 1}. ${esc(p.find((n) => n.branch && n.branch !== 'shared')?.branch ?? 'shared')}</td>${cols
          .map((c) => cell(c, p.filter((n) => n.type === c).length))
          .join('')}</tr>`,
    )
    .join('')}</tbody></table></div>
    ${budget ? `<p class="small muted">Red = outside the path budget (min–max per walk).</p>` : ''}`;
}

const legend = () =>
  `<div class="legend">${nodeTypeIds()
    .map((t) => nodeStyle(t))
    .map((s) => `<span><i style="background:${s.c}"></i>${esc(s.l)} ${esc(s.name)}</span>`)
    .join('')}</div>`;

// ------------------------------------------------------------------ detail

function pendingNotice(it) {
  const p = it.pending;
  if (!p) return '';
  const what = { add: 'This is a new item waiting for Claude to add it.', edit: S.proposed ? 'Showing your proposed version (not in the game yet).' : 'Showing the game version — you have a pending edit.', delete: 'Marked for deletion.' }[p.op];
  return `<div class="notice warn">${pendingTag(it)} ${what}${p.note ? `<div class="change" style="margin:8px 0 0;padding:0;border:0;background:none"><div class="note">${esc(p.note)}</div></div>` : ''}</div>`;
}

/** What switching each kind off does in the game, for the switch's caption. */
const OFF_MEANS = {
  cards: 'never offered, dealt or found',
  ships: 'never offered at the ship pick',
  relics: 'never offered, sold or found',
  routes: 'never drawn for a map',
  encounters: 'never rolled on the map',
};

/** The Active / Off switch at the top of every detail page. Everything starts active. */
function activeSwitch(kind, it, d = it.data) {
  if (it.pending?.op === 'delete' || !OFF_MEANS[kind]) return '';
  const on = !isOff(d);
  return `<button type="button" class="active-switch ${on ? 'on' : ''}" role="switch" aria-checked="${on}" data-act="toggle-active" data-kind="${kind}" data-key="${esc(it.key)}">
    <span class="knob"></span><span class="lbl"><b>${on ? 'Active' : 'Off'}</b><small>${on ? 'In the game' : `Kept, but ${OFF_MEANS[kind]}`}</small></span></button>`;
}

/** Kinds edited in place on their own page; only routes keep the popup editor. */
const INLINE_KINDS = ['cards', 'ships', 'enemies', 'relics', 'encounters'];

function detailActions(kind, it) {
  const k = encodeURIComponent(it.key);
  if (it.pending?.op === 'delete')
    return `<div class="actions"><button class="btn" data-act="discard" data-id="${it.pending.id}">Undo delete</button></div>`;
  const inline = INLINE_KINDS.includes(kind);
  return `<div class="actions">
    ${inline ? '' : `<a class="btn primary" href="#/${kind}/${k}/edit">Edit</a>`}
    ${inline ? `<button class="btn" data-act="dup" data-kind="${kind}" data-key="${esc(it.key)}">Duplicate</button>` : `<a class="btn" href="#/${kind}/${k}/duplicate">Duplicate</a>`}
    ${kind === 'routes' || kind === 'encounters' ? `<a class="btn" href="studio.html#/${kind}/${k}">Open in Studio (PC)</a>` : ''}
    <button class="btn" data-act="note" data-kind="${kind}" data-key="${esc(it.key)}">Note to Claude</button>
    ${it.pending ? `<button class="btn" data-act="discard" data-id="${it.pending.id}">Discard my change</button>` : ''}
    <button class="btn danger" data-act="delete" data-kind="${kind}" data-key="${esc(it.key)}">Delete</button>
  </div>`;
}

/** Card fields the page edits itself; anything else the game exports is listed read-only. */
const CARD_FIELDS = new Set(['id', 'disabled', 'upload', 'name', 'group', 'rarity', 'kind', 'text', 'flags', 'archetypes', 'upgrades']);

const opts = (list, cur) => list.map(([v, l]) => `<option value="${esc(v)}" ${String(cur ?? '') === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('');

/** A stat edited in place: a number box, or a pick when the game allows only some values (`options`). */
function statField(s, v) {
  const val = v ?? s.default ?? 0;
  if (s.options)
    return `<label class="stat"><select class="inl inl-num inl-pick" data-ipath="${esc(s.key)}" data-numeric="1">${opts(
      [...new Set([...s.options, val])].map((o) => [o, o]),
      val,
    )}</select><span>${esc(s.label)}</span></label>`;
  return `<label class="stat"><input type="number" class="inl inl-num" data-ipath="${esc(s.key)}" value="${esc(val)}"><span>${esc(s.label)}</span></label>`;
}

/** Fields the page does not edit, read-only, with the game's labels. */
function otherFields(entries) {
  const labels = vocab().fieldLabels;
  return entries.length
    ? `<h3>Other fields</h3><dl class="kv">${entries.map(([k, v]) => `<dt>${esc(labels[k] ?? k)}</dt><dd>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</dd>`).join('')}</dl>`
    : '';
}

views.detail = {
  cards(it) {
    const { live, d: c } = inlineFor('cards', it);
    const V = vocab();
    const statKeys = new Set(V.cardStats.map((s) => s.key));
    const other = Object.entries(c).filter(([k]) => !CARD_FIELDS.has(k) && !statKeys.has(k));
    const upgrades = c.upgrades ?? [];
    const groups = S.cat.groups ?? [];
    const g = group(c.group);
    const rarities = [...(V.rarityOptional ? [['', 'No rarity']] : []), ...V.cardRarities.map((r) => [r, cap(r)])];
    return `<div id="pending-slot">${pendingNotice(it)}</div><div id="active-slot">${activeSwitch('cards', it, c)}</div>
      <fieldset class="inl-wrap" ${live ? '' : 'disabled'}>
      <div class="hero"><div class="cover-col">${cardCover(c)}${live ? `<button type="button" class="cover-change" data-act="pick-art">${UPLOAD_GLYPH}${c.upload ? 'Change' : 'Upload art'}</button>` : ''}</div>
        <div class="info">
          <textarea class="inl inl-title" rows="1" data-ipath="name" placeholder="Name">${esc(c.name)}</textarea>
          <div class="tags">
            ${groups.length ? `<select class="inl-chip" data-ipath="_group" aria-label="${esc(V.groupLabel)}" style="${g?.accent ? `--g:${esc(g.accent)}` : ''}">${opts([['', `No ${V.groupLabel.toLowerCase()}`], ...groups.map((x) => [x.id, x.name])], c.group)}</select>` : ''}
            ${V.cardRarities.length ? `<select class="inl-chip tag ${esc(c.rarity ?? '')}" data-ipath="rarity" aria-label="Rarity">${opts(rarities, c.rarity ?? '')}</select>` : ''}
            ${V.cardTypes.length ? `<select class="inl-chip" data-ipath="kind" aria-label="Type">${opts(V.cardTypes.map((t) => [t.id, t.name]), c.kind)}</select>` : ''}
          </div>
          ${V.cardStats.length ? `<div class="stats">${V.cardStats.map((s) => statField(s, c[s.key])).join('')}</div>` : ''}
        </div></div>
      ${live ? '<p class="edit-hint">Tap anything to change it. It saves by itself.</p>' : ''}
      <h3>Rules</h3>
      <textarea class="inl inl-rules" data-ipath="text" placeholder="Tap to write what it does…">${esc(c.text ?? '')}</textarea>
      ${V.cardUpgrades ? `<h3>Upgrades <small class="muted small">${upgrades.length}</small></h3>
      <div class="rb-list">${upgrades.map((u, i) => upgradeCard(u, i, live && S.inline?.openUpgrade === i, { attr: 'data-ipath', count: upgrades.length })).join('')}</div>
      ${live ? '<button type="button" class="btn ghost add-row" style="width:100%;margin-top:10px" data-act="add-upgrade">+ Add upgrade</button>' : ''}` : ''}
      ${archetypes().length ? `<h3>Archetypes</h3>
      <div class="chips" style="flex-wrap:wrap;overflow:visible">${archetypes().map((a) => `<button type="button" class="chip arch-chip ${(c.archetypes ?? []).includes(a.id) ? 'on' : ''}" ${archStyle(a.id)} data-itoggle="archetypes" data-val="${esc(a.id)}">${esc(a.name)}</button>`).join('')}</div>` : ''}
      ${V.cardFlags.length ? `<h3>Flags</h3>
      <div class="chips" style="flex-wrap:wrap;overflow:visible">${V.cardFlags.map((f) => `<button type="button" class="chip ${(c.flags ?? []).includes(f) ? 'on' : ''}" data-itoggle="flags" data-val="${esc(f)}">${esc(f)}</button>`).join('')}</div>` : ''}
      </fieldset>
      ${otherFields(other)}
      <div id="actions-slot">${detailActions('cards', it)}</div>`;
  },

  ships(it) {
    const { live, d: s } = inlineFor('ships', it);
    const deck = s.deck ?? [];
    const cardsNow = items('cards').filter((x) => x.pending?.op !== 'delete');
    const g = (id) => groupName(cardsNow.find((x) => x.key === id)?.data.group ?? '');
    const thumb = (id) => (hasArt('cards', id) ? `<span class="deck-thumb sm"><i style="background-image:url('${artUrl('cards', id)}')"></i></span>` : '<span class="deck-thumb sm blank">?</span>');
    const ownGroups = [...new Set([s.id, ...(S.cat.groups ?? []).map((x) => x.id)])];
    const choices = ownGroups
      .map((gid) => [gid, cardsNow.filter((x) => (x.data.group ?? '') === gid && !deck.some((d) => d.card === x.key))])
      .filter(([, xs]) => xs.length)
      .map(([gid, xs]) => `<optgroup label="${esc(groupName(gid))}">${xs.map((x) => `<option value="${esc(x.key)}">${esc(x.data.name)}</option>`).join('')}</optgroup>`)
      .join('');
    return `<div id="pending-slot">${pendingNotice(it)}</div><div id="active-slot">${activeSwitch('ships', it, s)}</div>
      <fieldset class="inl-wrap" ${live ? '' : 'disabled'}>
      <div class="hero ship-hero" style="--g:${esc(s.color ?? 'var(--accent)')}">${sprite('ships', s.id, s.name, 'big')}
        <div class="info">
          <textarea class="inl inl-title" rows="1" data-ipath="name" placeholder="Name">${esc(s.name)}</textarea>
          <textarea class="inl inl-line" rows="1" data-ipath="role" placeholder="Its role, in one line">${esc(s.role ?? '')}</textarea>
          <div class="stats">
            <label class="stat"><input type="number" class="inl inl-num" data-ipath="hull" value="${esc(s.hull ?? 0)}"><span>Hull</span></label>
            <div class="stat"><b>${deckSize(s)}</b><span>Cards</span></div>
          </div>
        </div></div>
      ${live ? '<p class="edit-hint">Tap anything to change it. It saves by itself.</p>' : ''}
      <h3>Passive</h3>
      <div class="passive">
        <textarea class="inl inl-line passive-name" rows="1" data-ipath="passiveName" placeholder="Its name (optional)">${esc(s.passiveName ?? '')}</textarea>
        <textarea class="inl inl-rules" data-ipath="passive" placeholder="Tap to write what it does…">${esc(s.passive ?? '')}</textarea>
      </div>
      <h3>Starting deck <small class="muted small">${deckSize(s)} cards</small></h3>
      <div class="deck-list">${deck
        .map(
          (d, i) => `<div class="deck-row ship-card">
          ${thumb(d.card)}
          <a class="deck-name" href="#/cards/${encodeURIComponent(d.card)}"><span class="deck-title">${esc(cardName(d.card))}</span><span class="deck-sub">${esc(g(d.card))}</span></a>
          <span class="copies">${live ? `<button type="button" data-act="deck-step" data-i="${i}" data-d="-1" aria-label="One copy fewer">−</button>` : ''}<b>×${esc(d.copies)}</b>${live ? `<button type="button" data-act="deck-step" data-i="${i}" data-d="1" aria-label="One copy more">+</button>` : ''}</span>
        </div>`,
        )
        .join('')}</div>
      ${live ? `<div class="field add-card"><select data-deck-add="1" aria-label="Add a card"><option value="">+ Add a card…</option>${choices}</select></div>` : ''}
      <h3>Refits <small class="muted small">${(s.refits ?? []).length} · station upgrades, each for the run</small></h3>
      <div class="rb-list">${(s.refits ?? []).map((r, i) => refitCard(s, r, i, live && S.inline?.openRefit === i)).join('')}</div>
      ${live ? '<button type="button" class="btn ghost add-row" style="width:100%;margin-top:10px" data-act="add-refit">+ Add refit</button>' : ''}
      <h3>Unlock</h3>
      <textarea class="inl inl-line" rows="1" data-ipath="unlock" placeholder="How the ship is unlocked">${esc(s.unlock ?? '')}</textarea>
      </fieldset>
      <div id="actions-slot">${detailActions('ships', it)}</div>`;
  },

  enemies(it) {
    const { live, d: e } = inlineFor('enemies', it);
    const V = vocab();
    const orig = it.orig ?? {};
    const moves = e.moves ?? [];
    const traits = e.traits ?? [];
    // A trait's rule, as the battle screen words it: known for the traits the game has now.
    const rule = (t) => (orig.traits ?? []).indexOf(t) >= 0 ? orig.traitRules?.[(orig.traits ?? []).indexOf(t)] : '';
    const usedIn = items('encounters').filter((x) => x.pending?.op !== 'delete' && (x.data.enemies ?? []).some((v) => v.characterId === it.key));
    const lines = (list, path, ph, extra = () => '') =>
      `<div class="lines">${list
        .map(
          (l, i) => `<div class="line"><span class="ln">${i + 1}</span><div class="lbody"><textarea class="inl inl-line" rows="1" data-ipath="${path}.${i}" placeholder="${esc(ph)}">${esc(l)}</textarea>${extra(l)}</div>
          ${live ? `<span class="line-tools"><button type="button" data-act="row-up" data-list="${path}" data-i="${i}" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button><button type="button" data-act="row-del" data-list="${path}" data-i="${i}" aria-label="Remove">✕</button></span>` : ''}</div>`,
        )
        .join('')}</div>
      ${live ? `<button type="button" class="btn ghost add-row" data-act="add-line" data-list="${path}">+ Add ${path === 'moves' ? 'a move' : 'an ability'}</button>` : ''}`;
    return `<div id="pending-slot">${pendingNotice(it)}</div>
      <fieldset class="inl-wrap" ${live ? '' : 'disabled'}>
      <div class="hero enemy-hero">${sprite('characters', e.id, e.name, 'big')}
        <div class="info">
          <textarea class="inl inl-title" rows="1" data-ipath="name" placeholder="Name">${esc(e.name)}</textarea>
          <div class="tags">
            ${V.enemyRanks.length ? `<select class="inl-chip rank-${esc(e.rank ?? '')}" data-ipath="rank" aria-label="Rank">${opts(V.enemyRanks.map((r) => [r.id, r.name]), e.rank)}</select>` : ''}
            ${(e.sectors ?? []).map((a) => `<span class="tag">${esc(actName(a))}</span>`).join('')}
          </div>
          <div class="stats"><label class="stat"><input type="number" class="inl inl-num" data-ipath="hp" value="${esc(e.hp ?? 0)}"><span>Hull</span></label></div>
        </div></div>
      ${live ? '<p class="edit-hint">Tap anything to change it. It saves by itself.</p>' : ''}
      <h3>Moves <small class="muted small">a loop, from the top</small></h3>
      ${lines(moves, 'moves', 'e.g. Attack 3 ×2, Shield 6 to an ally, Lance: Attack 10')}
      <h3>Abilities <small class="muted small">${traits.length}</small></h3>
      ${lines(traits, 'traits', 'e.g. Armored 1, Regenerate 2', (t) => (rule(t) ? `<div class="rule">${esc(rule(t))}</div>` : ''))}
      <h3>Tap text</h3>
      <textarea class="inl inl-rules" data-ipath="blurb" placeholder="One line the player reads when tapping it (elites and bosses)…">${esc(e.blurb ?? '')}</textarea>
      </fieldset>
      <h3>Fights in <small class="muted small">${usedIn.length}</small></h3>
      ${usedIn.length ? `<div class="chips wrap">${usedIn.map((x) => `<a class="chip" href="#/encounters/${encodeURIComponent(x.key)}">${esc(x.data.name)}</a>`).join('')}</div>` : '<p class="small muted">No encounter uses it (it may be summoned, or split from another ship).</p>'}
      <div id="actions-slot">${detailActions('enemies', it)}</div>`;
  },

  relics(it) {
    const { live, d: c } = inlineFor('relics', it);
    const rarities = vocab().relicRarities;
    const src = relicIconUrl(c);
    const art = relicArt(c);
    const icon = src ? `style="background-image:url('${src}')"` : '';
    const opts = (list, cur) => list.map(([v, l]) => `<option value="${esc(v)}" ${String(cur ?? '') === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('');
    return `<div id="pending-slot">${pendingNotice(it)}</div><div id="active-slot">${activeSwitch('relics', it, c)}</div>
      <fieldset class="inl-wrap" ${live ? '' : 'disabled'}>
      <div class="hero"><div class="icon-hold"><button type="button" class="relic-icon big ${esc(c.rarity ?? '')} pick-icon" ${icon} data-act="pick-icon" aria-label="Change the icon">${live ? '<span class="pick-badge">Change</span>' : ''}</button>${art ? `<span class="zoom-btn" ${zoomAttrs(art[0], art[1], c.name)}>${ZOOM_BADGE}</span>` : ''}</div>
        <div class="info">
          <textarea class="inl inl-title" rows="1" data-ipath="name" placeholder="Name">${esc(c.name)}</textarea>
          <div class="tags">
            ${rarities.length ? `<select class="inl-chip tag ${esc(c.rarity ?? '')}" data-ipath="rarity" aria-label="Rarity">${opts(rarities.map((r) => [r, cap(r)]), c.rarity)}</select>` : ''}
          </div>
        </div></div>
      ${live ? '<p class="edit-hint">Tap anything to change it. It saves by itself.</p>' : ''}
      <h3>Effect</h3>
      <textarea class="inl inl-rules" data-ipath="text" placeholder="Tap to write what it does…">${esc(c.text ?? '')}</textarea>
      </fieldset>
      <div id="actions-slot">${detailActions('relics', it)}</div>`;
  },

  routes(it) {
    const r = it.data;
    const { errs, warns } = routeChecks(r);
    return `${pendingNotice(it)}${activeSwitch('routes', it)}<h2>${esc(r.name)}</h2>
      ${errs.map((e) => `<div class="notice err">${esc(e)}</div>`).join('')}${warns.map((e) => `<div class="notice warn">${esc(e)}</div>`).join('')}
      <div class="map-wrap">${routeSvg(r)}</div>${legend()}
      <h3>Paths</h3>${routePathTable(r)}
      <h3>Nodes</h3><div class="table-wrap"><table class="paths"><thead><tr><th>Key</th><th>Type</th><th>Branch</th><th>D</th><th>L</th><th>Next</th></tr></thead><tbody>
      ${[...r.nodes]
        .sort((a, b) => a.depth - b.depth || a.lane - b.lane)
        .map((n) => `<tr><td>${esc(n.key)}</td><td>${esc(nodeStyle(n.type).l)}</td><td>${esc(n.branch ?? '')}</td><td>${n.depth}</td><td>${n.lane}</td><td>${esc((n.next ?? []).join(', '))}</td></tr>`)
        .join('')}</tbody></table></div>
      ${detailActions('routes', it)}`;
  },

  encounters(it) {
    const e = it.data;
    const V = vocab();
    const enemies = e.enemies ?? [];
    const live = it.pending?.op !== 'delete';
    const key = esc(it.key);
    const waves = V.waves ? [...new Set(enemies.map((v) => v.arriveAfterTurn ?? 0))].sort((a, b) => a - b) : [0];
    const full = V.maxEnemies > 0 && enemies.length >= V.maxEnemies;
    return `${pendingNotice(it)}${activeSwitch('encounters', it)}
      <button type="button" class="tap-edit" ${live ? `data-act="enc-details" data-key="${key}"` : 'disabled'}>
        <h2>${esc(e.name)}${live ? ' <span class="pencil">✎</span>' : ''}</h2>
        <div class="tags"><span class="tag">${esc(actName(e.act ?? 1))}</span>${e.category ? `<span class="tag cat-${esc(e.category)}">${esc(categoryName(e.category))}</span>` : ''}</div>
        ${V.encounterPurpose && e.purpose ? `<p class="muted" style="margin:6px 0 0">${esc(e.purpose)}</p>` : ''}
      </button>
      <div class="stats"><div class="stat"><b>${enemies.length}</b><span>Enemies</span></div>${enemyTotals(e).map((t) => `<div class="stat"><b>${t.total}</b><span>Total ${esc(t.label)}</span></div>`).join('')}</div>
      ${enemies.length ? '' : '<div class="empty" style="padding:20px 0">No enemies yet.</div>'}
      ${waves
        .map(
          (w) => `${enemies.length ? `<div class="wave-h">${!V.waves ? 'Left to right (they act in this order)' : w === 0 ? 'At the start' : `After turn ${w}`}</div>` : ''}${enemies
            .map((v, i) => [v, i])
            .filter(([v]) => !V.waves || (v.arriveAfterTurn ?? 0) === w)
            .map(([v, i]) => enemyCard(v, live ? { key: it.key, i } : null))
            .join('')}`,
        )
        .join('')}
      ${live && !full ? `<button class="btn" style="width:100%;margin-top:6px" data-act="enemy-add" data-key="${key}">+ Add enemy</button>` : ''}
      ${live && full ? `<p class="small muted">At most ${V.maxEnemies} enemy ships in a fight.</p>` : ''}
      ${detailActions('encounters', it)}`;
  },
};

function portrait(id) {
  if (id && hasArt('characters', id))
    return `<div class="portrait zoomable" ${zoomAttrs('characters', id, characterDef(id)?.name)} style="background-image:url('${artUrl('characters', id)}')">${ZOOM_BADGE}</div>`;
  return `<div class="portrait" title="No portrait">?</div>`;
}

function enemyCard(v, edit = null) {
  const a = ability(v.abilityId);
  const who = characterDef(v.characterId);
  const attrs = edit ? `type="button" data-act="enemy-edit" data-key="${esc(edit.key)}" data-i="${edit.i}"` : 'type="button" disabled';
  const stats = vocab().enemyStats.map((s) => `<span>${esc(s.label)} <b>${esc(slotStat(v, s))}</b></span>`).join('');
  const elite = who?.rank && who.rank !== 'standard' ? `<span class="tag rank-${esc(who.rank)}">${esc(rankName(who.rank))}</span>` : '';
  // The portrait sits beside the button, not in it, so tapping it can enlarge it.
  return `<div class="enemy-row">${portrait(v.characterId)}<button class="vb" ${attrs}><div class="vn">${esc(v.name || who?.name || 'Enemy')} ${elite}</div>
    <div class="np">${stats}</div>
    ${who?.moves?.length ? `<div class="loop">${esc(who.moves.join(' → '))}</div>` : ''}
    ${who?.traits?.length ? `<div class="traits">${who.traits.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
    ${a ? `<div class="ab"><b>${esc(a.name)}.</b> ${esc(a.text)}</div>` : v.abilityId ? `<div class="ab"><b>${esc(v.abilityId)}</b> <span class="muted">(new ability — describe it in the note)</span></div>` : ''}</button></div>`;
}

// ------------------------------------------------------------------ sheets (inline encounter editing)

/** A bottom sheet holding a small form. Resolves to { action, values } or null on cancel. */
function sheet(html, onChange) {
  return new Promise((resolve) => {
    const m = $('#modal');
    m.innerHTML = `<div class="sheet tall" role="dialog" aria-modal="true">${html}</div>`;
    m.hidden = false;
    autosize(m);
    const done = (r) => {
      m.hidden = true;
      m.innerHTML = '';
      m.onclick = m.onchange = null;
      resolve(r);
    };
    m.onclick = (e) => {
      if (e.target === m) return done(null);
      const b = e.target.closest('[data-r]');
      if (!b) return;
      if (b.dataset.r === 'cancel') return done(null);
      const values = {};
      for (const el of m.querySelectorAll('[data-f]')) {
        const k = el.dataset.f;
        if (el.type === 'checkbox') values[k] = el.checked;
        else if (el.type === 'number') values[k] = el.value === '' ? undefined : Number(el.value);
        else values[k] = el.value.trim();
      }
      done({ action: b.dataset.r, values });
    };
    m.onchange = (e) => onChange?.(e.target, m);
  });
}

const sf = {
  num: (k, l, v) => `<div class="field"><label>${esc(l)}</label><input type="number" data-f="${esc(k)}" value="${v ?? ''}"></div>`,
  text: (k, l, v, area = false) =>
    `<div class="field"><label>${esc(l)}</label>${area ? `<textarea data-f="${k}">${esc(v ?? '')}</textarea>` : `<input type="text" data-f="${k}" value="${esc(v ?? '')}" autocomplete="off">`}</div>`,
  select: (k, l, v, opts, blank = null) =>
    `<div class="field"><label>${esc(l)}</label><select data-f="${k}">${blank != null ? `<option value="">${esc(blank)}</option>` : ''}${opts
      .map(([o, ol]) => `<option value="${esc(o)}" ${String(v ?? '') === String(o) ? 'selected' : ''}>${esc(ol)}</option>`)
      .join('')}</select></div>`,
  check: (k, l, v) => `<div class="field check"><label><input type="checkbox" data-f="${k}" ${v ? 'checked' : ''}> ${esc(l)}</label></div>`,
  note: (v) => `<div class="field note-field"><label>Note to Claude (optional)</label><textarea data-f="_note" placeholder="Why, or anything I should know…">${esc(v ?? '')}</textarea></div>`,
  buttons: (del = '', ok = 'Save') =>
    `<div class="row">${del ? `<button class="btn danger" data-r="delete" style="margin-right:auto">${esc(del)}</button>` : ''}<button class="btn ghost" data-r="cancel">Cancel</button><button class="btn primary" data-r="save">${esc(ok)}</button></div>`,
};

/** Write a changed encounter to the queue, folding into any change already pending on it. */
function commitEncounter(it, after, note, message) {
  const op = it.pending?.op === 'add' ? 'add' : 'edit';
  return commitPending((d) => stage(d, { kind: 'encounters', key: it.key, op, before: clone(it.orig), after: tidy(after), note }), message);
}

const encounterDraft = (it) => {
  const d = clone(it.pending?.after ?? it.orig ?? it.data);
  d.enemies ??= [];
  return d;
};

async function editEnemy(key, i) {
  const it = findItem('encounters', key);
  const isNew = i == null;
  const draft = encounterDraft(it);
  const last = draft.enemies[draft.enemies.length - 1];
  const v = isNew ? blankEnemy({ arriveAfterTurn: last?.arriveAfterTurn ?? 0 }) : draft.enemies[i];
  const V = vocab();
  const stats = V.enemyStats.filter((s) => !s.readOnly);
  const abilityText = (id) => ability(id)?.text ?? '';
  const who = (id) => characterDef(id);
  const loop = (id) => [who(id)?.moves?.join(' → '), (who(id)?.traits ?? []).join(' · ')].filter(Boolean).join('\n');
  const label = v.name || who(v.characterId)?.name || 'Enemy';
  const res = await sheet(
    `<div class="sheet-h">${portrait(v.characterId)}<h3>${isNew ? 'New enemy' : esc(label)}</h3></div>
     ${V.waves || stats.length ? `<div class="three">${V.waves ? sf.num('arriveAfterTurn', 'Arrives after turn', v.arriveAfterTurn ?? 0) : ''}${stats.map((s) => sf.num(s.key, s.label, v[s.key] ?? s.default ?? 0)).join('')}</div>` : ''}
     ${V.slotNames ? sf.text('name', 'Name', v.name) : ''}
     ${sf.select('characterId', V.slotNames ? 'Portrait' : 'Enemy ship', v.characterId, (S.cat.characters ?? []).map((x) => [x.id, characterDef(x.id)?.name ?? x.name]), V.slotNames ? 'No portrait' : null)}
     ${V.slotNames ? '' : `<div class="hint" id="who-text" style="white-space:pre-wrap">${esc(loop(v.characterId))}</div>`}
     ${V.slotAbilities ? `${sf.select('abilityId', 'Ability', v.abilityId, allAbilities().map((a) => [a.id, a.name]), 'None')}
     <div class="hint" id="ab-text">${esc(abilityText(v.abilityId))}</div>` : ''}
     ${!isNew && !V.slotNames && v.characterId ? `<a class="small" href="#/enemies/${encodeURIComponent(v.characterId)}" data-r="cancel">Open ${esc(label)}'s own page</a>` : ''}
     ${sf.note(it.pending?.note)}
     ${sf.buttons(isNew ? '' : 'Remove enemy')}`,
    (el, m) => {
      if (el.dataset.f === 'characterId') {
        m.querySelector('.sheet-h .portrait').outerHTML = portrait(el.value);
        const name = m.querySelector('[data-f="name"]');
        if (name && !name.value && el.value) name.value = characterDef(el.value)?.name ?? '';
        const w = m.querySelector('#who-text');
        if (w) w.textContent = loop(el.value);
      }
      if (el.dataset.f === 'abilityId') m.querySelector('#ab-text').textContent = abilityText(el.value);
    },
  );
  if (!res) return;
  const { _note, ...f } = res.values;
  if (res.action === 'delete') {
    if (!(await ask({ title: `Remove ${label}?`, ok: 'Remove', danger: true }))) return;
    draft.enemies.splice(i, 1);
  } else {
    if (!V.slotNames && !f.characterId) return toast('Pick an enemy ship', true);
    const nv = { ...f, arriveAfterTurn: f.arriveAfterTurn ?? 0 };
    if (V.slotNames) nv.name = f.name || characterDef(f.characterId)?.name || '';
    for (const s of stats) nv[s.key] = Math.max(s.min ?? 0, f[s.key] ?? s.default ?? 0);
    if (isNew) draft.enemies.push(nv);
    else draft.enemies[i] = nv;
  }
  const verb = res.action === 'delete' ? 'Remove' : isNew ? 'Add' : 'Edit';
  if (await commitEncounter(it, draft, _note, `${verb} an enemy in ${it.key}`)) {
    toast(res.action === 'delete' ? 'Enemy removed' : 'Saved');
    render();
  }
}

/** The encounter's own fields; with no `key`, creates a new encounter. */
async function editEncounterDetails(key = null) {
  const it = key ? findItem('encounters', key) : null;
  const V = vocab();
  const d = it ? encounterDraft(it) : { name: '', act: 1, category: V.encounterCategories[0]?.id, ...(V.encounterPurpose ? { purpose: '' } : {}), enemies: [] };
  const res = await sheet(
    `<h3 style="margin-top:0">${it ? 'Encounter details' : 'New encounter'}</h3>
     ${sf.text('name', 'Name', d.name)}
     <div class="two">${V.acts ? sf.select('act', V.actLabel, d.act ?? 1, actChoices(d.act).map((a) => [a, actName(a)])) : sf.num('act', V.actLabel, d.act ?? 1)}${V.encounterCategories.length ? sf.select('category', 'Category', d.category, V.encounterCategories.map((c) => [c.id, c.name])) : '<div></div>'}</div>
     ${V.encounterPurpose ? sf.text('purpose', 'Purpose / design note', d.purpose, true) : ''}
     ${sf.note(it?.pending?.note)}
     ${sf.buttons()}`,
  );
  if (!res) return;
  const f = res.values;
  if (!f.name) return toast('Name is required', true);
  const next = { ...d, name: f.name, act: Number(f.act) || 1 };
  if (V.encounterPurpose) next.purpose = f.purpose;
  if (f.category) next.category = f.category;
  if (it) {
    if (await commitEncounter(it, next, f._note, `Edit encounter ${it.key}`)) {
      toast('Saved');
      render();
    }
    return;
  }
  next.id = freshId('encounters', f.name);
  if (await commitPending((q) => stage(q, { kind: 'encounters', key: next.id, op: 'add', before: null, after: tidy(next), note: f._note }), `Propose encounter ${next.id}`)) {
    toast('Proposed — now add its enemies');
    location.hash = `#/encounters/${encodeURIComponent(next.id)}`;
  }
}

async function duplicateItem(kind, key) {
  await flushInline();
  const it = findItem(kind, key);
  const d = clone(it.pending?.after ?? it.data);
  d.name = `${d.name} (copy)`;
  if (kind === 'cards') d.upgrades = (d.upgrades ?? []).map(({ id: _id, ...u }) => u);
  d.id = freshId(kind, d.name);
  const after = cleanup(kind, tidy(d));
  if (await commitPending((q) => stage(q, { kind, key: after.id, op: 'add', before: null, after, note: '' }), `Duplicate ${kind.slice(0, -1)} ${key}`)) {
    S.inline = null;
    toast('Copy proposed');
    location.hash = `#/${kind}/${encodeURIComponent(after.id)}`;
  }
}

// ------------------------------------------------------------------ in-place editing (cards, relics)

/*
 * A card or relic page is its own editor. Its fields carry `data-ipath`;
 * finishing a field (`change`: leaving it, or picking from a list) saves the
 * whole item to the queue a moment later. Rapid edits fold into one queued
 * change, and saves never overlap (a change made mid-save is sent right after).
 */

/** The page's working copy: kept while edits are unsaved, otherwise rebuilt from the queue. */
function inlineFor(kind, it) {
  const live = it.pending?.op !== 'delete';
  if (!live) return { live, d: it.data };
  const I = S.inline;
  const mine = I && I.kind === kind && I.key === it.key;
  if (!(mine && (I.dirty || I.busy))) {
    S.inline = {
      kind,
      key: it.key,
      op: it.pending?.op === 'add' ? 'add' : 'edit',
      orig: it.orig,
      draft: clone(it.pending?.after ?? it.orig ?? it.data),
      openUpgrade: mine ? I.openUpgrade : null,
      openRefit: mine ? I.openRefit : null,
      dirty: false,
      busy: false,
    };
  }
  return { live, d: S.inline.draft };
}

function inlineValue(t) {
  if (t.type !== 'number') return t.value;
  if (t.value === '') return t.dataset.opt ? undefined : 0;
  return Number(t.value);
}

/** An upgrade's open card follows its name as it is typed. */
function upgradeTitle(path, v) {
  const m = /^upgrades\.(\d+)\.name$/.exec(path);
  if (!m) return;
  const h = $(`[data-rb-title="${m[1]}"]`);
  if (h) h.textContent = v || 'New upgrade';
}

function inlineChanged() {
  const I = S.inline;
  if (!I) return;
  I.dirty = true;
  clearTimeout(I.timer);
  I.timer = setTimeout(() => flushInline(I), 450);
}

/** Send the page's working copy to the queue, if it has unsaved edits. */
async function flushInline(I = S.inline) {
  if (!I || !I.dirty) return;
  clearTimeout(I.timer);
  if (I.busy) {
    I.again = true;
    return;
  }
  const after = cleanup(I.kind, tidy(I.draft));
  if (!after.name) return toast(`A ${KIND[I.kind].one.toLowerCase()} needs a name`, true);
  I.busy = true;
  I.dirty = false;
  const ok = await commitPending(
    (q) =>
      stage(q, {
        kind: I.kind,
        key: I.key,
        op: I.op,
        before: clone(I.orig),
        after,
        note: q.edits.find((e) => e.kind === I.kind && e.targetId === I.key)?.note ?? '',
      }),
    `${I.op === 'add' ? 'Propose' : 'Edit'} ${I.kind.slice(0, -1)} ${I.key}`,
  );
  I.busy = false;
  if (!ok) I.dirty = true;
  if (I.again) {
    I.again = false;
    I.dirty = true;
    return flushInline(I);
  }
  if (ok && !I.dirty) {
    toast('Saved');
    if (S.inline === I) refreshSlots(I);
  }
}

/** After a save: the pending banner and the action buttons, without touching the fields. */
function refreshSlots(I) {
  const it = findItem(I.kind, I.key);
  if (!it || parseHash().tab !== I.kind) return;
  const p = $('#pending-slot');
  if (p) p.innerHTML = pendingNotice(it);
  const a = $('#actions-slot');
  if (a) a.innerHTML = detailActions(I.kind, it);
  const o = $('#active-slot');
  if (o) o.innerHTML = activeSwitch(I.kind, it, I.draft);
}

/** Redraw the page from its working copy (after a choice that changes how it looks). */
function rerenderInline() {
  const I = S.inline;
  if (!I) return;
  const it = findItem(I.kind, I.key);
  if (!it) return;
  const y = window.scrollY;
  $('#view').innerHTML = views.detail[I.kind](it);
  autosize($('#view'));
  window.scrollTo(0, y);
}

/** "+" on Cards, Relics or Encounters: a small sheet, then the new item's own page. */
async function createItem(kind) {
  if (kind === 'encounters') return editEncounterDetails();
  if (kind === 'ships' || kind === 'enemies') return createShipOrEnemy(kind);
  const V = vocab();
  const card = kind === 'cards';
  const groups = S.cat.groups ?? [];
  const rarities = card ? V.cardRarities : V.relicRarities;
  const res = await sheet(
    `<h3 style="margin-top:0">${card ? 'New card' : 'New relic'}</h3>
     ${sf.text('name', 'Name', '')}
     <div class="two">${card && groups.length ? sf.select('group', V.groupLabel, '', groups.map((g) => [g.id, g.name]), 'None') : ''}${rarities.length ? sf.select('rarity', 'Rarity', rarities[0], rarities.map((r) => [r, cap(r)])) : ''}</div>
     <p class="small muted" style="margin:0">Everything else is filled in on its page.</p>
     ${sf.buttons('', 'Create')}`,
  );
  if (!res) return;
  const f = res.values;
  if (!f.name) return toast(`A ${card ? 'card' : 'relic'} needs a name`, true);
  const d = BLANK[kind]();
  d.name = f.name;
  if (f.group) d.group = f.group;
  if (f.rarity) d.rarity = f.rarity;
  d.id = freshId(kind, f.name);
  const after = cleanup(kind, tidy(d));
  if (await commitPending((q) => stage(q, { kind, key: after.id, op: 'add', before: null, after, note: '' }), `Propose ${kind.slice(0, -1)} ${after.id}`)) {
    S.inline = null;
    toast('Created. Fill in the rest here.');
    location.hash = `#/${kind}/${encodeURIComponent(after.id)}`;
  }
}

/** A new ship or enemy: name, Hull (and an enemy's rank), then its own page. */
async function createShipOrEnemy(kind) {
  const V = vocab();
  const ship = kind === 'ships';
  const res = await sheet(
    `<h3 style="margin-top:0">${ship ? 'New ship' : 'New enemy'}</h3>
     ${sf.text('name', 'Name', '')}
     <div class="two">${sf.num('hull', 'Hull', '')}${!ship && V.enemyRanks.length ? sf.select('rank', 'Rank', V.enemyRanks[0].id, V.enemyRanks.map((r) => [r.id, r.name])) : '<div></div>'}</div>
     <p class="small muted" style="margin:0">Everything else is filled in on its page.</p>
     ${sf.buttons('', 'Create')}`,
  );
  if (!res) return;
  const f = res.values;
  if (!f.name) return toast(`A${ship ? ' ship' : 'n enemy'} needs a name`, true);
  const d = BLANK[kind]();
  d.name = f.name;
  if (ship) d.hull = f.hull ?? 0;
  else {
    d.hp = f.hull ?? 0;
    if (f.rank) d.rank = f.rank;
  }
  d.id = freshId(kind, f.name);
  const after = cleanup(kind, tidy(d));
  if (await commitPending((q) => stage(q, { kind, key: after.id, op: 'add', before: null, after, note: '' }), `Propose ${kind.slice(0, -1)} ${after.id}`)) {
    S.inline = null;
    toast('Created. Fill in the rest here.');
    location.hash = `#/${kind}/${encodeURIComponent(after.id)}`;
  }
}

// ------------------------------------------------------------------ changes

function summarize(kind, key, v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => lineOf(kind, key, x));
  if (typeof v === 'object') return [JSON.stringify(v)];
  return [String(v)];
}

function lineOf(kind, key, x) {
  if (x == null || typeof x !== 'object') return String(x);
  if (key === 'enemies') {
    const V = vocab();
    const name = x.name || characterDef(x.characterId)?.name || x.characterId || '?';
    const stats = V.enemyStats.map((s) => `${s.short ?? s.label} ${slotStat(x, s) ?? '?'}`);
    return [V.waves ? `T${x.arriveAfterTurn ?? 0} ${name}` : name, ...stats, x.abilityId].filter(Boolean).join(' · ');
  }
  if (key === 'nodes') return `${x.key} ${nodeStyle(x.type).l} ${x.branch ?? ''} d${x.depth} l${x.lane} → ${(x.next ?? []).join(',') || '∅'}`;
  if (key === 'upgrades') return `${x.name}: ${x.before} → ${x.after} — ${x.text}`;
  if (key === 'deck') return `${x.copies}× ${cardName(x.card)}`;
  if (key === 'refits') return `${x.name} (${x.target === 'passive' ? 'passive' : cardName(x.target)}): ${x.after}`;
  return JSON.stringify(x);
}

/** An uploaded card art or relic icon, as the Changes tab shows it. */
const uploadDiff = (e) => `<div class="dk">${e.kind === 'cards' ? 'art' : 'icon'}</div><img class="${e.kind === 'cards' ? 'diff-cover' : 'diff-icon'}" src="${uploadUrl(e.after.upload)}" alt="">`;

/** A field's name as the Changes tab shows it: the game's label (`vocab.fieldLabels`), else the key. */
const fieldLabel = (k) => vocab().fieldLabels[k] ?? k;

function diffHtml(e) {
  if (e.op === 'delete') return '';
  if (e.op === 'add' || !e.before) {
    // Ids are never shown.
    return `<div class="diff">${Object.entries(e.after ?? {})
      .filter(([k, v]) => k !== 'id' && v !== '' && v != null && !(Array.isArray(v) && !v.length))
      .map(([k, v]) => (k === 'upload' ? uploadDiff(e) : `<div class="dk">${esc(fieldLabel(k))}</div>${summarize(e.kind, k, v).map((l) => `<div class="plus">${esc(l)}</div>`).join('')}`))
      .join('')}</div>`;
  }
  const keys = [...new Set([...Object.keys(e.before), ...Object.keys(e.after)])];
  return `<div class="diff">${keys
    .filter((k) => !same(e.before[k], e.after[k]))
    .map((k) => {
      if (k === 'disabled') return `<div class="dk">in the game</div><div class="${e.after.disabled ? 'minus' : 'plus'}">${e.after.disabled ? 'Switched off' : 'Switched back on'}</div>`;
      if (k === 'upload') return e.after.upload ? uploadDiff(e) : `<div class="dk">image</div><div class="minus">Uploaded image removed</div>`;
      if (k === 'icon' && e.after.icon) return `<div class="dk">icon</div><img class="diff-icon" src="${artUrl('library', e.after.icon)}" alt="">`;
      const a = summarize(e.kind, k, e.before[k]) || [];
      const b = summarize(e.kind, k, e.after[k]) || [];
      const minus = a.filter((l) => !b.includes(l));
      const plus = b.filter((l) => !a.includes(l));
      return `<div class="dk">${esc(fieldLabel(k))}</div>${minus.map((l) => `<div class="minus">${esc(l)}</div>`).join('')}${plus.map((l) => `<div class="plus">${esc(l)}</div>`).join('')}${!minus.length && !plus.length ? '<div class="muted">reordered</div>' : ''}`;
    })
    .join('')}</div>`;
}

function changeCard(e, applied = false) {
  const kind = KIND[e.kind] ?? { one: e.kind, name: () => e.targetId };
  const name = e.kind === 'general' ? 'General note' : kind.name(e.after ?? e.before ?? { id: e.targetId });
  const opLabel = { add: 'New', edit: same(e.before, e.after) ? 'Note' : 'Edit', delete: 'Delete', note: 'Note' }[e.op];
  const link = LIST_TABS.includes(e.kind) && !applied && e.op !== 'delete' ? `href="#/${e.kind}/${encodeURIComponent(e.targetId)}"` : '';
  return `<div class="change">
    <div class="ch"><span class="tag p-${e.op === 'note' ? 'edit' : e.op}">${opLabel}</span><span class="tag">${esc(kind.one)}</span>
      <a class="nm" ${link} style="color:inherit;text-decoration:none">${esc(name)}</a>
      <span class="when">${esc(ago(applied ? e.appliedAt : e.at))}</span></div>
    ${e.note ? `<div class="note">${esc(e.note)}</div>` : ''}
    ${applied ? (e.result ? `<div class="note" style="border-color:var(--ok)">Claude: ${esc(e.result)}</div>` : '') : diffHtml(e)}
    ${applied ? '' : `<div class="actions" style="margin-top:10px"><button class="btn sm danger" data-act="discard" data-id="${e.id}">Discard</button></div>`}
  </div>`;
}

const tokenForm = (intro) => `<div class="notice warn">${intro}</div>
  <div class="form"><div class="field"><label for="quick-token">GitHub token</label><input type="text" id="quick-token" placeholder="github_pat_…" autocomplete="off" autocapitalize="off" spellcheck="false" style="-webkit-text-security:disc">
  <div class="hint">Create a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">fine-grained token</a>: Repository access → only <b>${esc(repo())}</b>; Permissions → <b>Contents: Read and write</b>.</div></div>
  <div class="actions"><button class="btn primary" data-act="quick-token">Connect</button></div></div>`;

views.changes = () => {
  if (!token()) return tokenForm('This browser has no GitHub token yet, so it can only view. Paste one to make and see changes.');
  const edits = [...S.pending.edits].reverse();
  const applied = [...(S.pending.applied ?? [])].reverse().slice(0, 40);
  return `${S.pendingError ? `<div class="notice err">${esc(S.pendingError)}</div>` : ''}
    <div class="notice">${edits.length ? `<b>${edits.length}</b> change${edits.length === 1 ? '' : 's'} waiting.` : 'Nothing waiting.'} When you're ready, tell Claude in the project: <i>“apply the catalogue changes”</i>.</div>
    <div class="actions"><button class="btn" data-act="general-note">+ General note for Claude</button><button class="btn ghost" data-act="refresh">Refresh</button></div>
    ${edits.length ? `<h3>Waiting</h3>${edits.map((e) => changeCard(e)).join('')}` : ''}
    ${applied.length ? `<h3>Applied by Claude</h3>${applied.map((e) => changeCard(e, true)).join('')}` : ''}`;
};

// ------------------------------------------------------------------ notes (notes.js), archetypes (breakdown.js)

views.notes = notesView;
views.archetypes = () => breakdownHtml({ cardHref: (id) => `#/cards/${encodeURIComponent(id)}` });
initNotes({ toast, ask, render: () => render(), autosize, tokenForm });

// ------------------------------------------------------------------ settings

views.settings = () => `
  <div class="form">
    <div class="field"><label for="set-token">GitHub token</label>
      <input type="text" id="set-token" value="${esc(token())}" placeholder="github_pat_…" autocomplete="off" autocapitalize="off" spellcheck="false" style="-webkit-text-security:disc">
      <div class="hint">Stored only in this browser. Create a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">fine-grained token</a> with access to <b>only ${esc(repo())}</b> and the <b>Contents: Read and write</b> permission.</div></div>
    <div class="field"><label for="set-repo">Catalogue repo</label><input type="text" id="set-repo" value="${esc(repo())}" autocapitalize="off" spellcheck="false"></div>
    <div class="field check"><label><input type="checkbox" id="set-proposed" ${S.proposed ? 'checked' : ''}> Show my proposed changes in place of the game versions</label></div>
    <div class="actions"><button class="btn primary" data-act="save-settings">Save &amp; test</button><button class="btn" data-act="reload">Reload catalogue</button></div>
    <div class="notice small">Catalogue exported from the game ${esc(ago(S.cat?.exportedAt))} (${esc(S.cat ? new Date(S.cat.exportedAt).toLocaleString() : '—')}).<br>
      ${S.cat ? vocab().kinds.map((k) => `${(S.cat[k] ?? []).length} ${TAB_TITLE[k]?.toLowerCase() ?? k}`).join(' · ') : ''}</div>
  </div>`;

// ------------------------------------------------------------------ forms

const BLANK = {
  cards: () => ({ id: '', name: '', ...Object.fromEntries(vocab().cardStats.map((s) => [s.key, s.default ?? 0])), text: '', ...(vocab().cardUpgrades ? { upgrades: [] } : {}) }),
  relics: () => ({ id: '', name: '', text: '' }),
  ships: () => ({ id: '', name: '', role: '', hull: 0, passive: '', deck: [], unlock: '' }),
  enemies: () => ({ id: '', name: '', rank: vocab().enemyRanks[0]?.id, hp: 0, moves: [] }),
  routes: () => blankRoute(),
};

function newForm(r) {
  const kind = r.tab;
  if (r.id === 'new') return { kind, op: 'add', key: null, orig: null, draft: BLANK[kind](), note: '' };
  const it = findItem(kind, r.id);
  if (!it) return null;
  if (r.mode === 'duplicate') {
    const d = clone(it.data);
    d.id = `${d.id}-copy`;
    d.name = `${d.name} (copy)`;
    if (kind === 'cards') d.upgrades = (d.upgrades ?? []).map((u) => ({ ...u, id: undefined }));
    return { kind, op: 'add', key: null, orig: null, draft: d, note: '' };
  }
  const op = it.pending?.op === 'add' ? 'add' : 'edit';
  return { kind, op, key: it.key, orig: it.orig, draft: clone(it.pending?.after ?? it.data), note: it.pending?.note ?? '' };
}

const fieldText = (path, label, value, { area = false, one = false, hint = '', ph = '', attr = 'data-path' } = {}) =>
  `<div class="field"><label>${esc(label)}</label>${
    area || one
      ? `<textarea ${attr}="${path}" placeholder="${esc(ph)}" ${one ? 'class="one" rows="1"' : ''}>${esc(value ?? '')}</textarea>`
      : `<input type="text" ${attr}="${path}" value="${esc(value ?? '')}" placeholder="${esc(ph)}" autocomplete="off">`
  }${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
const fieldNum = (path, label, value, { opt = false } = {}) =>
  `<div class="field"><label>${esc(label)}</label><input type="number" data-path="${path}" data-type="number" ${opt ? 'data-opt="1"' : ''} value="${value ?? ''}"></div>`;
const fieldSelect = (path, label, value, options, { rerender = false, blank = null } = {}) =>
  `<div class="field"><label>${esc(label)}</label><select data-path="${path}" ${rerender ? 'data-rerender="1"' : ''}>${
    blank != null ? `<option value="">${esc(blank)}</option>` : ''
  }${options.map(([v, l]) => `<option value="${esc(v)}" ${String(value ?? '') === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;
const miniBtns = (list, i) =>
  `<div class="mini-btns"><button type="button" data-act="row-up" data-list="${list}" data-i="${i}" aria-label="Move up">↑</button><button type="button" data-act="row-down" data-list="${list}" data-i="${i}" aria-label="Move down">↓</button><button type="button" data-act="row-copy" data-list="${list}" data-i="${i}" aria-label="Duplicate">⧉</button><button type="button" data-act="row-del" data-list="${list}" data-i="${i}" aria-label="Remove">✕</button></div>`;

/**
 * A ship's refit: a readable card (its name, what it upgrades, the text before → after), or
 * (opened) its editor. `target` is one of the ship's starting cards, or `passive`; the text
 * before is that card's or passive's own, as proposed.
 */
function refitCard(s, r, i, open) {
  const target = r.target === 'passive' ? 'Passive' : `Every ${cardName(r.target)}`;
  const before = r.target === 'passive' ? s.passive ?? '' : items('cards').find((x) => x.key === r.target)?.data.text ?? '';
  if (!open)
    return `<button type="button" class="rb refit" data-act="refit-open" data-i="${i}">
      <span class="rb-n">${i + 1}</span>
      <span class="rb-body"><span class="rb-name">${esc(r.name || 'Untitled refit')}</span><span class="rb-target">${esc(target)}</span>
        ${before ? `<span class="rb-text rb-from">${esc(before)}</span>` : ''}<span class="rb-text rb-to">${esc(r.after || 'No new text yet — tap to write it.')}</span></span>
      <span class="rb-edit">Edit</span></button>`;
  const targets = [...(s.deck ?? []).map((d) => [d.card, `Every ${cardName(d.card)}`]), ['passive', 'The passive']];
  const count = (s.refits ?? []).length;
  return `<div class="rb open">
    <div class="rb-head"><span class="rb-n">${i + 1}</span><span class="rb-name">${esc(r.name || 'New refit')}</span>
      <button type="button" class="btn sm primary" data-act="refit-close">Done</button></div>
    ${fieldText(`refits.${i}.name`, 'Name', r.name, { ph: 'A ship system, e.g. Focusing Lenses', attr: 'data-ipath' })}
    <div class="field"><label>Upgrades</label><select data-ipath="refits.${i}.target">${opts([...new Set([...targets.map(([v]) => v), r.target])].map((v) => targets.find(([t]) => t === v) ?? [v, cardName(v)]), r.target)}</select></div>
    <div class="field"><span class="lbl">Before</span><div class="rb-text rb-from">${esc(before) || '—'}</div></div>
    ${fieldText(`refits.${i}.after`, 'After', r.after, { area: true, ph: 'The card’s (or passive’s) text once refitted.', attr: 'data-ipath' })}
    <div class="rb-tools">
      <button type="button" data-act="row-up" data-list="refits" data-i="${i}" ${i === 0 ? 'disabled' : ''}>↑ Move up</button>
      <button type="button" data-act="row-down" data-list="refits" data-i="${i}" ${i === count - 1 ? 'disabled' : ''}>↓ Move down</button>
      <button type="button" class="danger" data-act="row-del" data-list="refits" data-i="${i}">Remove</button>
    </div>
  </div>`;
}

/** An upgrade: a readable card, or (opened) its editor. */
function upgradeCard(u, i, open, { attr = 'data-path', count = 0 } = {}) {
  if (!open) {
    return `<button type="button" class="rb" data-act="rb-open" data-i="${i}">
      <span class="rb-n">${i + 1}</span>
      <span class="rb-body">
        <span class="rb-name">${esc(u.name || 'Untitled upgrade')}</span>
        ${u.before || u.after ? `<span class="rb-delta"><span class="rb-from">${esc(u.before || '—')}</span><span class="rb-arrow">→</span><span class="rb-to">${esc(u.after || '—')}</span></span>` : ''}
        ${u.text ? `<span class="rb-text">${esc(u.text)}</span>` : '<span class="rb-text muted">No rule yet — tap to write it.</span>'}
      </span>
      <span class="rb-edit">Edit</span>
    </button>`;
  }
  return `<div class="rb open">
    <div class="rb-head"><span class="rb-n">${i + 1}</span><span class="rb-name" data-rb-title="${i}">${esc(u.name || 'New upgrade')}</span>
      <button type="button" class="btn sm primary" data-act="rb-close">Done</button></div>
    ${fieldText(`upgrades.${i}.name`, 'Name', u.name, { ph: 'e.g. Sharpened', attr })}
    ${fieldText(`upgrades.${i}.before`, 'Before', u.before, { one: true, ph: 'e.g. Cost 2', attr })}
    ${fieldText(`upgrades.${i}.after`, 'After', u.after, { one: true, ph: 'e.g. Cost 1', attr })}
    ${fieldText(`upgrades.${i}.text`, 'Rule', u.text, { area: true, ph: 'What the upgraded card does.', attr })}
    <div class="rb-tools">
      <button type="button" data-act="row-up" data-list="upgrades" data-i="${i}" ${i === 0 ? 'disabled' : ''}>↑ Move up</button>
      <button type="button" data-act="row-down" data-list="upgrades" data-i="${i}" ${i === count - 1 ? 'disabled' : ''}>↓ Move down</button>
      <button type="button" class="danger" data-act="row-del" data-list="upgrades" data-i="${i}">Remove</button>
    </div>
  </div>`;
}

const formBody = {
  routes(d) {
    const { errs, warns } = routeChecks(d);
    const sorted = d.nodes.map((n, i) => [n, i]).sort(([a], [b]) => a.depth - b.depth || a.lane - b.lane);
    const types = nodeTypeIds();
    return `
      ${fieldText('name', 'Name', d.name)}
      <div class="map-wrap">${routeSvg(d)}</div>${legend()}
      ${errs.map((e) => `<div class="notice err">${esc(e)}</div>`).join('')}${warns.map((e) => `<div class="notice warn">${esc(e)}</div>`).join('')}
      <details><summary class="muted small" style="padding:6px 0">Path counts</summary>${routePathTable(d)}</details>
      <h3>Nodes</h3><p class="small muted" style="margin-top:0">Depth = column along the map, lane = row (negative is up). Tap the keys a node leads to.</p>
      ${sorted
        .map(([n, i]) => {
          const st = nodeStyle(n.type);
          const others = d.nodes.filter((m) => m.key !== n.key && ((Number(m.depth) || 0) > (Number(n.depth) || 0) || (n.next ?? []).includes(m.key)));
          return `<div class="sub-card"><div class="sub-h"><span class="tag" style="background:${st.c};color:var(--bg);border:0">${esc(st.l)}</span><b>${esc(n.key)}</b>${miniBtns('nodes', i)}</div>
            <div class="two"><div class="field"><label>Key</label><input type="text" value="${esc(n.key)}" data-act-change="rename-node" data-i="${i}" autocomplete="off" autocapitalize="off"></div>
            ${fieldSelect(`nodes.${i}.type`, 'Type', n.type, [...new Set([...types, n.type])].map((t) => [t, nodeStyle(t).name]), { rerender: true })}</div>
            <div class="two">${fieldSelect(`nodes.${i}.branch`, 'Branch', n.branch ?? 'shared', [...new Set(['shared', ...vocab().branches, n.branch ?? 'shared'])].map((b) => [b, b]), { rerender: true })}<div></div></div>
            <div class="two">${fieldNum(`nodes.${i}.depth`, 'Depth', n.depth)}${fieldNum(`nodes.${i}.lane`, 'Lane', n.lane)}</div>
            <div class="field"><span class="lbl">Leads to</span><div class="chips" style="flex-wrap:wrap;overflow:visible">${
              others.length
                ? others
                    .sort((a, b) => a.depth - b.depth || a.lane - b.lane)
                    .map((m) => `<button type="button" class="chip ${(n.next ?? []).includes(m.key) ? 'on' : ''}" data-toggle="nodes.${i}.next" data-val="${esc(m.key)}">${esc(m.key)}</button>`)
                    .join('')
                : '<span class="small muted">Nothing deeper</span>'
            }</div></div></div>`;
        })
        .join('')}
      <button type="button" class="btn" data-act="add-node">+ Add node</button>`;
  },
};

function formHtml() {
  const F = S.form;
  return `<form class="form" id="edit-form" onsubmit="return false">
    ${formBody[F.kind](F.draft)}
    <section class="fsec"><h3 class="fsec-h">Note to Claude <small>optional</small></h3>
      <div class="field note-field"><textarea data-note="1" placeholder="Why, or anything I should know when implementing this (new mechanics, art, balance intent)…">${esc(F.note)}</textarea></div></section>
    <div class="sticky-save"><button type="button" class="btn ghost" data-act="cancel">Cancel</button><button type="button" class="btn primary" data-act="save">${F.op === 'add' ? 'Propose new' : 'Save change'}</button></div>
  </form>`;
}

function rerenderForm() {
  const body = $('#editor-body');
  const y = body.scrollTop;
  body.innerHTML = formHtml();
  autosize(body);
  body.scrollTop = y;
}

/** Text boxes always show all their text: CSS field-sizing where the browser has it, else measured. */
const FIELD_SIZING = typeof CSS !== 'undefined' && CSS.supports?.('field-sizing', 'content');
function fit(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight + 2}px`;
}
function autosize(root = document) {
  if (!FIELD_SIZING) for (const ta of root.querySelectorAll('textarea')) fit(ta);
}

function validate(F, d) {
  const errs = [];
  if (!d.name) errs.push('Name is required');
  if (F.kind === 'routes') errs.push(...routeChecks(d).errs);
  return errs;
}

function finalize(F) {
  const d = tidy(F.draft);
  // Ids are never shown: a new item takes one from its name; an existing one keeps its own.
  if (F.op === 'add') d.id = freshId(F.kind, d.name, F.key);
  return cleanup(F.kind, d);
}

/** Per-kind tidying of a finished draft (shared by the popup editor and in-place editing). */
function cleanup(kind, d) {
  // Upgrades only for a game that has them (`vocab.cardUpgrades`), so a card edit carries no empty list.
  if (kind === 'cards' && (vocab().cardUpgrades || d.upgrades?.length)) d.upgrades = (d.upgrades ?? []).map((u) => ({ ...u, id: u.id ?? `${d.id}:${slug(u.name)}` }));
  if (kind === 'encounters') d.enemies ??= [];
  if (kind === 'ships') {
    d.deck = (d.deck ?? []).filter((x) => x.card && Number(x.copies) > 0);
    d.refits = (d.refits ?? []).filter((r) => r.name);
  }
  if (kind === 'enemies') {
    d.moves = (d.moves ?? []).map((l) => String(l).trim()).filter(Boolean);
    const traits = (d.traits ?? []).map((l) => String(l).trim()).filter(Boolean);
    if (traits.length) d.traits = traits;
    else delete d.traits;
  }
  if (kind === 'routes') for (const n of d.nodes) n.next ??= [];
  return d;
}

async function saveForm() {
  const F = S.form;
  const d = finalize(F);
  const errs = validate(F, d);
  if (errs.length) return toast(errs[0], true);
  const before = F.orig ? clone(F.orig) : null;
  const ok = await commitPending(
    (data) => stage(data, { kind: F.kind, key: F.op === 'add' ? F.key ?? d.id : F.key, op: F.op, before, after: d, note: F.note.trim() }),
    `${F.op === 'add' ? 'Propose' : 'Edit'} ${F.kind.slice(0, -1)} ${d.id}`,
  );
  if (!ok) return;
  toast(F.op === 'add' ? 'Proposed — waiting for Claude' : 'Saved — waiting for Claude');
  S.form = null;
  location.replace(`#/${F.kind}/${encodeURIComponent(d.id)}`);
  render();
}

// ------------------------------------------------------------------ events

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.tagName === 'TEXTAREA' && !FIELD_SIZING) fit(t);
  if (t.dataset.filter) {
    S.filters[t.dataset.filter].q = t.value;
    const tmp = document.createElement('div');
    tmp.innerHTML = views.list[t.dataset.filter]();
    $('#results')?.replaceWith(tmp.querySelector('#results'));
    return;
  }
  if (t.dataset.ipath && S.inline) {
    if (t.tagName === 'SELECT' || t.type === 'checkbox') return;
    setPath(S.inline.draft, t.dataset.ipath, inlineValue(t));
    upgradeTitle(t.dataset.ipath, t.value);
    return;
  }
  const F = S.form;
  if (!F) return;
  if (t.dataset.note) return void (F.note = t.value);
  const path = t.dataset.path;
  if (!path || t.tagName === 'SELECT' || t.type === 'checkbox') return;
  let v = t.value;
  if (t.dataset.type === 'number') v = v === '' ? (t.dataset.opt ? undefined : 0) : Number(v);
  setPath(F.draft, path, v);
  upgradeTitle(path, v);
  if (F.kind === 'routes' && /^nodes\.\d+\.(depth|lane)$/.test(path)) {
    const wrap = $('#editor-body .map-wrap');
    if (wrap) wrap.innerHTML = routeSvg(F.draft);
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'set-token') {
    LS.set('token', t.value.trim());
    refreshPending().then(render);
    return;
  }
  if (t.dataset.deckAdd && S.inline?.kind === 'ships') {
    const id = t.value;
    if (!id) return;
    (S.inline.draft.deck ??= []).push({ card: id, copies: 1 });
    inlineChanged();
    return rerenderInline();
  }
  if (t.dataset.ipath && S.inline) {
    const path = t.dataset.ipath;
    const I = S.inline;
    if (t.tagName === 'SELECT' && t.dataset.numeric) setField(I.draft, path, t.value !== '' && !Number.isNaN(Number(t.value)) ? Number(t.value) : t.value);
    else if (t.tagName === 'SELECT') setField(I.draft, path, t.value);
    else if (t.type === 'checkbox') setPath(I.draft, path, t.checked || undefined);
    else setPath(I.draft, path, inlineValue(t));
    if (path === 'name') $('#title').textContent = t.value.trim() || KIND[I.kind].one;
    inlineChanged();
    // Picking a group or rarity changes how the page looks; typing doesn't.
    if (t.tagName === 'SELECT' || t.type === 'checkbox') rerenderInline();
    return;
  }
  const F = S.form;
  if (!F) return;
  if (t.dataset.actChange === 'rename-node') {
    const n = F.draft.nodes[+t.dataset.i];
    const old = n.key;
    const nk = t.value.trim();
    if (!nk || nk === old) return void (t.value = old);
    n.key = nk;
    for (const m of F.draft.nodes) m.next = (m.next ?? []).map((k) => (k === old ? nk : k));
    return rerenderForm();
  }
  const path = t.dataset.path;
  if (!path) return;
  if (t.type === 'checkbox') setPath(F.draft, path, t.checked || undefined);
  else if (t.tagName === 'SELECT') {
    setField(F.draft, path, t.value);
    if (t.dataset.rerender) rerenderForm();
  }
});

document.addEventListener('click', async (e) => {
  const chip = e.target.closest('[data-chip]');
  if (chip) {
    S.filters[chip.dataset.chip][chip.dataset.key] = chip.dataset.val;
    return render();
  }
  const itog = e.target.closest('[data-itoggle]');
  if (itog && S.inline && !itog.closest('fieldset:disabled')) {
    const arr = getPath(S.inline.draft, itog.dataset.itoggle) ?? [];
    const v = itog.dataset.val;
    setPath(S.inline.draft, itog.dataset.itoggle, arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
    inlineChanged();
    return rerenderInline();
  }
  const tog = e.target.closest('[data-toggle]');
  if (tog && S.form) {
    const arr = getPath(S.form.draft, tog.dataset.toggle) ?? [];
    const v = tog.dataset.val;
    setPath(S.form.draft, tog.dataset.toggle, arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
    return rerenderForm();
  }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  const F = S.form;
  // Row and upgrade buttons act on the popup editor, or on the page being edited in place.
  const T = F ?? S.inline;
  const list = b.dataset.list && T ? (T.draft[b.dataset.list] ??= []) : null;
  const i = +b.dataset.i;
  const redraw = () => (F ? rerenderForm() : rerenderInline());
  const changed = () => F || inlineChanged();
  const openCard = () => $(F ? '#editor-body .rb.open' : '#view .rb.open')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  switch (act) {
    case 'row-up':
      if (i > 0) {
        [list[i - 1], list[i]] = [list[i], list[i - 1]];
        if (T.openUpgrade === i && b.dataset.list === 'upgrades') T.openUpgrade = i - 1;
        if (T.openRefit === i && b.dataset.list === 'refits') T.openRefit = i - 1;
        changed();
      }
      return redraw();
    case 'row-down':
      if (i < list.length - 1) {
        [list[i + 1], list[i]] = [list[i], list[i + 1]];
        if (T.openUpgrade === i && b.dataset.list === 'upgrades') T.openUpgrade = i + 1;
        if (T.openRefit === i && b.dataset.list === 'refits') T.openRefit = i + 1;
        changed();
      }
      return redraw();
    case 'rb-open':
      T.openUpgrade = i;
      redraw();
      return openCard();
    case 'rb-close':
      T.openUpgrade = null;
      return redraw();
    case 'row-copy': {
      const c = clone(list[i]);
      if (b.dataset.list === 'nodes') {
        c.key = `${c.key}-2`;
        c.next = [...(c.next ?? [])];
      }
      if (b.dataset.list === 'upgrades') delete c.id;
      list.splice(i + 1, 0, c);
      return rerenderForm();
    }
    case 'row-del': {
      if (['upgrades', 'refits'].includes(b.dataset.list) && !(await ask({ title: `Remove ${list[i]?.name || `this ${b.dataset.list.slice(0, -1)}`}?`, ok: 'Remove', danger: true }))) return;
      const gone = list.splice(i, 1)[0];
      if (b.dataset.list === 'upgrades') T.openUpgrade = null;
      if (b.dataset.list === 'refits') T.openRefit = null;
      if (b.dataset.list === 'nodes') for (const m of list) m.next = (m.next ?? []).filter((k) => k !== gone.key);
      changed();
      return redraw();
    }
    case 'refit-open':
      T.openRefit = i;
      redraw();
      return $('#view .rb.open')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    case 'refit-close':
      T.openRefit = null;
      return redraw();
    case 'add-refit': {
      (T.draft.refits ??= []).push({ name: '', target: T.draft.deck?.[0]?.card ?? 'passive', after: '' });
      T.openRefit = T.draft.refits.length - 1;
      // Kept as a working copy until it has a name (an unnamed refit saves nothing).
      T.dirty = true;
      redraw();
      return $('#view .rb.open')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    case 'add-upgrade':
      (T.draft.upgrades ??= []).push({ name: '', before: '', after: '', text: '' });
      T.openUpgrade = T.draft.upgrades.length - 1;
      redraw();
      return openCard();
    case 'deck-step': {
      const deck = T.draft.deck ?? [];
      const d = deck[i];
      if (!d) return;
      d.copies = Math.max(0, (Number(d.copies) || 0) + Number(b.dataset.d));
      if (!d.copies) deck.splice(i, 1);
      changed();
      return redraw();
    }
    case 'add-line': {
      (T.draft[b.dataset.list] ??= []).push('');
      // Kept as a working copy (an empty line saves nothing) until it is typed in.
      if (!F) T.dirty = true;
      redraw();
      const boxes = document.querySelectorAll(`#view [data-ipath^="${b.dataset.list}."]`);
      return boxes[boxes.length - 1]?.focus();
    }
    case 'pick-icon':
      return pickIcon();
    case 'pick-art':
      return pickCardArt();
    case 'dup':
      return duplicateItem(b.dataset.kind, b.dataset.key);
    case 'add-node': {
      const maxD = Math.max(0, ...F.draft.nodes.map((n) => Number(n.depth) || 0));
      let k = F.draft.nodes.length + 1;
      while (F.draft.nodes.some((n) => n.key === `x${k}`)) k++;
      const type = vocab().nodeTypes.find((t) => !t.end)?.id ?? 'node';
      F.draft.nodes.push({ key: `x${k}`, type, branch: 'shared', depth: maxD, lane: 0, next: [] });
      return rerenderForm();
    }
    case 'cancel': {
      S.form = null;
      // Back when the editor was opened from inside the site; otherwise close onto its page.
      if (S.hops > 0) return history.back();
      const r = parseHash();
      return location.replace(r.id && r.id !== 'new' ? `#/${r.tab}/${encodeURIComponent(r.id)}` : `#/${r.tab}`);
    }
    case 'save':
      b.disabled = true;
      await saveForm();
      b.disabled = false;
      return;
    case 'delete': {
      await flushInline();
      S.inline = null;
      const it = findItem(b.dataset.kind, b.dataset.key);
      const note = await ask({ title: `Delete ${KIND[b.dataset.kind].name(it.data)}?`, body: 'Claude will remove it from the game when applying changes.', input: true, placeholder: 'Why? (optional)', ok: 'Mark for deletion', danger: true });
      if (note === null) return;
      if (await commitPending((d) => stage(d, { kind: b.dataset.kind, key: it.key, op: 'delete', before: clone(it.orig), after: null, note }), `Delete ${b.dataset.kind.slice(0, -1)} ${it.key}`)) {
        toast(it.pending?.op === 'add' ? 'Proposal removed' : 'Marked for deletion');
        if (it.pending?.op === 'add') location.hash = `#/${b.dataset.kind}`;
        else render();
      }
      return;
    }
    case 'toggle-active': {
      const kind = b.dataset.kind;
      const I = S.inline;
      if (I && I.kind === kind && I.key === b.dataset.key) {
        // Cards and relics: the switch is one more in-place edit, saved at once.
        I.draft = withActive(I.draft, isOff(I.draft));
        $('#active-slot').innerHTML = activeSwitch(kind, findItem(kind, I.key), I.draft);
        I.dirty = true;
        return flushInline(I);
      }
      const it = findItem(kind, b.dataset.key);
      const after = withActive(it.pending?.after ?? it.orig ?? it.data, isOff(it.data));
      const op = it.pending?.op === 'add' ? 'add' : 'edit';
      const note = it.pending?.note ?? '';
      const what = isOff(after) ? 'Switch off' : 'Switch on';
      if (await commitPending((d) => stage(d, { kind, key: it.key, op, before: clone(it.orig), after: tidy(after), note }), `${what} ${kind.slice(0, -1)} ${it.key}`)) {
        toast(isOff(after) ? 'Switched off' : 'Active again');
        render();
      }
      return;
    }
    case 'note': {
      await flushInline();
      S.inline = null;
      const it = findItem(b.dataset.kind, b.dataset.key);
      const note = await ask({ title: `Note on ${KIND[b.dataset.kind].name(it.data)}`, body: 'Ask for something without editing fields yourself — e.g. “make this stronger, you choose how”.', input: true, value: it.pending?.note ?? '', ok: 'Save note' });
      if (!note) return;
      const op = it.pending?.op === 'add' ? 'add' : 'edit';
      if (await commitPending((d) => stage(d, { kind: b.dataset.kind, key: it.key, op, before: clone(it.orig), after: clone(it.pending?.after ?? it.orig), note }), `Note on ${it.key}`)) {
        toast('Note saved');
        render();
      }
      return;
    }
    case 'discard': {
      if (!(await ask({ title: 'Discard this change?', body: 'It will be removed from the queue for Claude.', ok: 'Discard', danger: true }))) return;
      await flushInline();
      if (await commitPending((d) => (d.edits = d.edits.filter((x) => x.id !== b.dataset.id)), 'Discard a pending change')) {
        S.inline = null;
        toast('Discarded');
        render();
      }
      return;
    }
    case 'general-note': {
      const note = await ask({ title: 'General note for Claude', body: 'Anything not tied to one item: a new system, a batch request, a question.', input: true, ok: 'Add' });
      if (!note) return;
      if (await commitPending((d) => d.edits.push({ id: uid(), kind: 'general', op: 'note', targetId: '', before: null, after: null, note, at: new Date().toISOString() }), 'General note')) {
        toast('Note added');
        render();
      }
      return;
    }
    case 'enemy-edit':
      return editEnemy(b.dataset.key, +b.dataset.i);
    case 'enemy-add':
      return editEnemy(b.dataset.key, null);
    case 'enc-details':
      return editEncounterDetails(b.dataset.key);
    case 'quick-token':
      LS.set('token', $('#quick-token').value.trim());
      await refreshPending();
      await loadNotes();
      if (token() && !S.pendingError) toast('Connected — changes will save to GitHub');
      return render();
    case 'refresh':
      await refreshPending();
      return render();
    case 'save-settings': {
      LS.set('token', $('#set-token').value.trim());
      LS.set('repo', $('#set-repo').value.trim() || DEFAULT_REPO);
      S.proposed = $('#set-proposed').checked;
      LS.set('proposed', S.proposed);
      await refreshPending();
      await loadNotes();
      if (token() && !S.pendingError) toast('Connected — changes will save to GitHub');
      return render();
    }
    case 'reload':
      await boot();
      return toast('Catalogue reloaded');
  }
});

$('#fab').addEventListener('click', (e) => {
  const tab = parseHash().tab;
  if (!INLINE_KINDS.includes(tab)) return;
  e.preventDefault();
  createItem(tab);
});

$('#back').addEventListener('click', () => {
  const r = parseHash();
  if (history.length > 1) history.back();
  else location.hash = `#/${r.tab}`;
});

window.addEventListener('hashchange', () => {
  S.hops = (S.hops ?? 0) + 1;
  flushInline();
  flushNotes();
  render();
  if (!S.form) window.scrollTo(0, 0);
});

// Pick up Claude's applied changes when the phone comes back to the tab.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'hidden') {
    flushNotes();
    return void flushInline();
  }
  const typing = document.activeElement?.matches?.('input, textarea, select');
  if (document.visibilityState === 'visible' && S.cat && !S.form && !typing && !S.inline?.dirty) {
    await loadCatalogue().catch(() => {});
    await refreshPending({ quiet: true });
    await loadNotes();
    render();
  }
});

async function boot() {
  try {
    await loadCatalogue();
  } catch (e) {
    $('#view').innerHTML = `<div class="notice err">Could not load the catalogue: ${esc(e.message)}</div>`;
    return;
  }
  render();
  await refreshPending({ quiet: true });
  render();
}

boot();
