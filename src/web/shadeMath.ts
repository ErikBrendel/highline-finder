/**
 * The pieces of arithmetic every basemap composite is built from.
 *
 * In their own module because both of the modules that need them would otherwise have to import
 * each other: a stack of surveys has to rebase each one's relief, and a shaded basemap is a stack
 * multiplied into another stack.
 */

/**
 * Grey the shaded-relief product renders flat ground at, as a channel value.
 *
 * Brandenburg's, because that is the survey the dataset is in and the one every other is read
 * against. Measured rather than taken from the documentation, which says #c4c4c4 and so would have
 * put this at 196: over flat ground the service actually returns 193 at a metre a pixel and 195
 * from five metres out, the drift being its own downsampling. 195 is what it renders at the
 * resolutions relief is looked at.
 *
 * Fixed rather than measured per tile: a per-tile baseline would make the same hillside lighter or
 * darker depending on what else happened to be in frame, which is the artefact this removes.
 */
export const SHADE_BASELINE = 195

/**
 * Rebases one survey's shaded relief onto the grey every other one is read against.
 *
 * Each survey picks its own value for flat ground: Brandenburg renders it at #c4c4c4, Saxony at
 * #dddddd. Left alone, the two are visibly different maps of the same kind of hillside -- Saxony
 * comes out pale in a plain hillshade view -- and worse, the multiply that shades a basemap divides
 * by a fixed baseline, so a survey rendering flat ground brighter than that *brightens* everything
 * it covers. A state border becomes a step in exposure across an unbroken field.
 *
 * Piecewise linear about the baseline rather than a plain scale, because a scale would map white to
 * something short of white and quietly flatten the contrast of every steep slope. This pins three
 * points -- black stays black, white stays white, flat ground lands on the common grey -- and
 * stretches each half between them.
 *
 * `contrast` is the second half of the job, and the rebase alone is not enough without it: agreeing
 * about flat ground says nothing about how far from it a given hillside is drawn. Saxony renders
 * roughly twice Brandenburg's relief for the same slope and Saxony-Anhalt about a third of it, so
 * three maps that now share a grey still do not look like one map. Applied after the rebase and
 * about the baseline, so it changes how far a slope departs from flat without moving flat itself.
 * `Uint8ClampedArray` handles the ends; at the fitted factors that costs Saxony-Anhalt 0.14 % of its
 * pixels and the others none.
 *
 * Alpha is untouched: what a survey has no data for stays transparent, which is what lets the next
 * one show through.
 */
export function normaliseShade(
  data: Uint8ClampedArray,
  from: number,
  to: number,
  contrast = 1,
): void {
  if (from === to && contrast === 1) return
  const below = to / from
  const above = (255 - to) / (255 - from)
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = data[i + c]!
      const rebased = v <= from ? v * below : to + (v - from) * above
      data[i + c] = to + (rebased - to) * contrast
    }
  }
}

/**
 * Full alpha wherever a survey has anything, none where it has not.
 *
 * Saxony-Anhalt renders its relief at 80 % alpha -- the layer declares `opaque="0"` and every pixel
 * it holds comes back at 205. Drawn as it arrives, four fifths of its hillsides and one fifth of
 * the flat grey underneath would be mixed together, which flattens its relief by a fifth and is not
 * what any of the other surveys do. A stack shows the topmost layer that has data for a tile; a
 * survey rendering itself semi-transparent is not asking for something different, it is a property
 * of the picture rather than a statement about the ground.
 *
 * The threshold is deliberate rather than a scale. This service's alpha is binary -- 205 where it
 * has ground and 0 where it has none, with nothing in between even on a tile straddling the state
 * border -- so anything partial is an edge and belongs on the side it is nearer.
 */
export function makeOpaque(data: Uint8ClampedArray): void {
  for (let i = 3; i < data.length; i += 4) data[i] = data[i]! >= 128 ? 255 : 0
}

/**
 * Multiplies `shade` into `base` in place, relative to the flat-ground grey.
 *
 * Exported for its test, which is the only way to check the arithmetic: everything else here is
 * fetching and encoding.
 */
export function applyShading(base: Uint8ClampedArray, shade: Uint8ClampedArray): void {
  for (let i = 0; i < base.length; i += 4) {
    const factor = shade[i]! / SHADE_BASELINE
    base[i] = base[i]! * factor
    base[i + 1] = base[i + 1]! * factor
    base[i + 2] = base[i + 2]! * factor
  }
}
