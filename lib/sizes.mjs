/**
 * The four sizes, and the model each one is mapped to.
 *
 * ## Where this list came from
 *
 * The user's four sizes are the labels Jev picks from. Each one is mapped
 * to a model that is actually installed, verified with `pi --list-models`:
 *
 *   $ pi --list-models
 *   provider  model                         context  max-out  thinking  images
 *   deepseek  deepseek-flash                1M       384K     yes       yes
 *   deepseek  deepseek-v4-flash             1M       384K     yes       no
 *   deepseek  deepseek-v4-flash-vision-exp  1M       384K     yes       yes
 *   deepseek  deepseek-v4-pro               1M       384K     yes       no
 *
 * ## How the order was decided
 *
 * Every deepseek model has the same context window (1M) and the same max
 * output (384K), so neither of those separates them. The order below is based
 * on published per-million-token price — the only quantitative difference pi
 * exposes — plus the model generation in the name.
 *
 * Prices are read from pi's own two model catalogues on this machine:
 * the bundled catalogue and the fetched store that overrides it.
 *
 *   model                          input $/Mtok   output $/Mtok   input types
 *   deepseek-v4-flash                    0.14           0.28      text
 *   deepseek-v4-flash-vision-exp         0.14           0.28      text, image
 *   deepseek-flash (V4.1 Flash)          0.30           1.20      text, image
 *   deepseek-v4-pro                      1.32 *         3.96 *    text
 *
 *   * deepseek-v4-pro is 0.435 / 0.87 in the bundled catalogue and
 *     1.32 / 3.96 in the fetched store (~/.pi/agent/models-store.json).
 *     The ranking is the same either way. The store price is quoted above
 *     because the store is what pi merges last.
 *
 * ## Honest caveat, as instructed
 *
 * `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are the SAME price,
 * the SAME generation and the SAME context. They are not two capability
 * tiers. The only difference pi records is that the vision model accepts
 * images. So `tiny` and `everyday` are effectively one tier for text work;
 * this is stated rather than dressed up as a distinction. `everyday` gets the
 * vision model because everyday messages are the ones that arrive with a
 * screenshot attached.
 *
 * Capability is inferred from price and generation, NOT measured. No model
 * here has been benchmarked against another by this project.
 */

export const SIZES = ['tiny', 'everyday', 'large', 'hardest'];

/** The escape hatch every Choice question needs: Jev does not abstain on its own. */
export const CANNOT_TELL = 'cannot_tell';

/**
 * What each size means, in the user's own words. These strings are sent to
 * Jev as the Choice criteria, so they are the whole definition of the size.
 */
export const SIZE_CRITERIA = {
  tiny: 'A lookup, a rename, a one-line answer. Small, self-contained, and finished in a single short reply.',
  everyday:
    'A normal email, a post, or a short document. Needs some writing or light judgement, but no research and no multi-step work.',
  large:
    'A multi-step build, a piece of research, or a full report. Needs planning, several steps, or pulling facts together.',
  hardest:
    'Strategy, or anything where a wrong call is expensive. High stakes, ambiguous, or a decision the captain will act on.',
  [CANNOT_TELL]: 'The message does not contain enough to choose between the sizes above.',
};

/**
 * size -> model, smallest to biggest.
 *
 * `acceptsImages` mirrors pi's `input` field for each model. The router will
 * not switch to a model that cannot accept an attached image; it falls back
 * instead of failing the message.
 */
export const SIZE_MODEL = {
  tiny: { provider: 'deepseek', id: 'deepseek-v4-flash', acceptsImages: false, tier: 1 },
  everyday: { provider: 'deepseek', id: 'deepseek-v4-flash-vision-exp', acceptsImages: true, tier: 1 },
  large: { provider: 'deepseek', id: 'deepseek-flash', acceptsImages: true, tier: 2 },
  hardest: { provider: 'deepseek', id: 'deepseek-v4-pro', acceptsImages: false, tier: 3 },
};

/** Shown by `status` so the mapping is visible without reading the source. */
export const RANKING_BASIS =
  'ordered by published input price per Mtok (0.14 / 0.14 / 0.30 / 1.32), ' +
  'quoted from pi\'s bundled catalogue plus ~/.pi/agent/models-store.json; ' +
  'context window (1M) and max output (384K) are identical for all four, so price and ' +
  'model generation are the only separators available. Capability itself is not benchmarked.';

export function isSize(value) {
  return typeof value === 'string' && SIZES.includes(value);
}

export function modelFor(size) {
  return SIZE_MODEL[size] ?? null;
}

/** "provider/model" — the form pi's model resolver accepts. */
export function modelRef(size) {
  const m = SIZE_MODEL[size];
  return m ? `${m.provider}/${m.id}` : null;
}

export function allModelRefs() {
  return SIZES.map((s) => modelRef(s));
}
