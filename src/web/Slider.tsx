/**
 * `derived` marks a slider whose value is being computed rather than chosen, so it can move on its
 * own -- which looks like a glitch unless the readout says so. Touching it takes over.
 */
export function Slider({
  label, value, min, max, step, unit, format, derived, onChange,
}: {
  label: string; value: number; min: number; max: number; step: number; unit: string
  format?: (v: number) => string
  derived?: boolean
  onChange: (v: number) => void
}) {
  return (
    <div className="filter">
      <label>
        <span>{label}</span>
        <span className={derived ? 'derived' : undefined}>
          {format ? format(value) : value}{unit}{derived ? ' auto' : ''}
        </span>
      </label>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  )
}

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

const linearTrack = (min: number, max: number, step: number): Track =>
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

/**
 * Two thumbs on one track, for a filter with a floor and a ceiling.
 *
 * Two overlaid range inputs rather than a custom control: the browser's own slider is already
 * keyboard-accessible and correctly sized for touch, and reimplementing that to get a second thumb
 * would be a step backwards. The overlay only works because the inputs ignore pointer events except
 * on their thumbs -- see `.range` in styles.css -- so a click on the track reaches whichever thumb
 * is not on top.
 *
 * Each thumb is clamped by the other, so dragging the floor past the ceiling pushes rather than
 * crosses. A crossed pair would read as an empty filter and look like a bug.
 */
export function RangeSlider({
  label, from, to, min, max, step, unit, log, onChange,
}: {
  label: string; from: number; to: number; min: number; max: number; step: number; unit: string
  /** Space the track by ratio instead of by value. `step` then applies only to the fallback. */
  log?: boolean
  onChange: (from: number, to: number) => void
}) {
  const track = log ? logTrack(min, max, step) : linearTrack(min, max, step)
  const width = track.max - track.min
  const pct = (v: number) => (width > 0 ? ((track.toPos(v) - track.min) / width) * 100 : 0)
  // Read back off the track rather than straight from the props, so the number beside the label is
  // the number the thumb is standing on -- a floor of 0 sits at the bottom of a log track and the
  // shortest line in the dataset is what that position means.
  const shown = (v: number) => track.toValue(track.toPos(v))
  const thumb = (value: number, pick: (v: number) => void) => (
    <input
      type="range" min={track.min} max={track.max} step={track.step} value={track.toPos(value)}
      onChange={(e) => pick(track.toValue(Number(e.target.value)))}
    />
  )
  return (
    <div className="filter">
      <label>
        <span>{label}</span>
        <span>
          {shown(from)}&ndash;{shown(to)}
          {unit}
        </span>
      </label>
      <div className="range">
        <div className="rangefill" style={{ left: `${pct(from)}%`, right: `${100 - pct(to)}%` }} />
        {thumb(from, (v) => onChange(Math.min(v, to), to))}
        {thumb(to, (v) => onChange(from, Math.max(v, from)))}
      </div>
    </div>
  )
}
