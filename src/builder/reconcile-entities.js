// What the Builder invented, held against who already exists.
//
// A model asked to furnish a story will happily produce "Marco Rossi" beside an
// existing Marco, or "Patrick's Penthouse" over the road from the Penthouse.
// This module classifies every generated entity against the story's inventory —
// deterministically, with no model asked anything — into three honest states:
//
//   reuse     it is an existing entity, said so plainly: an explicit ref, or an
//             exact name or alias of exactly one confirmed entity of that type.
//   possible  it may be an existing entity, and no machine should decide that:
//             the review asks, and Apply waits until someone answers.
//   new       nobody like it is in the inventory.
//
// Two things temper the matching. Different types are never the same thing,
// however alike the names. And a pair a person has already ruled distinct is
// not proposed again — "Marco Rossi is not Marco" is a decision, not a hint.

const STOP = new Set(['the', 'a', 'an', 'of', 'and', 's']);

/** A name as tokens, so "Patrick's Penthouse" and "penthouse" can be compared. */
export const nameTokens = (name) => String(name || '')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .split(/[^a-z0-9]+/)
  .filter((w) => w && !STOP.has(w));

/** The same name, allowing only for case, accents and punctuation. */
export const sameName = (a, b) => {
  const ta = nameTokens(a); const tb = nameTokens(b);
  return ta.length > 0 && ta.length === tb.length && ta.every((w, i) => w === tb[i]);
};

/** Whether one name sits whole inside the other: Marco inside Marco Rossi. */
const contains = (longer, shorter) => {
  const long = nameTokens(longer); const short = nameTokens(shorter);
  if (!short.length || short.length >= long.length) return false;
  for (let i = 0; i + short.length <= long.length; i++) {
    if (short.every((w, k) => long[i + k] === w)) return true;
  }
  return false;
};

const namesOf = (x) => [x.name, ...(x.aliases || [])].filter(Boolean);

/**
 * Classify one generated entity against the inventory.
 *
 * @param {object}   g          { draftId?, ref?, name, type }
 * @param {object[]} inventory  [{ id, ref?, name, type, aliases, status }]
 * @param {function} isSettled  (candidateId, generatedName) → true when a person
 *                              has already ruled that something answering to
 *                              this name is NOT that candidate.
 */
export function classifyGenerated(g, inventory, isSettled = () => false) {
  const sameType = inventory.filter((x) => x.type === g.type);

  // The model said which one it meant. That is reuse, not a guess — but only
  // within a type: pointing a place at a person keeps them apart.
  if (g.ref) {
    const named = inventory.find((x) => x.ref === g.ref || x.id === g.ref);
    if (named && named.type === g.type) {
      return { decision: 'reuse', entity: named, candidates: [], reason: 'it named this entity itself' };
    }
    if (named) {
      return { decision: 'new', entity: null, candidates: [], reason: `it pointed at ${named.name}, which is a ${named.type}, not a ${g.type}` };
    }
  }

  // Exactly this name, this type.
  const exact = sameType.filter((x) => namesOf(x).some((n) => sameName(n, g.name)));
  if (exact.length === 1 && exact[0].status !== 'unconfirmed') {
    return { decision: 'reuse', entity: exact[0], candidates: [], reason: `the name is exactly ${exact[0].name}` };
  }
  if (exact.length >= 1) {
    // Several answer to the name, or the one that does is itself only a guess:
    // a person chooses, nothing merges on its own.
    return {
      decision: 'possible',
      entity: null,
      candidates: exact.map((x) => ({
        id: x.id,
        name: x.name,
        why: x.status === 'unconfirmed'
          ? 'They have the same name, and nobody has confirmed that one yet.'
          : 'They have the same name.',
      })),
      reason: exact.length > 1 ? 'more than one entity answers to this name' : 'the matching entity is unconfirmed',
    };
  }

  // One name sitting whole inside the other — Marco in Marco Rossi, Penthouse
  // in Patrick's Penthouse — is worth asking about, never worth assuming. A
  // pair already ruled separate is not asked about again.
  const near = sameType
    .filter((x) => namesOf(x).some((n) => contains(g.name, n) || contains(n, g.name)))
    .filter((x) => !isSettled(x.id, g.name));
  if (near.length) {
    return {
      decision: 'possible',
      entity: null,
      // Said as what it is: one name sits inside the other. They are not the
      // same words, and the card must not claim they are.
      candidates: near.map((x) => ({
        id: x.id,
        name: x.name,
        why: contains(g.name, x.name) || namesOf(x).some((n) => contains(g.name, n))
          ? `“${x.name}” is part of the longer name “${g.name}”.`
          : `“${g.name}” is part of the longer name “${x.name}”.`,
      })),
      reason: 'it may be someone already here under a fuller or shorter name',
    };
  }

  return { decision: 'new', entity: null, candidates: [], reason: 'nobody in this material is called anything like it' };
}

/**
 * Classify everything the Builder generated, honouring what the reviewer has
 * already answered.
 *
 * Deterministic and offline: the inventory came with the draft, the settled
 * pairs come from decisions already made, and no provider is called. Anything
 * still 'possible' with no answer counts as unresolved, and Apply waits for it.
 *
 * @param {object[]} generated  [{ draftId, ref?, name, type }]
 * @param {object[]} inventory  as classifyGenerated
 * @param {object}   [o]
 * @param {function} [o.isSettled]
 * @param {object}   [o.decisions]  draftId → { use: 'existing', id } | { use: 'new' }
 * @returns {{ items: object[], unresolved: number }}
 */
export function reconcileGenerated(generated, inventory, { isSettled = () => false, decisions = {} } = {}) {
  const items = (generated || []).map((g) => {
    const verdict = classifyGenerated(g, inventory, isSettled);
    const decided = decisions[g.draftId] || null;
    let resolution = null;
    let entity = verdict.entity;
    if (verdict.decision !== 'possible') resolution = verdict.decision;
    else if (decided?.use === 'new') resolution = 'new';
    else if (decided?.use === 'existing' && verdict.candidates.some((c) => c.id === decided.id)) {
      resolution = 'reuse';
      entity = inventory.find((x) => x.id === decided.id) || null;
    }
    return { draftId: g.draftId ?? null, name: g.name, type: g.type, ...verdict, entity, resolution };
  });
  return { items, unresolved: items.filter((x) => x.resolution === null).length };
}
