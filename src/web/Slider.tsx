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
