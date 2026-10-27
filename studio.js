/*
 * Worldwound Studio — the desktop editor for Encounters and route layouts.
 *
 * Shares the catalogue and the change queue with the phone site (`store.js`):
 * every edit here is folded into `pending.json` exactly as a phone edit is,
 * for Claude to apply. Edits save themselves a moment after they are made;
 * Ctrl+Z / Ctrl+Y step through this session's history of the open item.
 *
 * Encounters: arrival waves are rows; enemy cards drag between them, their
 * stats (`vocab.enemyStats`) step with −/+, portraits and abilities come from
 * pickers or are dragged in from the right-hand palette.
 * Routes: a grid canvas; nodes drag to a cell, a node's handle drags out a
 * connection, node types (`vocab.nodeTypes`) drag in from the palette; paths
 * are checked live.
 */

import {
  S,
  actChoices,
  actName,
  rankName,
  slotStat,
  allAbilities,
  hooks,
  LS,
  token,
  items,
  findItem,
  stage,
  commitPending,
  refreshPending,
  loadCatalogue,
  tidy,
  freshId,
  clone,
  esc,
  ago,
  blankEnemy,
  blankRoute,
  categoryName,
  enemyTotals,
  nodeStyle,
  nodeTypeIds,
  pathColumns,
  routeBudget,
  routeChecks,
  routePaths,
  setPath,
  characterDef,
  ability,
  hasArt,
  artUrl,
  isOff,
  offTag,
  vocab,
  withActive,
} from './store.js';
import { ZOOM_BADGE, zoomAttrs } from './zoom.js';
import { breakdownHtml } from './breakdown.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
S.proposed = true;

/** The open item: its working copy, history and save state. */
let ED = null;
let filterText = '';
let lastNodeType = null;

// ------------------------------------------------------------------ chrome

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), err ? 5000 : 1800);
}
function setSync(state, title = '') {
  $('#sync').className = 'sync ' + state;
  $('#sync').title = title;
}
const setSaved = (txt) => ($('#saved').textContent = txt);
hooks.sync = setSync;
hooks.toast = toast;
hooks.changed = () => drawSide();
hooks.needToken = () => $('#token-in')?.focus();

/** A small centred dialog. Resolves to the form values, or null. */
function dialog(html, ok = 'OK', danger = false) {
  return new Promise((resolve) => {
    const d = $('#dialog');
    d.innerHTML = `<div class="box">${html}<div class="row"><button class="btn" data-r="0">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${esc(ok)}</button></div></div>`;
    d.hidden = false;
    const first = d.querySelector('input, select, textarea');
    first?.focus();
    const done = (r) => {
      d.hidden = true;
      d.innerHTML = '';
      d.onclick = d.onkeydown = null;
      resolve(r);
    };
    const values = () => Object.fromEntries($$('[data-f]', d).map((el) => [el.dataset.f, el.value.trim()]));
    d.onclick = (e) => {
      const b = e.target.closest('[data-r]');
      if (e.target === d || b?.dataset.r === '0') return done(null);
      if (b) done(values());
    };
    d.onkeydown = (e) => {
      if (e.key === 'Escape') done(null);
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') done(values());
    };
  });
}

// ------------------------------------------------------------------ routing

function parseHash() {
  const [mode = 'encounters', key] = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  const routes = !S.cat || vocab().kinds.includes('routes');
  return { mode: (mode === 'routes' && routes) || mode === 'archetypes' ? mode : 'encounters', key };
}

function render() {
  const { mode, key } = parseHash();
  for (const a of $$('.modes a')) a.classList.toggle('on', a.dataset.mode === mode);
  $('#token-banner').hidden = !!token();
  if (!S.cat) return;
  // Route layouts only for a game that authors them (`vocab.kinds`).
  $('.modes a[data-mode="routes"]').hidden = !vocab().kinds.includes('routes');
  // The archetype breakdown: a full-width page, no list or rail.
  document.querySelector('.shell').classList.toggle('wide', mode === 'archetypes');
  if (mode === 'archetypes') {
    ED = null;
    $('#side').innerHTML = '';
    $('#rail').innerHTML = '';
    $('#main').innerHTML = breakdownHtml({ cardHref: (id) => `index.html#/cards/${encodeURIComponent(id)}`, newTab: true });
    return;
  }
  if (key) openEditor(mode, key);
  else ED = null;
  drawSide();
  drawMain();
  drawRail();
}

/** Load the item into the editor, keeping unsaved work and history when it is already open. */
function openEditor(mode, key) {
  const it = findItem(mode, key);
  if (!it) {
    ED = null;
    return;
  }
  const same = ED && ED.mode === mode && ED.key === it.key;
  if (same && (ED.dirty || ED.busy)) return;
  ED = {
    mode,
    key: it.key,
    op: it.pending?.op === 'add' ? 'add' : 'edit',
    orig: it.orig,
    draft: clone(it.pending?.after ?? it.orig ?? it.data),
    note: it.pending?.note ?? '',
    live: it.pending?.op !== 'delete',
    undo: same ? ED.undo : [],
    redo: same ? ED.redo : [],
    sel: same ? ED.sel : null,
    hoverPath: null,
    dirty: false,
    busy: false,
  };
}

// ------------------------------------------------------------------ editing, history, saving

/** Change the draft through `fn`, record history, redraw and schedule a save. */
function edit(fn, redraw = true) {
  if (!ED?.live) return;
  ED.undo.push(clone(ED.draft));
  if (ED.undo.length > 200) ED.undo.shift();
  ED.redo = [];
  fn(ED.draft);
  changed();
  if (redraw) drawEditor();
}

function changed() {
  ED.dirty = true;
  setSaved('Unsaved…');
  clearTimeout(ED.timer);
  const E = ED;
  E.timer = setTimeout(() => flush(E), 700);
}

function stepHistory(from, to) {
  if (!ED?.live || !ED[from].length) return;
  ED[to].push(clone(ED.draft));
  ED.draft = ED[from].pop();
  changed();
  drawEditor();
}

/** The draft as it goes into the queue. */
function finished(E) {
  const d = tidy(E.draft);
  if (E.mode === 'encounters') {
    d.enemies ??= [];
  } else {
    d.nodes ??= [];
    for (const n of d.nodes) n.next ??= [];
  }
  return d;
}

async function flush(E = ED) {
  if (!E || !E.dirty) return;
  clearTimeout(E.timer);
  if (E.busy) return void (E.again = true);
  if (!(E.draft.name ?? '').trim()) return void setSaved('A name is needed before this can save');
  E.busy = true;
  E.dirty = false;
  setSaved('Saving…');
  const after = finished(E);
  const ok = await commitPending(
    (q) => stage(q, { kind: E.mode, key: E.key, op: E.op, before: clone(E.orig), after, note: E.note }),
    `${E.op === 'add' ? 'Propose' : 'Edit'} ${E.mode.slice(0, -1)} ${E.key} (Studio)`,
  );
  E.busy = false;
  if (!ok) E.dirty = true;
  if (E.again) {
    E.again = false;
    E.dirty = true;
    return flush(E);
  }
  if (ok && !E.dirty) {
    E.savedAt = new Date().toISOString();
    if (ED === E) {
      setSaved('Saved');
      drawSide();
      drawBanner();
    }
  } else if (!ok) setSaved('Not saved: check the token or connection');
}

// ------------------------------------------------------------------ side list

