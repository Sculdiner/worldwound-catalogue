/*
 * Notes: the user's free ideas for new cards, ships and enemies, typed on the
 * phone. They live in `notes.json` on the site repo's `edits` branch (see
 * `fetchNotes` / `commitNotes` in store.js), never in the change queue, so the
 * catalogue sync never treats them as game changes. Each note is
 * `{ id, text, at, editedAt? }` in the `cards`, `ships` or `enemies` list.
 *
 * Every note is edited in place: typing saves about 0.7 s later, leaving the
 * box saves at once, and a note emptied and left is removed.
 */

import { LS, NOTE_LISTS, ago, commitNotes, emptyNotes, esc, fetchNotes, token, uid } from './store.js';

const LABEL = {
  cards: { tab: 'Card ideas', add: 'New card idea', one: 'card idea', ph: 'A card idea: name, cost, what it does…' },
  ships: { tab: 'Ship ideas', add: 'New ship idea', one: 'ship idea', ph: 'A ship idea: its role, Hull, passive, starting deck…' },
  enemies: { tab: 'Enemy ideas', add: 'New enemy idea', one: 'enemy idea', ph: 'An enemy idea: its role, Hull, moves, abilities…' },
};

const N = {
  data: emptyNotes(),
  loaded: false,
  loading: false,
  error: null,
  list: NOTE_LISTS.includes(LS.get('notesList', NOTE_LISTS[0])) ? LS.get('notesList', NOTE_LISTS[0]) : NOTE_LISTS[0],
  /** Notes being typed: id → { list, text, at, isNew, timer, busy, again }. */
  drafts: new Map(),
};

/** What the page lends this module: toast, ask, render, autosize, tokenForm. */
let app = {};
export function initNotes(deps) {
  app = deps;
}

export async function loadNotes({ quiet = true } = {}) {
  if (!token() || N.loading) return;
  N.loading = true;
  try {
    N.data = (await fetchNotes()).data;
    N.loaded = true;
    N.error = null;
  } catch (e) {
    N.error = e.message;
    if (!quiet) app.toast?.(e.message, true);
  }
  N.loading = false;
}

const $ = (sel) => document.querySelector(sel);
const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

function dateLine(n, d) {
  if (d?.isNew && !N.data[d.list].some((x) => x.id === n.id)) return 'Not saved yet';
  return `Added ${esc(day(n.at))}${n.editedAt ? ` · edited ${esc(ago(n.editedAt))}` : ''}`;
}

/** A list as shown: saved notes with what is being typed laid over, unsaved new ones too; newest first. */
function shown(list) {
  const saved = N.data[list].map((n) => {
    const d = N.drafts.get(n.id);
    return d ? { ...n, text: d.text } : n;
  });
  const fresh = [...N.drafts.entries()]
    .filter(([id, d]) => d.list === list && !N.data[list].some((n) => n.id === id))
    .map(([id, d]) => ({ id, text: d.text, at: d.at }));
  return [...fresh, ...saved].sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
}

const count = (list) => shown(list).filter((n) => n.text.trim()).length;

function card(n, list) {
  return `<div class="idea" data-idea="${esc(n.id)}">
    <textarea class="inl idea-text" data-idea-text="${esc(n.id)}" data-idea-of="${list}" rows="3" placeholder="${esc(LABEL[list].ph)}" aria-label="${esc(LABEL[list].one)}">${esc(n.text)}</textarea>
    <div class="idea-foot"><span data-idea-date="${esc(n.id)}">${dateLine(n, N.drafts.get(n.id))}</span>
      <button class="idea-del" data-idea-del="${esc(n.id)}" data-idea-of="${list}">Delete</button></div>
  </div>`;
}

export function notesView() {
  if (!token()) return app.tokenForm('This browser has no GitHub token yet. Your notes are saved through GitHub, so paste one to see and write them.');
  if (!N.loaded) {
    if (!N.loading) loadNotes({ quiet: false }).then(() => app.render?.());
    return N.error ? `<div class="notice err">${esc(N.error)}</div>` : '<div class="empty">Loading your notes…</div>';
  }
  const list = N.list;
  const notes = shown(list);
  return `${N.error ? `<div class="notice err">${esc(N.error)}</div>` : ''}
    <div class="chips notes-tabs">${NOTE_LISTS.map(
      (k) => `<button class="chip ${k === list ? 'on' : ''}" data-idea-list="${k}">${LABEL[k].tab} <span class="n">${count(k)}</span></button>`,
    ).join('')}</div>
    <p class="notes-intro">Ideas to think about later. Notes never change the game and are not sent to Claude as changes; ask Claude to read them when you want.</p>
    <button class="btn notes-add" data-idea-add="${list}">+ ${LABEL[list].add}</button>
    <div class="idea-list">${notes.length ? notes.map((n) => card(n, list)).join('') : `<div class="empty">No ${LABEL[list].tab.toLowerCase()} yet.</div>`}</div>`;
}

