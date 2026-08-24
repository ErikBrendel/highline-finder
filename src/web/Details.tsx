import type { Candidate, ProfileSample } from '../shared/types.js'
import { PLANNED_ID, PLANNED_RIG_MAX, type PlannedLine, type RigHeights } from '../shared/plan.js'
import { ProfileChart } from './ProfileChart.js'
import { Slider } from './Slider.js'
import { spanGeometry, type LatLon } from './planPoints.js'

function scoreColor(score: number): string {
  if (score >= 70) return '#22c55e'
  if (score >= 60) return '#a3e635'
  if (score >= 50) return '#f59e0b'
  return '#64748b'
}

const DASH = '—'

interface Props {
  /**
   * Null while a freshly placed line is still waiting for elevation. The panel renders anyway, with
   * the figures blank and the chart a placeholder, so placing a line has an immediate result
   * instead of a warning banner somewhere else on the page.
   */
  c: Candidate | null
  /**
   * Null while it is still being built. A candidate from a dataset generated without stored
   * profiles has its figures immediately but its chart a moment later.
   */
  profile: ProfileSample[] | null
  planned: PlannedLine | null
  /** Endpoints to fall back on before there is a measurement to read them from. */
  at: { a: LatLon; b: LatLon } | null
  failed: boolean
  optimizing: boolean
  onOptimize: () => void
  rig: RigHeights | null
  onRig: (r: RigHeights | null) => void
  onClose: () => void
}

export function Details({
  c, profile, planned, at, failed, optimizing, onOptimize, rig, onRig, onClose,
}: Props) {
  // Only the planned line is ever shown without a measurement; found lines carry their own.
  const isPlanned = !c || c.id === PLANNED_ID
  const ends = c ? { a: c.a, b: c.b } : at
  // Length and bearing need no elevation, so they are shown before the measurement lands.
  const geom = c ?? (ends && spanGeometry(ends.a, ends.b))
  const stat = (fn: (c: Candidate) => string) => (c ? fn(c) : DASH)
  const pct = (v: number) => (v * 100).toFixed(0)

  const rows: { label: string; value: string; neg?: boolean }[] = [
    { label: 'Exposure (max air)', value: stat((c) => `${c.exposure.toFixed(1)} m`) },
    { label: 'Min terrain clearance', value: stat((c) => `${c.clearanceMin.toFixed(1)} m`) },
    {
      label: 'Min canopy clearance',
      value: stat((c) => `${c.canopyClearanceMin.toFixed(1)} m`),
      neg: !!c && c.canopyClearanceMin < 0,
    },
    {
      label: 'Canopy blocked',
      value: stat((c) => `${pct(c.canopyBlockedFraction)} %`),
      neg: !!c && c.canopyBlockedFraction > 0,
    },
    {
      label: 'Offlevel',
      value: stat((c) => `${c.offLevel.toFixed(1)} m · ${(c.offLevelRatio * 100).toFixed(1)} %`),
    },
    { label: 'Ground A / B', value: stat((c) => `${c.a.ground.toFixed(1)} / ${c.b.ground.toFixed(1)} m`) },
    // The planned line has sliders for these instead.
    ...(isPlanned
      ? []
      : [{ label: 'Rig height A / B', value: stat((c) => `+${c.a.aFrame.toFixed(1)} / +${c.b.aFrame.toFixed(1)} m`) }]),
    {
      label: 'Score: exp / len / canopy / margin / level',
      value: stat((c) => {
        const s = c.scoreParts
        return [s.exposure, s.length, s.canopy, s.margin, s.level].map(pct).join('/')
      }),
    },
  ]

  return (
    <div className="details">
      <div className="head">
        <strong style={{ color: isPlanned ? '#22c55e' : scoreColor(c!.score) }}>
          {isPlanned && 'Planned line · '}
          {c ? `Score ${c.score.toFixed(1)}` : failed ? 'no elevation data here' : 'measuring…'}
        </strong>
        {isPlanned && c && (
          <button
            className="optimize"
            data-running={optimizing}
            onClick={onOptimize}
            title={
              optimizing
                ? 'Stop'
                : 'Walk both anchors toward a better line, a metre at a time'
            }
          >
            {optimizing ? 'optimising…' : 'optimise'}
          </button>
        )}
        {geom && (
          <span className="sub">
            {geom.length.toFixed(0)} m &middot; bearing {geom.bearing.toFixed(0)}&deg;
            {c && (
              <>
                {' '}&middot; midspan sag {c.sag.toFixed(1)} m
                &middot; offlevel {c.offLevel.toFixed(1)} m (
                {(c.offLevelRatio * 100).toFixed(1)} %)
              </>
            )}
          </span>
        )}
        <button className="close" onClick={onClose}>close</button>
      </div>

      <div className="cols">
        <div className="chart">
          {c && profile ? (
            <ProfileChart c={c} profile={profile} />
          ) : (
            <div className="chartwait">
              {failed ? (
                <span>no elevation coverage for this spot</span>
              ) : (
                <>
                  <i className="spinner" />
                  <span>loading elevation&hellip;</span>
                </>
              )}
            </div>
          )}
          <div className="legend">
            <span><i style={{ background: 'var(--ground)' }} />terrain (DGM 1 m)</span>
            <span><i style={{ background: 'var(--canopy)' }} />canopy / structures (bDOM)</span>
            <span><i style={{ background: 'var(--line)' }} />line with sag</span>
          </div>
        </div>

        <dl className="stats">
          {rows.map((r) => (
            <div key={r.label} style={{ display: 'contents' }}>
              <dt>{r.label}</dt>
              <dd className={r.neg ? 'neg' : ''}>{r.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      {isPlanned && c && (
        <>
          <div className="rig">
            {(['a', 'b'] as const).map((which) => (
              <Slider
                key={which}
                label={`Rig ${which.toUpperCase()}`}
                value={c[which].aFrame}
                min={0}
                max={PLANNED_RIG_MAX}
                step={0.1}
                unit=" m"
                format={(v) => v.toFixed(1)}
                derived={rig === null}
                onChange={(v) =>
                  onRig(which === 'a' ? { a: v, b: c.b.aFrame } : { a: c.a.aFrame, b: v })
                }
              />
            ))}
            <button
              disabled={rig === null}
              onClick={() => onRig(null)}
              title="Rig as level and as high as the ground allows, like the search does"
            >
              auto
            </button>
          </div>
          {rig === null && (
            <div className="note" style={{ margin: '4px 0 0' }}>
              Rigged as level as the ground allows, then as high &mdash; the same choice the search
              makes, so both heights follow the terrain as you drag an anchor. Move a slider to set
              them yourself.
            </div>
          )}
        </>
      )}

      {isPlanned && planned && (
        planned.violations.length > 0 ? (
          <div className="violations">
            <b>Would not qualify as a candidate:</b>
            <ul>
              {planned.violations.map((v) => (
                <li key={v}>{v}</li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="note" style={{ margin: '8px 0 0' }}>
            Meets every hard constraint — the search would have accepted this line.
          </div>
        )
      )}

      {ends && (
        <div className="anchors">
          A{' '}
          <a href={`geo:${ends.a.lat},${ends.a.lon}`}>
            {ends.a.lat.toFixed(6)}, {ends.a.lon.toFixed(6)}
          </a>
          {'  —  B '}
          <a href={`geo:${ends.b.lat},${ends.b.lon}`}>
            {ends.b.lat.toFixed(6)}, {ends.b.lon.toFixed(6)}
          </a>
        </div>
      )}
    </div>
  )
}