function drawSide() {
  const { mode, key } = parseHash();
  const all = items(mode).filter(({ data }) => !filterText || (data.name ?? '').toLowerCase().includes(filterText.toLowerCase()));
  const tag = (it) =>
    it.pending ? `<span class="tag p-${it.pending.op}">${{ add: 'New', edit: 'Edited', delete: 'Delete' }[it.pending.op]}</span>` : '';
  const row = (it, sub) =>
    `<a class="side-item ${it.key === key ? 'on' : ''} ${it.pending?.op === 'delete' ? 'deleted' : ''} ${isOff(it.data) ? 'off' : ''}" href="#/${mode}/${encodeURIComponent(it.key)}"><span class="nm">${esc(it.data.name || 'Untitled')}</span>${offTag(it.data)}${tag(it)}<span class="sub">${esc(sub)}</span></a>`;
  let html = `<div class="side-head"><input class="search" id="side-search" placeholder="Search ${mode}…" value="${esc(filterText)}"><button class="btn primary" data-act="new" title="New">+ New</button></div>`;
  if (mode === 'encounters') {
    const acts = [...new Set(all.map((x) => x.data.act ?? 1))].sort((a, b) => a - b);
    const cats = vocab().encounterCategories;
    const rank = (e) => cats.findIndex((c) => c.id === e.category);
    for (const a of acts) {
      html += `<div class="side-group label">${esc(actName(a))}</div>`;
      for (const it of all.filter((x) => (x.data.act ?? 1) === a).sort((x, y) => rank(x.data) - rank(y.data)))
        html += row(it, `${it.data.category ? categoryName(it.data.category) + ' · ' : ''}${it.data.enemies?.length ?? 0}`);
    }
  } else {
    for (const it of all) html += row(it, `${it.data.nodes?.length ?? 0} nodes`);
  }
  if (!all.length) html += `<p class="hint" style="padding:0 12px">${filterText ? 'Nothing matches.' : `No ${mode} yet. Start one with <b>+ New</b>.`}</p>`;
  const side = $('#side');
  const focused = document.activeElement?.id === 'side-search';
  const pos = focused ? document.activeElement.selectionStart : 0;
  side.innerHTML = html;
  if (focused) {
    const s = $('#side-search');
    s.focus();
    s.setSelectionRange(pos, pos);
  }
}

// ------------------------------------------------------------------ main

function drawEditor() {
  drawMain();
  drawRail();
}

function drawMain() {
  const main = $('#main');
  if (!ED) {
    main.innerHTML = `<div class="empty-main"><div><h2>${parseHash().mode === 'routes' ? 'Pick a route layout' : 'Pick an encounter'}</h2><p>…or start a new one with <b>+ New</b>.</p>
      <p class="hint">Everything saves by itself. <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes, <kbd>Ctrl</kbd>+<kbd>Y</kbd> redoes.</p></div></div>`;
    return;
  }
  const scroll = [main.scrollLeft, main.scrollTop];
  main.innerHTML = `<fieldset ${ED.live ? '' : 'disabled'} style="border:0;margin:0;padding:0;min-width:0">${ED.mode === 'encounters' ? encounterMain() : routeMain()}</fieldset>`;
  [main.scrollLeft, main.scrollTop] = scroll;
  drawBanner();
}

function headActions() {
  const it = findItem(ED.mode, ED.key);
  return `<div class="ed-actions">
    <button class="icon" data-act="undo" title="Undo (Ctrl+Z)" ${ED.undo.length ? '' : 'disabled'}>↶</button>
    <button class="icon" data-act="redo" title="Redo (Ctrl+Y)" ${ED.redo.length ? '' : 'disabled'}>↷</button>
    <button class="btn sm active-toggle ${isOff(ED.draft) ? '' : 'on'}" data-act="toggle-active" role="switch" aria-checked="${!isOff(ED.draft)}" title="${isOff(ED.draft) ? `Off: kept, but ${ED.mode === 'routes' ? 'never drawn for a map' : 'never rolled on the map'}. Click to switch it back on.` : 'In the game. Click to switch it off.'}"><span class="knob"></span>${isOff(ED.draft) ? 'Off' : 'Active'}</button>
    <button class="btn sm" data-act="dup">Duplicate</button>
    <button class="btn sm danger" data-act="delete">${it?.pending?.op === 'add' ? 'Remove proposal' : 'Delete'}</button>
  </div>`;
}

/** The "not in the game yet" line under the header (redrawn after each save). */
function drawBanner() {
  const slot = $('#banner');
  if (!slot || !ED) return;
  const it = findItem(ED.mode, ED.key);
  const p = it?.pending;
  if (!p) return void (slot.innerHTML = '');
  const txt = { add: 'New, waiting for Claude to add it to the game.', edit: 'Edited, waiting for Claude to apply it.', delete: 'Marked for deletion.' }[p.op];
  slot.innerHTML = `<div class="banner ${p.op === 'delete' ? 'del' : ''}"><span class="tag p-${p.op}">${{ add: 'New', edit: 'Edited', delete: 'Delete' }[p.op]}</span>${txt}
    <button class="btn sm" style="margin-left:auto" data-act="discard">${p.op === 'delete' ? 'Undo delete' : p.op === 'add' ? 'Remove proposal' : 'Discard my changes'}</button></div>`;
}

// ------------------------------------------------------------------ encounter editor

