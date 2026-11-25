import { linearTrack, logTrack } from './track.js'

/**
 * One stretch of a slider's track, painted so the value is read against what it means.
 *
 * For a rig height the bands are the ground, the trunk, the crown and the air above them, and the
 * thumb's position among them says what reaching that height would take. Without them the control
 * is a number from nought to some ceiling, and every number on it looks equally sensible.
 */
export interface SliderBand {
  /** Upper bound, in the slider's own units. The band starts where the previous one ended. */
  to: number
  color: string
}

/**
 * `derived` marks a slider whose value is being computed rather than chosen, so it can move on its
 * own -- which looks like a glitch unless the readout says so. Touching it takes over.
 */
export function Slider({
  label, value, min, max, step, unit, format, derived, bands, onHelp, onChange,
}: {
  label: string; value: number; min: number; max: number; step: number; unit: string
  format?: (v: number) => string
  derived?: boolean
  /** Paint the track in stretches. See {@link SliderBand}. */
  bands?: SliderBand[]
  /** A "?" beside the label, for a value whose sensible range is not obvious. */
  onHelp?: () => void
  onChange: (v: number) => void
}) {
  const input = (
    <input
      type="range" min={min} max={max} step={step} value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  )
  const pct = (v: number) =>
    max > min ? Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100)) : 0
  return (
    <div className="filter">
      <label>
        <span>
          {label}
          {onHelp && (
            <button type="button" className="helpbtn" aria-label={`About ${label}`} onClick={onHelp}>?</button>
          )}
        </span>
        <span className={derived ? 'derived' : undefined}>
          {format ? format(value) : value}{unit}{derived ? ' auto' : ''}
        </span>
      </label>
      {bands ? (
        <div className="banded">
          <div className="bands">
            {bands.map((b, i) => {
              const from = i ? bands[i - 1]!.to : min
              // A band can be empty -- there is no trunk on a roof and no crown in a field -- and
              // an empty one simply takes no width rather than being a case to leave out.
              return (
                <span
                  key={b.color}
                  style={{
                    left: `${pct(from)}%`,
                    width: `${Math.max(0, pct(b.to) - pct(from))}%`,
                    background: b.color,
                  }}
                />
              )
            })}
          </div>
          {input}
        </div>
      ) : (
        input
      )}
    </div>
  )
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