/** Redraw the page, keeping the caret in the note being typed. */
function redraw() {
  const a = document.activeElement;
  const id = a?.dataset?.ideaText;
  const sel = id ? [a.selectionStart, a.selectionEnd] : null;
  const y = window.scrollY;
  app.render?.();
  window.scrollTo(0, y);
  if (!id) return;
  const ta = $(`[data-idea-text="${CSS.escape(id)}"]`);
  if (!ta) return;
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(...sel);
}

/** Save one note being typed. Saves never overlap; text typed mid-save is sent right after. */
async function saveNote(id) {
  const d = N.drafts.get(id);
  if (!d) return;
  clearTimeout(d.timer);
  if (d.busy) {
    d.again = true;
    return;
  }
  const text = d.text.trim();
  if (!text) return; // an emptied note is removed when its box is left
  d.busy = true;
  const isNew = !N.data[d.list].some((n) => n.id === id);
  const now = new Date().toISOString();
  const saved = await commitNotes((data) => {
    const arr = (data[d.list] ??= []);
    const n = arr.find((x) => x.id === id);
    if (!n) arr.push({ id, text, at: d.at });
    else if (n.text !== text) {
      n.text = text;
      n.editedAt = now;
    }
  }, `${isNew ? 'Add' : 'Edit'} a ${LABEL[d.list].one}`);
  d.busy = false;
  if (saved) N.data = saved;
  if (d.again) {
    d.again = false;
    return saveNote(id);
  }
  if (saved && d.text.trim() === text && N.drafts.get(id) === d) {
    N.drafts.delete(id);
    app.toast?.(isNew ? 'Note added' : 'Saved');
  }
  for (const k of NOTE_LISTS) {
    const c = $(`[data-idea-list="${k}"] .n`);
    if (c) c.textContent = count(k);
  }
  const el = $(`[data-idea-date="${CSS.escape(id)}"]`);
  const n = N.data[d.list].find((x) => x.id === id);
  if (el && n) el.innerHTML = dateLine(n, N.drafts.get(id));
}

/** Save every note still being typed (leaving the page, or the phone hiding the tab). */
export function flushNotes() {
  for (const [id, d] of N.drafts) if (d.text.trim() && !d.busy) saveNote(id);
}

async function removeNote(id, list, { quiet = false } = {}) {
  const d = N.drafts.get(id);
  if (d) clearTimeout(d.timer);
  N.drafts.delete(id);
  if (!N.data[list].some((n) => n.id === id)) return redraw(); // never saved
  const saved = await commitNotes((data) => {
    data[list] = (data[list] ?? []).filter((n) => n.id !== id);
  }, `Delete a ${LABEL[list].one}`);
  if (saved) {
    N.data = saved;
    app.toast?.(quiet ? 'Empty note removed' : 'Note deleted');
  }
  redraw();
}

document.addEventListener('click', async (e) => {
  const tab = e.target.closest('[data-idea-list]');
  if (tab) {
    flushNotes();
    N.list = tab.dataset.ideaList;
    LS.set('notesList', N.list);
    return redraw();
  }
  const add = e.target.closest('[data-idea-add]');
  if (add) {
    const id = uid();
    N.drafts.set(id, { list: add.dataset.ideaAdd, text: '', at: new Date().toISOString() });
    redraw();
    const ta = $(`[data-idea-text="${CSS.escape(id)}"]`);
    ta?.focus();
    ta?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }
  const del = e.target.closest('[data-idea-del]');
  if (del) {
    const id = del.dataset.ideaDel;
    const list = del.dataset.ideaOf;
    const text = (N.drafts.get(id)?.text ?? N.data[list].find((n) => n.id === id)?.text ?? '').trim();
    if (text && !(await app.ask({ title: 'Delete this note?', body: text.length > 140 ? `${text.slice(0, 140)}…` : text, ok: 'Delete', danger: true }))) return;
    return removeNote(id, list);
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  const id = t.dataset?.ideaText;
  if (!id) return;
  const list = t.dataset.ideaOf;
  let d = N.drafts.get(id);
  if (!d) {
    d = { list, text: t.value, at: N.data[list].find((n) => n.id === id)?.at ?? new Date().toISOString() };
    N.drafts.set(id, d);
  }
  d.text = t.value;
  clearTimeout(d.timer);
  d.timer = setTimeout(() => saveNote(id), 700);
});

document.addEventListener('focusout', (e) => {
  const t = e.target;
  const id = t.dataset?.ideaText;
  if (!id) return;
  const d = N.drafts.get(id);
  if (!d) return;
  if (d.text.trim()) return void saveNote(id);
  // Left empty: a new note is simply dropped, a saved one removed.
  setTimeout(() => {
    if (N.drafts.get(id) === d && !d.text.trim()) removeNote(id, d.list, { quiet: true });
  }, 150);
});