const opt = (list, cur) => list.map(([v, l]) => `<option value="${esc(v)}" ${String(cur ?? '') === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('');

function portraitHtml(id, attrs = '') {
  const art = id && hasArt('characters', id);
  const bg = art ? `style="background-image:url('${artUrl('characters', id)}')"` : '';
  // The corner ⤢ (shown on hover) enlarges it; a click anywhere else keeps the portrait's own action.
  const zoom = art ? `<span class="zoom-hit" ${zoomAttrs('characters', id, characterDef(id)?.name)}>${ZOOM_BADGE}</span>` : '';
  return `<button type="button" class="portrait" ${bg} ${attrs}>${art ? zoom : '?'}</button>`;
}

function encounterMain() {
  const d = ED.draft;
  const V = vocab();
  const maxWave = Math.max(0, ...d.enemies.map((v) => Number(v.arriveAfterTurn) || 0));
  // Without arrival waves, one row: the fight's enemies, left to right.
  const waves = V.waves ? Array.from({ length: maxWave + 2 }, (_, w) => w) : [0];
  return `
    <div class="ed-head"><div class="grow">
      <input class="inl ed-name" data-bind="name" value="${esc(d.name)}" placeholder="Encounter name">
      <div class="ed-meta">
        <select class="chip-select" data-sel="act">${opt(actChoices(d.act).map((a) => [a, actName(a)]), d.act ?? 1)}</select>
        ${V.encounterCategories.length ? `<select class="chip-select cat-${esc(d.category ?? '')}" data-sel="category">${opt(V.encounterCategories.map((c) => [c.id, c.name]), d.category)}</select>` : ''}
      </div>
      ${V.encounterPurpose ? `<textarea class="inl ed-purpose" data-bind="purpose" rows="1" placeholder="Design note: what this encounter is for">${esc(d.purpose ?? '')}</textarea>` : ''}
    </div>${headActions()}</div>
    <div id="banner"></div>
    <div class="statbar">
      <div class="stat"><b>${d.enemies.length}</b><span>Enemies</span></div>
      ${enemyTotals(d).map((t) => `<div class="stat"><b>${t.total}</b><span>Total ${esc(t.label)}</span></div>`).join('')}
    </div>
    <div class="board">${waves.map((w) => waveHtml(d, w)).join('')}</div>`;
}

/** The encounter holds as many enemies as a fight allows (`vocab.maxEnemies`). */
const isFull = (d) => vocab().maxEnemies > 0 && d.enemies.length >= vocab().maxEnemies;

function waveHtml(d, w) {
  const V = vocab();
  const cards = d.enemies.map((v, i) => [v, i]).filter(([v]) => !V.waves || (Number(v.arriveAfterTurn) || 0) === w);
  const first = V.enemyStats[0];
  const sum = first ? cards.reduce((s, [v]) => s + (Number(slotStat(v, first)) || 0), 0) : 0;
  const title = !V.waves ? 'Left to right: they act in this order' : w === 0 ? 'At the start' : `After turn ${w}`;
  const full = isFull(d);
  return `<div class="wave ${cards.length ? '' : 'empty'}" data-wave="${w}">
    <div class="wave-h"><b>${title}</b><span>${cards.length ? `${cards.length}${V.maxEnemies ? ` of ${V.maxEnemies}` : ''}${first ? ` · ${esc(first.label)} ${sum}` : ''}` : 'empty'}</span></div>
    <div class="wave-cards">
      ${cards.map(([v, i]) => enemyCard(v, i)).join('')}
      ${cards.length ? '' : `<div class="wave-drop">Drop ${V.slotNames ? 'an enemy or a portrait' : 'an enemy ship'} here</div>`}
      ${full ? '' : `<button type="button" class="add-v" data-act="add-enemy" data-wave="${w}" title="Add an enemy">+</button>`}
    </div>
  </div>`;
}

function stepper(i, stat, v) {
  if (stat.readOnly) return `<div class="stepper ro" title="The enemy's own ${esc(stat.label)}: change it on its page"><div class="mid"><b class="num">${esc(v ?? stat.default ?? 0)}</b><small>${esc(stat.label)}</small></div></div>`;
  return `<div class="stepper"><button type="button" data-act="step" data-i="${i}" data-f="${esc(stat.key)}" data-d="-1">−</button>
    <div class="mid"><input type="number" class="num" data-bind="enemies.${i}.${esc(stat.key)}" data-num value="${v ?? stat.default ?? 0}"><small>${esc(stat.label)}</small></div>
    <button type="button" data-act="step" data-i="${i}" data-f="${esc(stat.key)}" data-d="1">+</button></div>`;
}

function enemyCard(v, i) {
  const V = vocab();
  const id = characterDef(v.characterId);
  const a = ability(v.abilityId);
  const full = isFull(ED.draft);
  const rank = id?.rank && id.rank !== 'standard' ? `<span class="rank rank-${esc(id.rank)}">${esc(rankName(id.rank))}</span>` : '';
  const name = V.slotNames
    ? `<input class="inl" data-bind="enemies.${i}.name" value="${esc(v.name ?? '')}" placeholder="${esc(id?.name ?? 'Enemy')}">
        <div class="idn">${id ? esc(id.name) : 'No portrait'}</div>`
    : `<div class="vn">${esc(id?.name ?? 'Pick a ship')}</div><div class="idn">${rank}${id ? `<a href="index.html#/enemies/${encodeURIComponent(v.characterId)}" target="_blank" rel="noopener" title="Its Hull, moves and abilities are edited on its own page">Edit ship ↗</a>` : ''}</div>`;
  return `<div class="vcard" draggable="true" data-vi="${i}">
    <div class="vtools">${full ? '' : `<button type="button" class="icon" data-act="v-dup" data-i="${i}" title="Duplicate">⧉</button>`}<button type="button" class="icon" data-act="v-del" data-i="${i}" title="Remove">✕</button></div>
    <div class="vtop">${portraitHtml(v.characterId, `data-act="pick-id" data-i="${i}" title="${V.slotNames ? 'Change portrait' : 'Change the ship'}"`)}
      <div class="vname">${name}</div></div>
    <div class="steppers">${V.enemyStats.map((st) => stepper(i, st, slotStat(v, st))).join('')}</div>
    ${!V.slotNames && id?.moves?.length ? `<ol class="vloop">${id.moves.map((m) => `<li>${esc(m)}</li>`).join('')}</ol>` : ''}
    ${!V.slotNames && id?.traits?.length ? `<div class="vtraits">${id.traits.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
    ${V.slotAbilities ? abilitySlot(v, i, a) : ''}
  </div>`;
}

/**
 * An enemy's ability, edited in place: its name and rule are fields on the
 * card. An ability can be shared, and editing it edits it for everyone using
 * it, so the card says when it is.
 */
function abilitySlot(v, i, a) {
  if (!v.abilityId) return `<button type="button" class="vab none" data-act="pick-ab" data-i="${i}" data-drop-ability="${i}">+ Ability</button>`;
  const others = abilityUsers(v.abilityId).filter((u) => !(u.mine && u.index === i));
  const id = esc(v.abilityId);
  return `<div class="vab edit" data-drop-ability="${i}">
    <div class="vab-head">
      <input class="inl ab-name" data-ab-id="${id}" data-ab-field="name" value="${esc(a?.name ?? v.abilityId)}" placeholder="Ability name">
      <button type="button" class="icon" data-act="pick-ab" data-i="${i}" title="Choose a different ability">⇄</button>
      <button type="button" class="icon" data-act="ab-clear" data-i="${i}" title="Take the ability off this enemy">✕</button>
    </div>
    <textarea class="inl ab-text" rows="1" data-ab-id="${id}" data-ab-field="text" placeholder="What it does…">${esc(a?.text ?? '')}</textarea>
    ${
      others.length
        ? `<div class="ab-shared" title="${esc(others.map((u) => `${u.encounter}: ${u.enemy}`).join('\n'))}">Shared — editing changes it for ${others.length} other enem${others.length === 1 ? 'y' : 'ies'} too</div>`
        : ''
    }
  </div>`;
}

/** Everyone carrying an ability: this encounter from the working copy, the rest as proposed. */
function abilityUsers(id) {
  const out = [];
  for (const it of items('encounters')) {
    const mine = ED?.mode === 'encounters' && it.key === ED.key;
    const enc = mine ? ED.draft : it.data;
    enc.enemies?.forEach((v, index) => {
      if (v.abilityId === id) out.push({ mine, index, encounter: enc.name, enemy: v.name || characterDef(v.characterId)?.name || 'Enemy' });
    });
  }
  return out;
}

/** Save one field of an enemy ability to the queue (an unknown id becomes a new ability). */
async function saveAbility(id, field, value) {
  const it = findItem('abilities', id);
  const after = clone(it?.pending?.after ?? it?.orig ?? { id, name: id, text: '' });
  if ((after[field] ?? '') === value) return;
  after[field] = value;
  if (!after.name) {
    toast('An ability needs a name', true);
    return drawMain();
  }
  const op = !it || it.pending?.op === 'add' ? 'add' : 'edit';
  setSaved('Saving…');
  const ok = await commitPending(
    (q) =>
      stage(q, {
        kind: 'abilities',
        key: id,
        op,
        before: clone(it?.orig ?? null),
        after,
        note: q.edits.find((e) => e.kind === 'abilities' && e.targetId === id)?.note ?? '',
      }),
    `${op === 'add' ? 'Propose' : 'Edit'} ability ${id} (Studio)`,
  );
  if (!ok) return setSaved('Not saved: check the token or connection');
  setSaved('Saved');
  // Every other card showing this ability follows, without disturbing the field being typed in.
  for (const el of $$(`[data-ab-id="${CSS.escape(id)}"][data-ab-field="${field}"]`)) if (el !== document.activeElement) el.value = value;
  if (!$('#rail').contains(document.activeElement)) drawRail();
}

/** "+ New ability": name it and say what it does; it is proposed and given to the enemy. */
async function newAbility(i) {
  const f = await dialog(
    `<h3>New enemy ability</h3>
     <div class="field-row"><span>Name</span><input data-f="name" placeholder="Ability name"></div>
     <textarea class="note-box" data-f="text" placeholder="What it does, as the player reads it on the enemy."></textarea>
     <p class="hint">Claude implements the behaviour when you sync, and asks if the wording leaves something open.</p>`,
    'Create',
  );
  if (!f) return;
  if (!f.name) return toast('An ability needs a name', true);
  const id = freshId('abilities', f.name);
  const ok = await commitPending(
    (q) => stage(q, { kind: 'abilities', key: id, op: 'add', before: null, after: { id, name: f.name, text: f.text ?? '' }, note: '' }),
    `Propose ability ${id} (Studio)`,
  );
  if (ok) setAbility(i, id);
}

/** Re-sort enemies by wave, keeping their order inside each wave. */
const byWave = (d) => {
  d.enemies = d.enemies.map((v, i) => [v, i]).sort(([a, i], [b, j]) => (Number(a.arriveAfterTurn) || 0) - (Number(b.arriveAfterTurn) || 0) || i - j).map(([v]) => v);
};

/** Put `v` into wave `w`, before the enemy now at index `before` (or at the wave's end). */
function placeEnemy(d, v, w, before) {
  v.arriveAfterTurn = w;
  if (before == null) {
    let at = d.enemies.length;
    for (let k = 0; k < d.enemies.length; k++) if ((Number(d.enemies[k].arriveAfterTurn) || 0) > w) { at = k; break; }
    d.enemies.splice(at, 0, v);
  } else d.enemies.splice(before, 0, v);
  byWave(d);
}

// ------------------------------------------------------------------ route editor

const CW = 104, CH = 78, PAD = 56, R = 25;
let GEO = null;

/** The game's own map icon for a node type, when the export has one; else a coloured letter. */
const nodeIcon = (type) => (hasArt('nodes', type) ? artUrl('nodes', type) : null);
const iconImg = (type, size) => {
  const src = nodeIcon(type);
  const st = nodeStyle(type);
  return src ? `<img src="${src}" width="${size}" height="${size}" alt="" draggable="false">` : `<i style="background:${st.c}">${esc(st.l)}</i>`;
};
const defaultNodeType = () => (lastNodeType && nodeTypeIds().includes(lastNodeType) ? lastNodeType : vocab().nodeTypes.find((t) => !t.end)?.id ?? nodeTypeIds()[0] ?? 'node');

function geometry(d) {
  const lanes = d.nodes.map((n) => Number(n.lane) || 0);
  const depths = d.nodes.map((n) => Number(n.depth) || 0);
  const laneMin = Math.min(0, ...lanes) - 2;
  const laneMax = Math.max(0, ...lanes) + 2;
  const depthMax = Math.max(0, ...depths) + 2;
  return { laneMin, laneMax, depthMax, w: PAD * 2 + depthMax * CW, h: PAD * 2 + (laneMax - laneMin) * CH };
}
const px = (g, depth, lane) => [PAD + depth * CW, PAD + (lane - g.laneMin) * CH];
const cellAt = (g, x, y) => ({
  depth: Math.max(0, Math.min(g.depthMax, Math.round((x - PAD) / CW))),
  lane: Math.max(g.laneMin, Math.min(g.laneMax, Math.round((y - PAD) / CH) + g.laneMin)),
});

function routeMain() {
  const d = ED.draft;
  return `
    <div class="ed-head"><div class="grow">
      <input class="inl ed-name" data-bind="name" value="${esc(d.name)}" placeholder="Route name">
      <div class="ed-meta"><span class="tag">${d.nodes.length} nodes</span></div>
    </div>${headActions()}</div>
    <div id="banner"></div>
    <div class="route-tools">
      <div class="palette">${nodeTypeIds().map((t) => `<span class="pal" draggable="true" data-node-type="${esc(t)}">${iconImg(t, 30)}${esc(nodeStyle(t).name)}</span>`).join('') || '<span class="hint">No node types yet: the export defines them (vocab.nodeTypes).</span>'}</div>
    </div>
    <p class="hint" style="margin:8px 0 0">Drag a type onto the grid to add a node · drag a node to move it · drag from its <b>◯</b> handle onto another node to connect · double-click empty space to add a ${esc(nodeStyle(defaultNodeType()).name)} · <kbd>Del</kbd> removes the selection</p>
    <div class="canvas-wrap" id="canvas-wrap">${canvasSvg()}</div>`;
}

function canvasSvg(dragging = null) {
  const d = ED.draft;
  const g = (GEO = dragging?.geo ?? geometry(d));
  const pos = (n) => (dragging?.key === n.key ? [dragging.x, dragging.y] : px(g, Number(n.depth) || 0, Number(n.lane) || 0));
  const byKey = Object.fromEntries(d.nodes.map((n) => [n.key, n]));
  const path = ED.hoverPath != null ? routePaths(d)[ED.hoverPath] : null;
  const onPath = path ? new Set(path.map((n) => n.key)) : null;
  const pathEdge = (a, b) => path && path.some((n, i) => n.key === a && path[i + 1]?.key === b);
  let grid = '';
  for (let x = 0; x <= g.depthMax; x++) {
    const [gx] = px(g, x, 0);
    grid += `<line class="gridline" x1="${gx}" y1="${PAD - 22}" x2="${gx}" y2="${g.h - PAD + 22}"/><text class="axis" x="${gx}" y="${PAD - 28}" text-anchor="middle">${x}</text>`;
  }
  for (let l = g.laneMin; l <= g.laneMax; l++) {
    const [, gy] = px(g, 0, l);
    grid += `<line class="gridline" x1="${PAD - 22}" y1="${gy}" x2="${g.w - PAD + 22}" y2="${gy}"/>`;
  }
  let edges = '';
  for (const n of d.nodes) {
    const [x1, y1] = pos(n);
    for (const k of n.next ?? []) {
      const m = byKey[k];
      if (!m) continue;
      const [x2, y2] = pos(m);
      const fwd = x2 > x1;
      const sx = x1 + (fwd ? R : 0), ex = x2 - (fwd ? R + 5 + (nodeStyle(m.type).end ? 5 : 0) : 0);
      const mx = (sx + ex) / 2;
      const dd = fwd ? `M${sx} ${y1} C${mx} ${y1} ${mx} ${y2} ${ex} ${y2}` : `M${x1} ${y1} L${x2} ${y2}`;
      const sel = ED.sel?.edge && ED.sel.edge[0] === n.key && ED.sel.edge[1] === k;
      edges += `<g data-edge="${esc(n.key)}|${esc(k)}"><path class="edge-hit" d="${dd}"/><path class="edge ${sel ? 'sel' : ''} ${pathEdge(n.key, k) ? 'hl' : ''}" d="${dd}" marker-end="url(#arrow)"/></g>`;
    }
  }
  let nodes = '';
  for (const n of d.nodes) {
    const [x, y] = pos(n);
    const st = nodeStyle(n.type);
    const r = st.end ? R + 6 : R;
    const sel = ED.sel?.node === n.key;
    const icon = nodeIcon(n.type);
    const s = r * 2 * 1.04;
    nodes += `<g class="node ${sel ? 'sel' : ''} ${onPath && !onPath.has(n.key) ? 'dim' : ''}" data-node="${esc(n.key)}" transform="translate(${x} ${y})">
      <circle class="sel-ring" r="${r + 5}"/>
      ${
        icon
          ? `<image href="${icon}" x="${-s / 2}" y="${-s / 2}" width="${s}" height="${s}"/>`
          : `<circle r="${r}" fill="${st.c}"/><text class="l" y="5" text-anchor="middle">${esc(st.l)}</text>`
      }
      <circle class="body" r="${r}"/>
      <text class="k" y="${r + 16}" text-anchor="middle">${esc(n.key)}${n.branch && n.branch !== 'shared' ? ` · ${esc(n.branch)}` : ''}</text>
      <circle class="port" cx="${r + 10}" cy="0" r="6.5" data-port="${esc(n.key)}"/>
    </g>`;
  }
  return `<svg class="canvas" id="canvas" width="${g.w}" height="${g.h}" viewBox="0 0 ${g.w} ${g.h}">
    <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="11" markerHeight="11" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#6b7885"/></marker></defs>
    <rect class="cell" id="cell-hl" width="${CW - 8}" height="${CH - 8}" rx="12" style="display:none"/>
    ${grid}${edges}${nodes}<path class="temp" id="temp" d="" style="display:none"/></svg>`;
}

function drawCanvas(dragging = null) {
  const wrap = $('#canvas-wrap');
  if (!wrap) return;
  const [l, t] = [wrap.scrollLeft, wrap.scrollTop];
  wrap.innerHTML = canvasSvg(dragging);
  [wrap.scrollLeft, wrap.scrollTop] = [l, t];
}

function svgPoint(e) {
  const svg = $('#canvas');
  const p = svg.createSVGPoint();
  p.x = e.clientX;
  p.y = e.clientY;
  return p.matrixTransform(svg.getScreenCTM().inverse());
}

function freshKey(d, type) {
  const base = String(nodeStyle(type).l || 'n').toLowerCase().replace(/[^a-z0-9]/g, '') || 'n';
  let n = 1;
  while (d.nodes.some((x) => x.key === `${base}${n}`)) n++;
  return `${base}${n}`;
}

function addNode(type, cell) {
  edit((d) => {
    let { depth, lane } = cell;
    while (d.nodes.some((n) => n.depth === depth && n.lane === lane)) lane++;
    const key = freshKey(d, type);
    d.nodes.push({ key, type, branch: 'shared', depth, lane, next: [] });
    ED.sel = { node: key };
  });
  lastNodeType = type;
}

function removeSelection() {
  if (!ED?.sel || ED.mode !== 'routes') return;
  if (ED.sel.node) {
    const k = ED.sel.node;
    edit((d) => {
      d.nodes = d.nodes.filter((n) => n.key !== k);
      for (const n of d.nodes) n.next = (n.next ?? []).filter((x) => x !== k);
    });
  } else if (ED.sel.edge) {
    const [a, b] = ED.sel.edge;
    edit((d) => {
      const n = d.nodes.find((x) => x.key === a);
      if (n) n.next = n.next.filter((x) => x !== b);
    });
  }
  ED.sel = null;
  drawEditor();
}

// ------------------------------------------------------------------ right rail

function drawRail() {
  const rail = $('#rail');
  if (!ED) {
    rail.innerHTML = `<p class="hint">Open an item to see its tools here.</p>`;
    return;
  }
  const searchFocus = document.activeElement?.dataset?.railSearch;
  const pos = searchFocus ? document.activeElement.selectionStart : 0;
  rail.innerHTML = ED.mode === 'encounters' ? encounterRail() : routeRail();
  rail.insertAdjacentHTML(
    'beforeend',
    `<section><h3>Note to Claude</h3><textarea class="note-box" data-note placeholder="Anything the fields can't say: a new ability, the intent, a question…">${esc(ED.note)}</textarea></section>`,
  );
  if (searchFocus) {
    const s = $(`[data-rail-search="${searchFocus}"]`);
    s?.focus();
    s?.setSelectionRange(pos, pos);
  }
}

const railFilter = { cast: '', abil: '' };

function encounterRail() {
  const V = vocab();
  const q = railFilter.cast.toLowerCase();
  const nameOf = (v) => characterDef(v.id)?.name ?? v.name;
  const people = (S.cat.characters ?? []).filter((v) => !q || nameOf(v).toLowerCase().includes(q));
  const qa = railFilter.abil.toLowerCase();
  const abil = allAbilities().filter((a) => !qa || (a.name + a.text).toLowerCase().includes(qa));
  const castItem = (v) =>
    `<div class="cast-item" draggable="true" data-identity="${esc(v.id)}" title="${esc(nameOf(v))}">${portraitHtml(v.id, 'tabindex="-1"')}<span>${esc(nameOf(v))}</span></div>`;
  // Enemy ships grouped by the sector they fight in, when the export says (enemies' `sectors`).
  const sectorOf = (v) => characterDef(v.id)?.sectors?.[0] ?? 0;
  const sectors = [...new Set(people.map(sectorOf))].sort((a, b) => (a || 99) - (b || 99));
  const cast = V.slotNames
    ? `<div class="cast"><div class="cast-item" draggable="true" data-identity="" title="No portrait">${portraitHtml('', 'tabindex="-1"')}<span>None</span></div>${people.map(castItem).join('')}</div>`
    : sectors
        .map((s) => `<div class="cast-h">${esc(s ? actName(s) : 'Other')}</div><div class="cast">${people.filter((v) => sectorOf(v) === s).map(castItem).join('')}</div>`)
        .join('');
  return `
    <section><h3>${V.slotNames ? 'Cast' : 'Enemy ships'}</h3>
      <input class="search" data-rail-search="cast" placeholder="Search ${V.slotNames ? 'portraits' : 'ships'}…" value="${esc(railFilter.cast)}">
      <p class="hint">Drag onto ${V.waves ? 'a wave' : 'the row'} to add an enemy, or onto a portrait to swap the ship.${V.maxEnemies ? ` At most ${V.maxEnemies} in a fight.` : ''}</p>
      ${cast}
      ${S.cat.characters?.length ? '' : '<p class="hint">No portraits yet: the export lists them (characters).</p>'}
    </section>
    ${V.slotAbilities ? `<section><h3>Abilities</h3>
      <input class="search" data-rail-search="abil" placeholder="Search abilities…" value="${esc(railFilter.abil)}">
      <p class="hint">Drag onto an enemy's ability slot.</p>
      ${abil.map((a) => `<div class="abil" draggable="true" data-ability="${esc(a.id)}"><b>${esc(a.name)}</b>${esc(a.text)}</div>`).join('')}
    </section>` : ''}`;
}

function routeRail() {
  const d = ED.draft;
  const { errs, warns, paths } = routeChecks(d);
  const n = ED.sel?.node ? d.nodes.find((x) => x.key === ED.sel.node) : null;
  let insp = '<p class="hint">Click a node or a connection to edit it.</p>';
  if (n) {
    const incoming = d.nodes.filter((m) => (m.next ?? []).includes(n.key));
    insp = `
      <div class="insp-types">${nodeTypeIds().map((t) => `<button type="button" class="${n.type === t ? 'on' : ''}" data-act="node-type" data-type="${esc(t)}">${iconImg(t, 36)}${esc(nodeStyle(t).name)}</button>`).join('')}</div>
      <div class="field-row"><span>Branch</span><input list="branch-list" data-node-field="branch" value="${esc(n.branch ?? 'shared')}"><datalist id="branch-list">${['shared', ...vocab().branches].map((b) => `<option value="${esc(b)}">`).join('')}</datalist></div>
      <div class="field-row"><span>Key</span><input data-node-field="key" value="${esc(n.key)}"></div>
      <div class="field-row"><span>Leads to</span><div class="links">${(n.next ?? []).map((k) => `<span>${esc(k)}<button type="button" data-act="unlink" data-a="${esc(n.key)}" data-b="${esc(k)}" title="Remove">✕</button></span>`).join('') || '<span class="muted" style="background:none">nothing</span>'}</div></div>
      <div class="field-row"><span>From</span><div class="links">${incoming.map((m) => `<span>${esc(m.key)}<button type="button" data-act="unlink" data-a="${esc(m.key)}" data-b="${esc(n.key)}" title="Remove">✕</button></span>`).join('') || '<span class="muted" style="background:none">nothing (a start)</span>'}</div></div>
      <button class="btn sm danger" data-act="del-node">Delete node</button>`;
  } else if (ED.sel?.edge) {
    insp = `<p>${esc(ED.sel.edge[0])} → ${esc(ED.sel.edge[1])}</p><button class="btn sm danger" data-act="del-edge">Remove connection</button>`;
  }
  const budget = routeBudget(S.cat, d);
  const cols = pathColumns();
  const bad = (t, c) => budget && ((budget.min?.[t] != null && c < budget.min[t]) || (budget.max?.[t] != null && c > budget.max[t]));
  const table = paths.length
    ? `<table class="paths"><thead><tr><th>Path</th>${cols.map((c) => `<th title="${esc(nodeStyle(c).name)}">${esc(nodeStyle(c).l)}</th>`).join('')}</tr></thead><tbody>${paths
        .map((p, i) => {
          const branch = p.find((x) => x.branch && x.branch !== 'shared')?.branch ?? 'shared';
          return `<tr data-path="${i}"><td title="${esc(p.map((x) => x.key).join(' → '))}">${i + 1}. ${esc(branch)}</td>${cols
            .map((c) => {
              const k = p.filter((x) => x.type === c).length;
              return `<td class="${bad(c, k) ? 'bad' : ''}">${k}</td>`;
            })
            .join('')}</tr>`;
        })
        .join('')}</tbody></table><p class="hint">Hover a path to trace it.${budget ? ' Red = outside the path budget for one walk.' : ''}</p>`
    : '<p class="hint">No complete paths yet.</p>';
  const problems = [...errs.map((e) => `<li class="err">${esc(e)}</li>`), ...warns.map((w) => `<li class="warn">${esc(w)}</li>`)];
  return `
    <section><h3>${n ? `Node ${esc(n.key)}` : ED.sel?.edge ? 'Connection' : 'Inspector'}</h3>${insp}</section>
    <section><h3>Checks</h3><ul class="problems">${problems.join('') || '<li class="ok">Every check passes; every path is complete.</li>'}</ul></section>
    <section><h3>Paths <span class="muted" style="font:600 .8rem var(--sans)">${paths.length}</span></h3>${table}</section>`;
}

// ------------------------------------------------------------------ pickers

function popover(anchor, html, onPick) {
  const pop = $('#pop');
  pop.innerHTML = html;
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left))}px`;
  pop.style.top = `${r.bottom + h + 8 > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;
  const search = $('input', pop);
  search?.focus();
  const filter = () => {
    const q = search.value.toLowerCase();
    for (const el of $$('[data-pick]', pop)) el.hidden = q && !el.textContent.toLowerCase().includes(q);
  };
  search?.addEventListener('input', filter);
  pop.onclick = (e) => {
    const el = e.target.closest('[data-pick]');
    if (!el) return;
    closePop();
    onPick(el.dataset.pick);
  };
}
const closePop = () => {
  $('#pop').hidden = true;
  $('#pop').onclick = null;
};

