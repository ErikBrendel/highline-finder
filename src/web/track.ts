/**
 * How a slider's track positions map to values, so both thumbs and the fill agree on one mapping.
 *
 * The linear case is the identity: the range input carries the value itself, which is what every
 * slider here did before there was a reason not to.
 */
export interface Track {
  min: number
  max: number
  step: number
  toPos: (value: number) => number
  toValue: (pos: number) => number
}

export const linearTrack = (min: number, max: number, step: number): Track =>
  ({ min, max, step, toPos: (v) => v, toValue: (p) => p })

/**
 * Positions spaced evenly in ratio rather than in metres.
 *
 * Length runs from 50 m to 500 m, and on a linear track the whole of 50-100 m -- which is most of
 * what is actually walkable in Brandenburg -- is the first tenth of the bar. Picking a 60-90 m band
 * there meant two pixels a thumb. A decade of length gets the same room as any other decade this
 * way, so the resolution is proportional: about a per cent of the value at every point, which is
 * half a metre at the bottom and five at the top.
 *
 * The ends are pinned rather than computed, so the extremes of the track are exactly `min` and
 * `max` however the rounding lands. The caller depends on that to recognise a thumb parked at an
 * end and turn the filter off there.
 */
const LOG_STEPS = 240

export function logTrack(min: number, max: number, step: number): Track {
  // A track needs a positive floor and some width to have a ratio at all. Neither holds for an
  // empty or single-valued dataset, and a linear track of the same range is the honest fallback.
  if (min <= 0 || max <= min) return linearTrack(min, max, step)
  const span = Math.log(max / min)
  return {
    min: 0,
    max: LOG_STEPS,
    step: 1,
    toPos: (v) =>
      v <= min ? 0 : Math.min(LOG_STEPS, Math.round((LOG_STEPS * Math.log(v / min)) / span)),
    toValue: (p) =>
      p >= LOG_STEPS ? max : Math.max(min, Math.round(min * Math.exp((span * p) / LOG_STEPS))),
  }
}
