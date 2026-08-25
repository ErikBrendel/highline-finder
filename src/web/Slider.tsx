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
  label, from, to, min, max, step, unit, onChange,
}: {
  label: string; from: number; to: number; min: number; max: number; step: number; unit: string
  onChange: (from: number, to: number) => void
}) {
  const pct = (v: number) => (max > min ? ((v - min) / (max - min)) * 100 : 0)
  return (
    <div className="filter">
      <label>
        <span>{label}</span>
        <span>
          {from}&ndash;{to}
          {unit}
        </span>
      </label>
      <div className="range">
        <div className="rangefill" style={{ left: `${pct(from)}%`, right: `${100 - pct(to)}%` }} />
        <input
          type="range" min={min} max={max} step={step} value={from}
          onChange={(e) => onChange(Math.min(Number(e.target.value), to), to)}
        />
        <input
          type="range" min={min} max={max} step={step} value={to}
          onChange={(e) => onChange(from, Math.max(Number(e.target.value), from))}
        />
      </div>
    </div>
  )
}