/** Pick a portrait (an enemy ship) for slot `i`, or, with `i` null, a ship for a new slot in wave `w`. */
function pickIdentity(anchor, i, w = 0) {
  const V = vocab();
  const v = i == null ? {} : ED.draft.enemies[i];
  const cell = (id, name) => `<div class="pop-item ${(v.characterId ?? '') === id ? 'on' : ''}" data-pick="${esc(id)}">${portraitHtml(id, 'tabindex="-1"')}${esc(name)}</div>`;
  popover(
    anchor,
    `<input class="search" placeholder="Search ${V.slotNames ? 'portraits' : 'ships'}…"><div class="list"><div class="grid">${V.slotNames ? cell('', 'None') : ''}${(S.cat.characters ?? []).map((x) => cell(x.id, characterDef(x.id)?.name ?? x.name)).join('')}</div></div>`,
    (id) => (i == null ? edit((d) => placeEnemy(d, blankEnemy(id ? { characterId: id } : {}), w, null)) : recast(i, id)),
  );
}

function recast(i, id) {
  if (!id && !vocab().slotNames) return;
  edit((d) => {
    const v = d.enemies[i];
    const oldName = characterDef(v.characterId)?.name;
    if (id) v.characterId = id;
    else delete v.characterId;
    if (vocab().slotNames && (!v.name || v.name === oldName)) v.name = characterDef(id)?.name ?? '';
  });
}

