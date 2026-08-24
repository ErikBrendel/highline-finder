import type { Candidate, ProfileSample } from '../shared/types.js'

/**
 * Side elevation of one candidate: terrain, canopy band, and the sagging line.
 *
 * Marker positions come from the resampled profile, but their labels come from the candidate's
 * stored metrics, which were measured on a finer step. Labelling from the profile instead would
 * let the chart disagree with the numbers in the panel beside it.
 *
 * The point of this chart is trustworthiness -- a ranked list of scores is unfalsifiable, but a
 * profile makes it obvious at a glance whether a line really crosses a gap or merely clips a
 * slope, and where it runs into canopy. Hand-drawn SVG rather than a chart library because the
 * whole thing is four paths and the axes need domain-specific annotation anyway.
 */

const W = 900
const H = 200
const PAD = { top: 12, right: 46, bottom: 22, left: 44 }

export function ProfileChart({ c, profile }: { c: Candidate; profile: ProfileSample[] }) {
  const p = profile
  const lo = Math.min(...p.map((s) => s.ground)) - 2
  const hi = Math.max(...p.map((s) => Math.max(s.surface, s.line))) + 3
  const iw = W - PAD.left - PAD.right
  const ih = H - PAD.top - PAD.bottom

  const x = (d: number) => PAD.left + (d / c.length) * iw
  const y = (v: number) => PAD.top + ih - ((v - lo) / (hi - lo)) * ih

  const path = (key: 'ground' | 'surface' | 'line') =>
    p.map((s, i) => `${i ? 'L' : 'M'}${x(s.d).toFixed(1)},${y(s[key]).toFixed(1)}`).join('')

  const groundFill = `${path('ground')}L${x(c.length)},${PAD.top + ih}L${PAD.left},${PAD.top + ih}Z`
  const canopyFill = `${path('surface')}${p
    .slice()
    .reverse()
    .map((s) => `L${x(s.d).toFixed(1)},${y(s.ground).toFixed(1)}`)
    .join('')}Z`

  // Mark the two numbers the score actually turns on.
  const deepest = p.reduce((a, s) => (s.line - s.ground > a.line - a.ground ? s : a), p[0]!)
  const inner = p.filter((s) => s.d >= 10 && s.d <= c.length - 10)
  const tightest = inner.length
    ? inner.reduce((a, s) => (s.line - s.ground < a.line - a.ground ? s : a), inner[0]!)
    : deepest

  const ticks = [lo, (lo + hi) / 2, hi].map((v) => Math.round(v))

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="elevation profile">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="#2a2f3a" strokeWidth="1" />
          <text x={PAD.left - 6} y={y(t) + 4} fill="#8b93a3" fontSize="10" textAnchor="end">
            {t}
          </text>
        </g>
      ))}

      <path d={canopyFill} fill="var(--canopy)" opacity="0.5" />
      <path d={groundFill} fill="var(--ground)" opacity="0.9" />
      <path d={path('ground')} stroke="#a08a72" strokeWidth="1.25" fill="none" />

      <line
        x1={x(deepest.d)} x2={x(deepest.d)} y1={y(deepest.line)} y2={y(deepest.ground)}
        stroke="#38bdf8" strokeWidth="1" strokeDasharray="3 2"
      />
      <text x={x(deepest.d) + 5} y={(y(deepest.line) + y(deepest.ground)) / 2} fill="#38bdf8" fontSize="10">
        {c.exposure.toFixed(1)} m air
      </text>

      <line
        x1={x(tightest.d)} x2={x(tightest.d)} y1={y(tightest.line)} y2={y(tightest.ground)}
        stroke="#fbbf24" strokeWidth="1" strokeDasharray="3 2"
      />
      <text x={x(tightest.d) + 5} y={y(tightest.ground) - 4} fill="#fbbf24" fontSize="10">
        {c.clearanceMin.toFixed(1)} m
      </text>

      <path d={path('line')} stroke="var(--line)" strokeWidth="2" fill="none" />
      <circle cx={x(0)} cy={y(p[0]!.line)} r="3.5" fill="#f43f5e" />
      <circle cx={x(c.length)} cy={y(p[p.length - 1]!.line)} r="3.5" fill="#f43f5e" />

      <text x={PAD.left} y={H - 6} fill="#8b93a3" fontSize="10">A</text>
      <text x={W - PAD.right} y={H - 6} fill="#8b93a3" fontSize="10" textAnchor="end">
        B &middot; {c.length.toFixed(0)} m
      </text>
    </svg>
  )
}
