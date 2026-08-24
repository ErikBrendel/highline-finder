import { useEffect, useState } from 'react'
import type { Candidate, ProfileSample } from '../shared/types.js'
import { COVER_BUILDING, type Cover, coverRuns } from './landcover.js'
import { emitHoverPoint } from './hoverMarker.js'
import { toWgs84 } from '../shared/geo.js'

/**
 * Side elevation of one candidate: terrain, canopy band, and the sagging line.
 *
 * The surface model does not know what it measured, so the band above ground is drawn as canopy
 * unless a second source says otherwise -- see landcover.ts. Over a building the ground series is
 * already the roof, because terrain.ts treats a roof as ground, so the building is drawn as the
 * column between the roof and the bare earth underneath, with the terrain fill continuing below
 * it. Water is a section through the body, filled to the axis.
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

interface Props {
  c: Candidate
  profile: ProfileSample[]
  /** Per profile sample, or null while the land cover is still loading or unavailable. */
  cover: Cover | null
}

export function ProfileChart({ c, profile, cover }: Props) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
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

  /**
   * One filled shape per stretch of a single cover class, drawn over the terrain fill so it
   * replaces the brown rather than tinting it.
   *
   * Both start at the ground series, which over a building is the roof. A building closes on the
   * bare earth underneath, so it reads as a structure of a definite height with terrain continuing
   * below; water closes on the axis, as a section through the body. Bare earth is only known where
   * a window has loaded, so a building over a gap falls back to the axis rather than to NaN.
   */
  const runs = cover && cover.kind.length === p.length ? coverRuns(cover.kind) : []
  const base = PAD.top + ih
  const coverFill = (from: number, to: number, kind: number) => {
    const under = (i: number) => {
      const bare = cover!.bare[i]!
      return kind === COVER_BUILDING && Number.isFinite(bare) ? y(bare) : base
    }
    const top = p
      .slice(from, to + 1)
      .map((s, i) => `${i ? 'L' : 'M'}${x(s.d).toFixed(1)},${y(s.ground).toFixed(1)}`)
      .join('')
    const bottom: string[] = []
    for (let i = to; i >= from; i--) bottom.push(`L${x(p[i]!.d).toFixed(1)},${under(i).toFixed(1)}`)
    return `${top}${bottom.join('')}Z`
  }

  // Mark the two numbers the score actually turns on.
  const deepest = p.reduce((a, s) => (s.line - s.ground > a.line - a.ground ? s : a), p[0]!)
  const inner = p.filter((s) => s.d >= 10 && s.d <= c.length - 10)
  const tightest = inner.length
    ? inner.reduce((a, s) => (s.line - s.ground < a.line - a.ground ? s : a), inner[0]!)
    : deepest

  const ticks = [lo, (lo + hi) / 2, hi].map((v) => Math.round(v))

  /** Nearest sample to the pointer, in SVG space rather than pixels so zoom does not matter. */
  const trackPointer = (e: React.MouseEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    const at = ((e.clientX - box.left) / box.width) * W
    const d = ((at - PAD.left) / iw) * c.length
    let nearest = 0
    for (let i = 1; i < p.length; i++) {
      if (Math.abs(p[i]!.d - d) < Math.abs(p[nearest]!.d - d)) nearest = i
    }
    setHoverIndex(nearest)
  }

  const hover = hoverIndex === null ? null : p[hoverIndex]!

  /**
   * Mirrors the hovered sample onto the map.
   *
   * Interpolated between the anchors in projected metres and converted once, rather than between
   * their latitudes and longitudes: over half a kilometre the difference is millimetres, but doing
   * it right costs nothing. Cleared on unmount as well as on leaving, so closing the panel or
   * picking another line does not leave a dot behind.
   */
  useEffect(() => {
    if (!hover) return emitHoverPoint(null)
    const t = c.length > 0 ? hover.d / c.length : 0
    emitHoverPoint(toWgs84(c.a.e + (c.b.e - c.a.e) * t, c.a.n + (c.b.n - c.a.n) * t))
  }, [hover, c])

  useEffect(() => () => emitHoverPoint(null), [])
  // Flip the readout to the left of the guide near the right edge, so it never runs off.
  const hoverX = hover ? x(hover.d) : 0
  const readoutFlipped = hoverX > W - 150

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      role="img"
      aria-label="elevation profile"
      style={{ cursor: 'crosshair' }}
      onMouseMove={trackPointer}
      onMouseLeave={() => setHoverIndex(null)}
    >
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
      {runs.map((r) => (
        <path
          key={`${r.kind}-${r.from}`}
          d={coverFill(r.from, r.to, r.kind)}
          fill={r.kind === COVER_BUILDING ? 'var(--building)' : 'var(--water)'}
          opacity="0.9"
        />
      ))}
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

      {hover && (
        <g pointerEvents="none">
          <line
            x1={hoverX} x2={hoverX} y1={PAD.top} y2={PAD.top + ih}
            stroke="#e6e8ec" strokeWidth="1" strokeDasharray="2 2" opacity="0.7"
          />
          <circle cx={hoverX} cy={y(hover.line)} r="3" fill="#e6e8ec" />
          <circle cx={hoverX} cy={y(hover.ground)} r="3" fill="#e6e8ec" />
          <rect
            x={readoutFlipped ? hoverX - 138 : hoverX + 6} y={PAD.top + 2}
            width="132" height="34" rx="4"
            fill="rgba(15,17,21,0.92)" stroke="#2a2f3a"
          />
          <text
            x={readoutFlipped ? hoverX - 130 : hoverX + 14} y={PAD.top + 15}
            fill="#e6e8ec" fontSize="11"
          >
            {(hover.line - hover.ground).toFixed(1)} m above ground
          </text>
          <text
            x={readoutFlipped ? hoverX - 130 : hoverX + 14} y={PAD.top + 29}
            fill="#8b93a3" fontSize="11"
          >
            ground at {hover.ground.toFixed(1)} m
          </text>
        </g>
      )}

      <text x={PAD.left} y={H - 6} fill="#8b93a3" fontSize="10">A</text>
      <text x={W - PAD.right} y={H - 6} fill="#8b93a3" fontSize="10" textAnchor="end">
        B &middot; {c.length.toFixed(0)} m
      </text>
    </svg>
  )
}