function pickAbility(anchor, i) {
  const v = ED.draft.enemies[i];
  popover(
    anchor,
    `<input class="search" placeholder="Search abilities…"><div class="list">
      <div class="pop-item new" data-pick="__new"><b>+ New ability…</b>Name it and say what it does</div>
      <div class="pop-item ${v.abilityId ? '' : 'on'}" data-pick=""><b>None</b>No ability</div>
      ${allAbilities().map((a) => `<div class="pop-item ${v.abilityId === a.id ? 'on' : ''}" data-pick="${esc(a.id)}"><b>${esc(a.name)}</b>${esc(a.text)}</div>`).join('')}</div>`,
    (id) => (id === '__new' ? newAbility(i) : setAbility(i, id)),
  );
}

function setAbility(i, id) {
  edit((d) => {
    if (id) d.enemies[i].abilityId = id;
    else delete d.enemies[i].abilityId;
  });
}

// ------------------------------------------------------------------ new / duplicate / delete / discard

async function createNew() {
  const mode = parseHash().mode;
  if (!token()) return toast('Connect a GitHub token first', true);
  const enc = mode === 'encounters';
  const V = vocab();
  const f = await dialog(
    `<h3>${enc ? 'New encounter' : 'New route layout'}</h3>
     <div class="field-row"><span>Name</span><input data-f="name" placeholder="Name"></div>
     ${enc ? `<div class="field-row"><span>${esc(V.actLabel)}</span><select data-f="act">${opt(actChoices(1).map((a) => [a, actName(a)]), 1)}</select></div>
     ${V.encounterCategories.length ? `<div class="field-row"><span>Category</span><select data-f="category">${opt(V.encounterCategories.map((c) => [c.id, c.name]), V.encounterCategories[0].id)}</select></div>` : ''}` : ''}`,
    'Create',
  );
  if (!f) return;
  if (!f.name) return toast('A name is needed', true);
  const d = enc ? { name: f.name, act: Number(f.act) || 1, ...(f.category ? { category: f.category } : {}), enemies: [] } : { ...blankRoute(), name: f.name };
  d.id = freshId(mode, f.name);
  if (await commitPending((q) => stage(q, { kind: mode, key: d.id, op: 'add', before: null, after: tidy(d), note: '' }), `Propose ${mode.slice(0, -1)} ${d.id} (Studio)`)) {
    toast('Created');
    location.hash = `#/${mode}/${encodeURIComponent(d.id)}`;
  }
}

