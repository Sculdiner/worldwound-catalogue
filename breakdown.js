// The archetype breakdown: per card group, per archetype, per rarity.
// Shared by the phone catalogue (#/archetypes) and the PC Studio (#/archetypes).
// Reads the cards as proposed (queued edits included) and counts only cards
// that can turn up in a run: switched-off cards, cards carrying one of
// `vocab.poolExcludedFlags` (e.g. tokens) and cards of a group marked
// `pool: false` (e.g. a ship's own starting cards) are left out.
//
// Groups, archetypes and rarities all come from the export (`catalogue.json`:
// `groups`, `archetypes`, `vocab.cardRarities`); cards with no group form one
// column of their own.

import { S, items, isOff, esc, group, groupName, vocab, cap } from './store.js';

const inPools = (c) => {
  const excluded = S.cat?.vocab?.poolExcludedFlags ?? [];
  return !isOff(c) && !(c.flags ?? []).some((f) => excluded.includes(f)) && group(c.group)?.pool !== false;
};

function archetypeList() {
  return [...(S.cat.archetypes ?? []).map((a) => ({ id: a.id, name: a.name, color: a.color, groups: a.groups ?? {} })), { id: 'untagged', name: 'Untagged', groups: {} }];
}

const tagsOf = (c) => ((c.archetypes ?? []).length ? c.archetypes : ['untagged']);
const dot = (a) => `<span class="bd-dot" ${a.color ? `style="color:${esc(a.color)}"` : ''}></span>`;

/**
 * The whole page. `cardHref(id)` links a name to the card: its own page on
 * the phone, the phone catalogue in a new tab from the Studio.
 */
export function breakdownHtml({ cardHref, newTab = false }) {
  const cards = items('cards').map((x) => x.data).filter(inPools);
  const rarities = vocab().cardRarities;
  const label = vocab().groupLabel;
  if (!cards.length)
    return `<div class="bd"><section class="bd-card"><h2>Archetypes</h2><p class="bd-note">No cards yet. Once cards exist and carry archetype tags, this page counts them per ${esc(label.toLowerCase())}, archetype and rarity.</p></section></div>`;
  const groupIds = [...(S.cat.groups ?? []).map((g) => g.id), '_none'].filter((g) => cards.some((c) => (c.group ?? '_none') === g));
  const gName = (g) => (g === '_none' ? `No ${label.toLowerCase()}` : groupName(g));
  const arcs = archetypeList();
  const of = (g) => cards.filter((c) => (c.group ?? '_none') === g);
  const link = (c) => `<a class="bd-item" data-rarity="${esc(c.rarity ?? '')}" href="${esc(cardHref(c.id))}"${newTab ? ' target="_blank" rel="noopener"' : ''}>${esc(c.name)}</a>`;

  // Every group together: archetype x group, with its share of the pool.
  const poolSize = cards.length;
  const summaryRows = arcs
    .map((a) => {
      const total = cards.filter((c) => tagsOf(c).includes(a.id)).length;
      if (!total) return '';
      const cells = groupIds
        .map((g) => {
          const n = of(g).filter((c) => tagsOf(c).includes(a.id)).length;
          const size = a.groups[g] ? `<small class="bd-size">${esc(a.groups[g])}</small>` : '';
          return `<td>${n || '–'} ${size}</td>`;
        })
        .join('');
      return `<tr class="${a.id === 'untagged' ? 'bd-muted' : ''}"><th>${dot(a)}${esc(a.name)}</th>${cells}<td><b>${total}</b></td><td>${Math.round((100 * total) / Math.max(1, poolSize))}%</td></tr>`;
    })
    .join('');
  const rarityTotals = rarities.map((r) => `<td>${groupIds.map((g) => of(g).filter((c) => c.rarity === r).length).join(' + ')}</td>`).join('');

  const summary = `<section class="bd-card">
    <h2>All cards <small>${poolSize} in the pool</small></h2>
    <div class="bd-scroll"><table class="bd-table">
      <thead><tr><th>Archetype</th>${groupIds.map((g) => `<th>${esc(gName(g))}</th>`).join('')}<th>Total</th><th>Share</th></tr></thead>
      <tbody>${summaryRows}</tbody>
    </table></div>
    ${rarities.length ? `<div class="bd-scroll"><table class="bd-table bd-rar">
      <thead><tr><th>Rarity</th>${rarities.map((r) => `<th data-rarity="${esc(r)}">${esc(cap(r))}</th>`).join('')}</tr></thead>
      <tbody><tr><th>${groupIds.map((g) => esc(gName(g))).join(' + ')}</th>${rarityTotals}</tr></tbody>
    </table></div>` : ''}
    <p class="bd-note">A card tagged with two archetypes counts in both. Switched-off cards${(S.cat.groups ?? []).some((g) => g.pool === false) ? ' and starting cards' : ''} are left out.</p>
  </section>`;

  const groupCol = (g) => {
    const list = of(g);
    const counts = rarities.map((r) => `<span class="bd-count" data-rarity="${esc(r)}">${esc(cap(r))} <b>${list.filter((c) => c.rarity === r).length}</b></span>`).join('');
    const rowRarities = [...rarities, ...[...new Set(list.map((c) => c.rarity ?? ''))].filter((r) => !rarities.includes(r))];
    const blocks = arcs
      .map((a) => {
        const mine = list.filter((c) => tagsOf(c).includes(a.id));
        if (!mine.length) return '';
        const size = a.groups[g] ? `<small class="bd-size">${esc(a.groups[g])}</small>` : a.id === 'untagged' ? '' : '<small class="bd-size bridge">bridge</small>';
        const rows = rowRarities
          .map((r) => {
            const xs = mine.filter((c) => (c.rarity ?? '') === r).sort((x, y) => String(x.name).localeCompare(String(y.name)));
            if (!xs.length && !rarities.includes(r)) return '';
            return `<div class="bd-row"><span class="bd-r" data-rarity="${esc(r)}">${esc(cap(r) || 'No rarity')} <b>${xs.length}</b></span><span class="bd-items">${xs.map(link).join('') || '<span class="bd-none">—</span>'}</span></div>`;
          })
          .join('');
        return `<div class="bd-arch ${a.id === 'untagged' ? 'bd-muted' : ''}"><h3>${dot(a)}${esc(a.name)} <b>${mine.length}</b> ${size}</h3>${rows}</div>`;
      })
      .join('');
    return `<section class="bd-card bd-group"><h2>${esc(gName(g))} <small>${list.length} cards</small></h2><div class="bd-counts">${counts}</div>${blocks}</section>`;
  };

  return `<div class="bd">${summary}<div class="bd-groups">${groupIds.map(groupCol).join('')}</div></div>`;
}