async function duplicate() {
  await flush();
  const d = clone(ED.draft);
  d.name = `${d.name} (copy)`;
  d.id = freshId(ED.mode, d.name);
  const mode = ED.mode;
  if (await commitPending((q) => stage(q, { kind: mode, key: d.id, op: 'add', before: null, after: finished({ ...ED, draft: d, orig: null }), note: '' }), `Duplicate ${ED.key} (Studio)`)) {
    toast('Copy created');
    location.hash = `#/${mode}/${encodeURIComponent(d.id)}`;
  }
}

async function removeItem() {
  await flush();
  const it = findItem(ED.mode, ED.key);
  const adding = it.pending?.op === 'add';
  const f = await dialog(
    `<h3>${adding ? 'Remove this proposal?' : `Delete ${esc(it.data.name)}?`}</h3><p class="muted">${adding ? 'It was never in the game; it simply goes.' : 'Claude will remove it from the game when applying changes.'}</p>
     ${adding ? '' : '<textarea class="note-box" data-f="note" placeholder="Why? (optional)"></textarea>'}`,
    adding ? 'Remove' : 'Mark for deletion',
    true,
  );
  if (!f) return;
  const mode = ED.mode;
  if (await commitPending((q) => stage(q, { kind: mode, key: it.key, op: 'delete', before: clone(it.orig), after: null, note: f.note ?? '' }), `Delete ${it.key} (Studio)`)) {
    ED = null;
    if (adding) location.hash = `#/${mode}`;
    else render();
  }
}

async function discard() {
  const it = findItem(ED.mode, ED.key);
  if (!it?.pending) return;
  const f = await dialog(`<h3>${it.pending.op === 'delete' ? 'Undo the delete?' : 'Discard your changes?'}</h3><p class="muted">The queued change for Claude is removed; the game version stays as it is.</p>`, 'Yes', it.pending.op !== 'delete');
  if (!f) return;
  clearTimeout(ED.timer);
  const mode = ED.mode;
  if (await commitPending((q) => (q.edits = q.edits.filter((e) => e.id !== it.pending.id)), `Discard ${it.key} (Studio)`)) {
    ED = null;
    if (it.pending.op === 'add') location.hash = `#/${mode}`;
    else render();
  }
}

// ------------------------------------------------------------------ events: typing

document.addEventListener('focusin', (e) => {
  if (e.target.dataset?.bind && ED) ED.focusSnap = clone(ED.draft);
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'side-search') {
    filterText = t.value;
    return drawSide();
  }
  if (t.dataset.railSearch) {
    railFilter[t.dataset.railSearch] = t.value;
    return drawRail();
  }
  if (!ED?.live) return;
  if (t.dataset.note != null) {
    ED.note = t.value;
    return;
  }
  if (t.dataset.bind) {
    const v = t.dataset.num != null ? (t.value === '' ? 0 : Number(t.value)) : t.value;
    setPath(ED.draft, t.dataset.bind, v);
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (!ED?.live) return;
  if (t.dataset.abField) return void saveAbility(t.dataset.abId, t.dataset.abField, t.value.trim());
  if (t.dataset.note != null) return changed();
  if (t.dataset.bind) {
    // One history step per finished field, not per keystroke.
    if (ED.focusSnap) {
      ED.undo.push(ED.focusSnap);
      ED.redo = [];
      ED.focusSnap = null;
    }
    changed();
    if (t.dataset.num != null || t.dataset.bind === 'name') {
      drawSide();
      if (ED.mode === 'encounters') drawMain();
    }
    return;
  }
  if (t.dataset.sel) {
    const f = t.dataset.sel;
    return edit((d) => {
      if (f === 'act') d.act = Number(t.value);
      else d[f] = t.value;
    });
  }
  if (t.dataset.nodeField && ED.sel?.node) {
    const k = ED.sel.node;
    const v = t.value.trim();
    if (t.dataset.nodeField === 'key') {
      if (!v || v === k) return drawRail();
      if (ED.draft.nodes.some((n) => n.key === v)) {
        toast(`There is already a node “${v}”`, true);
        return drawRail();
      }
      edit((d) => {
        for (const n of d.nodes) {
          if (n.key === k) n.key = v;
          n.next = (n.next ?? []).map((x) => (x === k ? v : x));
        }
      });
      ED.sel = { node: v };
      return drawEditor();
    }
    edit((d) => (d.nodes.find((n) => n.key === k).branch = v || 'shared'));
  }
});

// ------------------------------------------------------------------ events: clicks

document.addEventListener('click', async (e) => {
  if (!$('#pop').hidden && !e.target.closest('#pop')) closePop();
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'new') return createNew();
  if (!ED) return;
  const i = Number(b.dataset.i);
  switch (act) {
    case 'undo':
      return stepHistory('undo', 'redo');
    case 'redo':
      return stepHistory('redo', 'undo');
    case 'dup':
      return duplicate();
    case 'delete':
      return removeItem();
    case 'discard':
      return discard();
  }
  if (!ED.live) return;
  switch (act) {
    case 'toggle-active':
      // One more edit: it saves by itself and Ctrl+Z takes it back.
      return edit((d) => {
        const next = withActive(d, isOff(d));
        for (const k of Object.keys(d)) delete d[k];
        Object.assign(d, next);
      });
    case 'add-enemy':
      // A slot that is just an enemy ship starts from picking the ship.
      if (!vocab().slotNames) {
        e.stopPropagation();
        return pickIdentity(b, null, Number(b.dataset.wave));
      }
      return edit((d) => placeEnemy(d, blankEnemy(), Number(b.dataset.wave), null));
    case 'step':
      return edit((d) => {
        const v = d.enemies[i];
        const st = vocab().enemyStats.find((x) => x.key === b.dataset.f);
        v[b.dataset.f] = Math.max(st?.min ?? 0, (Number(v[b.dataset.f]) || 0) + Number(b.dataset.d) * (st?.step ?? 1));
      });
    case 'v-del':
      return edit((d) => d.enemies.splice(i, 1));
    case 'v-dup':
      if (isFull(ED.draft)) return toast(`At most ${vocab().maxEnemies} enemy ships in a fight`, true);
      return edit((d) => d.enemies.splice(i + 1, 0, clone(d.enemies[i])));
    case 'pick-id':
      e.stopPropagation();
      return pickIdentity(b, i);
    case 'pick-ab':
      e.stopPropagation();
      return pickAbility(b, i);
    case 'ab-clear':
      return setAbility(i, '');
    case 'node-type':
      return edit((d) => {
        const n = d.nodes.find((x) => x.key === ED.sel.node);
        n.type = b.dataset.type;
        lastNodeType = n.type;
      });
    case 'unlink':
      return edit((d) => {
        const n = d.nodes.find((x) => x.key === b.dataset.a);
        n.next = n.next.filter((x) => x !== b.dataset.b);
      });
    case 'del-node':
    case 'del-edge':
      return removeSelection();
  }
});

// ------------------------------------------------------------------ events: drag and drop (encounters, palette)

let dragKind = null;

document.addEventListener('pointerdown', (e) => {
  // A card drags by its body; its fields and buttons stay usable.
  const card = e.target.closest('.vcard');
  if (card) card.draggable = !e.target.closest('input, button, textarea, select');
});

document.addEventListener('dragstart', (e) => {
  const t = e.target;
  if (!ED?.live) return e.preventDefault();
  const set = (kind, value) => {
    dragKind = kind;
    e.dataTransfer.setData('text/plain', value);
    e.dataTransfer.effectAllowed = kind === 'enemy' ? 'move' : 'copy';
  };
  if (t.classList?.contains('vcard')) {
    set('enemy', t.dataset.vi);
    requestAnimationFrame(() => t.classList.add('dragging'));
  } else if (t.dataset?.identity != null) set('identity', t.dataset.identity);
  else if (t.dataset?.ability) set('ability', t.dataset.ability);
  else if (t.dataset?.nodeType) set('node', t.dataset.nodeType);
});

document.addEventListener('dragend', () => {
  dragKind = null;
  for (const el of $$('.dragging, .over, .drop-before')) el.classList.remove('dragging', 'over', 'drop-before');
  const hl = $('#cell-hl');
  if (hl) hl.style.display = 'none';
});

/**
 * Where an enemy or portrait dropped on a wave lands: before the card under
 * the pointer, or at the end. A wave is a row of cards that may wrap, so a
 * card comes first if the pointer is on a line above it, or on its line and
 * left of its middle.
 */
function dropTarget(wave, x, y) {
  const cards = $$('.vcard', wave).filter((c) => !c.classList.contains('dragging'));
  for (const c of cards) {
    const r = c.getBoundingClientRect();
    if (y < r.top || (y <= r.bottom && x < r.left + r.width / 2)) return c;
  }
  return null;
}

document.addEventListener('dragover', (e) => {
  if (!dragKind) return;
  for (const el of $$('.over, .drop-before')) el.classList.remove('over', 'drop-before');
  if (dragKind === 'ability') {
    const slot = e.target.closest('[data-drop-ability]');
    if (slot) {
      e.preventDefault();
      slot.closest('.vcard').classList.add('over');
    }
    return;
  }
  if (dragKind === 'identity') {
    const p = e.target.closest('.vcard .portrait');
    if (p) {
      e.preventDefault();
      return p.closest('.vcard').classList.add('over');
    }
  }
  if (dragKind === 'enemy' || dragKind === 'identity') {
    const wave = e.target.closest('.wave');
    if (!wave) return;
    e.preventDefault();
    wave.classList.add('over');
    dropTarget(wave, e.clientX, e.clientY)?.classList.add('drop-before');
    return;
  }
  if (dragKind === 'node') {
    const svg = e.target.closest('#canvas');
    if (!svg) return;
    e.preventDefault();
    const p = svgPoint(e);
    const c = cellAt(GEO, p.x, p.y);
    const [x, y] = px(GEO, c.depth, c.lane);
    const hl = $('#cell-hl');
    hl.style.display = '';
    hl.setAttribute('x', x - (CW - 8) / 2);
    hl.setAttribute('y', y - (CH - 8) / 2);
  }
});

document.addEventListener('drop', (e) => {
  if (!dragKind || !ED?.live) return;
  e.preventDefault();
  const value = e.dataTransfer.getData('text/plain');
  const kind = dragKind;
  dragKind = null;
  if (kind === 'ability') {
    const slot = e.target.closest('[data-drop-ability]');
    if (slot) setAbility(Number(slot.dataset.dropAbility), value);
    return;
  }
  if (kind === 'identity' && e.target.closest('.vcard .portrait')) {
    return recast(Number(e.target.closest('.vcard').dataset.vi), value);
  }
  if (kind === 'node') {
    const p = svgPoint(e);
    return addNode(value, cellAt(GEO, p.x, p.y));
  }
  const wave = e.target.closest('.wave');
  if (!wave) return;
  if (kind === 'identity' && !value && !vocab().slotNames) return;
  if (kind === 'identity' && isFull(ED.draft)) return toast(`At most ${vocab().maxEnemies} enemy ships in a fight`, true);
  const w = Number(wave.dataset.wave);
  const before = dropTarget(wave, e.clientX, e.clientY);
  edit((d) => {
    if (kind === 'enemy') {
      const from = Number(value);
      const v = d.enemies[from];
      const beforeV = before ? d.enemies[Number(before.dataset.vi)] : null;
      d.enemies.splice(from, 1);
      placeEnemy(d, v, w, beforeV ? d.enemies.indexOf(beforeV) : null);
    } else {
      const id = characterDef(value);
      const nv = blankEnemy({ arriveAfterTurn: w, ...(vocab().slotNames ? { name: id?.name ?? '' } : {}), ...(value ? { characterId: value } : {}) });
      placeEnemy(d, nv, w, before ? Number(before.dataset.vi) : null);
    }
  });
});

// ------------------------------------------------------------------ events: route canvas (pointer)

let drag = null;

document.addEventListener('pointerdown', (e) => {
  const svg = e.target.closest?.('#canvas');
  if (!svg || !ED || ED.mode !== 'routes' || e.button !== 0) return;
  const port = e.target.closest('[data-port]');
  const node = e.target.closest('[data-node]');
  const edge = e.target.closest('[data-edge]');
  const p = svgPoint(e);
  if (port && ED.live) {
    e.preventDefault();
    const from = ED.draft.nodes.find((n) => n.key === port.dataset.port);
    drag = { kind: 'link', from: from.key, start: px(GEO, from.depth, from.lane) };
  } else if (node) {
    e.preventDefault();
    ED.sel = { node: node.dataset.node };
    const n = ED.draft.nodes.find((x) => x.key === node.dataset.node);
    drag = { kind: 'move', key: n.key, geo: GEO, ox: p.x, oy: p.y, start: px(GEO, n.depth, n.lane), moved: false };
    drawRail();
    drawCanvas();
  } else if (edge) {
    ED.sel = { edge: edge.dataset.edge.split('|') };
    drawRail();
    drawCanvas();
  } else {
    ED.sel = null;
    drawRail();
    drawCanvas();
  }
});

document.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const p = svgPoint(e);
  if (drag.kind === 'link') {
    const [x, y] = drag.start;
    const t = $('#temp');
    t.style.display = '';
    t.setAttribute('d', `M${x + R} ${y} L${p.x} ${p.y}`);
  } else if (drag.kind === 'move' && ED.live) {
    if (!drag.moved && Math.hypot(p.x - drag.ox, p.y - drag.oy) < 4) return;
    drag.moved = true;
    drawCanvas({ key: drag.key, geo: drag.geo, x: drag.start[0] + p.x - drag.ox, y: drag.start[1] + p.y - drag.oy });
  }
});

document.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const d0 = drag;
  drag = null;
  if (d0.kind === 'link') {
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('[data-node]');
    const to = el?.dataset.node;
    if (to && to !== d0.from && !ED.draft.nodes.find((n) => n.key === d0.from).next?.includes(to)) {
      edit((d) => d.nodes.find((n) => n.key === d0.from).next.push(to));
    } else drawCanvas();
    return;
  }
  if (d0.kind === 'move' && d0.moved && ED.live) {
    const p = svgPoint(e);
    const c = cellAt(d0.geo, d0.start[0] + p.x - d0.ox, d0.start[1] + p.y - d0.oy);
    edit((d) => {
      const n = d.nodes.find((x) => x.key === d0.key);
      const other = d.nodes.find((x) => x !== n && x.depth === c.depth && x.lane === c.lane);
      // Dropping onto a taken cell swaps the two nodes.
      if (other) [other.depth, other.lane] = [n.depth, n.lane];
      n.depth = c.depth;
      n.lane = c.lane;
    });
  }
});

document.addEventListener('dblclick', (e) => {
  const svg = e.target.closest?.('#canvas');
  if (!svg || !ED?.live || e.target.closest('[data-node], [data-edge]')) return;
  const p = svgPoint(e);
  addNode(defaultNodeType(), cellAt(GEO, p.x, p.y));
});

document.addEventListener('mouseover', (e) => {
  const row = e.target.closest?.('tr[data-path]');
  const v = row ? Number(row.dataset.path) : null;
  if (!ED || ED.mode !== 'routes' || v === ED.hoverPath) return;
  ED.hoverPath = v;
  drawCanvas();
});

// ------------------------------------------------------------------ keys

document.addEventListener('keydown', (e) => {
  const typing = e.target.closest?.('input, textarea, select');
  if (e.key === 'Escape') closePop();
  if (typing) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault();
    stepHistory('undo', 'redo');
  } else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
    e.preventDefault();
    stepHistory('redo', 'undo');
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && ED?.mode === 'routes' && ED.sel) {
    e.preventDefault();
    removeSelection();
  }
});

// ------------------------------------------------------------------ lifecycle

$('#token-save').addEventListener('click', async () => {
  LS.set('token', $('#token-in').value.trim());
  await refreshPending();
  if (token() && !S.pendingError) toast('Connected');
  render();
});

window.addEventListener('hashchange', () => {
  flush();
  closePop();
  render();
});

window.addEventListener('beforeunload', (e) => {
  if (ED?.dirty || ED?.busy) {
    flush();
    e.preventDefault();
  }
});

// Pick up Claude's applied changes when coming back to the tab.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'hidden') return void flush();
  if (ED?.dirty || ED?.busy) return;
  await loadCatalogue().catch(() => {});
  await refreshPending({ quiet: true });
  render();
});

setInterval(() => {
  if (ED?.savedAt && !ED.dirty && !ED.busy) setSaved(`Saved ${ago(ED.savedAt)}`);
}, 30000);

(async function boot() {
  try {
    await loadCatalogue();
  } catch (e) {
    $('#main').innerHTML = `<div class="empty-main">Could not load the catalogue: ${esc(e.message)}</div>`;
    return;
  }
  render();
  await refreshPending({ quiet: true });
  render();
})();
