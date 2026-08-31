import { useEffect, useState } from 'react'
import type { Candidate, Params, ProfileSample, RoadTier } from '../shared/types.js'
import { COVER_BUILDING, type Cover, coverRuns } from './landcover.js'
import { emitHoverPoint } from './hoverMarker.js'
import { toWgs84 } from '../shared/geo.js'

/**
 * Side elevation of one candidate: terrain, canopy band, and the sagging line.
 *
 * Two sections in one, because the line is measured across a band rather than along a ray. The
 * solid fill is the true section under the centreline; the outline above it is the worst of
 * anything within the band's half-width at that station -- ground the line would meet if the wind
 * pushed it sideways. Where the two coincide, which is most of a line over open ground, they
 * collapse into the single line this chart has always drawn. Where they part, the gap *is* the
 * reason a line was rejected, which is the only honest way to draw a rejection the centreline
 * cannot show. The same is done for vegetation, one shade lighter and purely as information:
 * canopy is scored on the centreline, so the band's trees are shown and not counted.
 *
 * The surface model does not know what it measured, so the band above ground is drawn as canopy
 * unless a second source says otherwise -- see landcover.ts. Over a building the ground series is
 * already the roof, because terrain.ts treats a roof as ground, so the building is drawn as the
 * column between the roof and the bare earth underneath, with the terrain fill continuing below
 * it. Water is a section through the body, filled to the axis.
 *
 * The clearance rule is drawn as one series along the whole span rather than as markers: at
 * `minClearance` over open ground, dropping over open water, and stepping up wherever something
 * carrying traffic passes underneath. That is the entire rule as one shape, and whether the line
 * clears it is then a matter of looking at the picture. The icon under each step says what the
 * traffic is; the dashed line says how much air it wants.
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

type SeriesKey = 'ground' | 'surface' | 'line' | 'groundMax' | 'surfaceMax' | 'needed'

interface Vertex {
  /** Distance along the span, in metres. */
  d: number
  /** Height at that distance, in metres. */
  h: number
}

/**
 * One series along the span, with a vertical wall wherever a building begins or ends.
 *
 * Buildings have vertical walls. Every series here is already the roof over one -- terrain.ts
 * treats a roof as ground, and the surface model sees the roof too -- so joining a pavement sample
 * to a roof sample with a straight segment draws a ramp up the side of the building at whatever
 * slope the sample spacing happens to give. There is no such slope, and at the resolution this
 * chart is read at the triangle is the first thing the eye lands on: brown for the terrain fill,
 * green for the canopy band above it, both describing material that is not there.
 *
 * So a sample standing on a building whose neighbour does not gets an extra vertex at its own
 * station, down at the foot of the wall: the series runs level to the wall and steps up it. That
 * station is exactly where the grey column's edge already is, so the two meet at a corner -- and
 * every series steps at the same station, so the shapes between them stay closed.
 *
 * Only the drawing changes. Clearance, exposure and every score are measured from the samples
 * themselves and are untouched -- the ramp was never in the numbers, only in the picture.
 */
export function steppedOutline(
  p: ProfileSample[],
  cover: Cover | null,
  height: (s: ProfileSample) => number,
  /**
   * Where this series sits at the foot of the wall, when something knows better than the neighbour
   * does. The terrain has the bare earth under the building; nothing else has an equivalent.
   */
  foot?: (i: number) => number,
): Vertex[] {
  const known = cover && cover.kind.length === p.length ? cover : null
  if (!known) return p.map((s) => ({ d: s.d, h: height(s) }))
  const onBuilding = (i: number) => known.kind[i] === COVER_BUILDING
  const atFoot = (i: number, beside: number) => {
    const under = foot?.(i)
    return under !== undefined && Number.isFinite(under) ? under : beside
  }

  const out: Vertex[] = []
  for (let i = 0; i < p.length; i++) {
    const s = p[i]!
    if (!onBuilding(i)) {
      out.push({ d: s.d, h: height(s) })
      continue
    }
    if (i > 0 && !onBuilding(i - 1)) out.push({ d: s.d, h: atFoot(i, height(p[i - 1]!)) })
    out.push({ d: s.d, h: height(s) })
    if (i + 1 < p.length && !onBuilding(i + 1)) out.push({ d: s.d, h: atFoot(i, height(p[i + 1]!)) })
  }
  return out
}

interface Props {
  c: Candidate
  profile: ProfileSample[]
  /** Per profile sample, or null while the land cover is still loading or unavailable. */
  cover: Cover | null
  /** The run's parameters, for the clearance rule the required-clearance line draws. */
  params: Params
}

/**
 * A glyph for what uses the crossing, in a 16-wide box centred on the origin and sitting on it.
 *
 * Drawn rather than lettered: the label would be an OSM tag value, and "secondary" tells a reader
 * nothing about whether a lorry is going to come along it.
 */
function TrafficIcon({ tier }: { tier: RoadTier }) {
  const stroke = { stroke: 'var(--road)', strokeWidth: 1.2, fill: 'none' }
  if (tier === 'path') {
    return (
      <g {...stroke}>
        <circle cx="0" cy="-8.5" r="1.6" />
        <path d="M0,-7 L0,-3 M0,-3 L-2,0 M0,-3 L2,0 M-2.5,-5.5 L2.5,-5.5" />
      </g>
    )
  }
  if (tier === 'cycle') {
    return (
      <g {...stroke}>
        <circle cx="-3.5" cy="-2" r="2.2" />
        <circle cx="3.5" cy="-2" r="2.2" />
        <path d="M-3.5,-2 L0,-2 L1.5,-6 M0,-2 L3.5,-2 M-1,-6 L2.5,-6" />
      </g>
    )
  }
  if (tier === 'street') {
    return (
      <g {...stroke}>
        <path d="M-6,-2 L-6,-4 L-3.5,-6.5 L3,-6.5 L6,-4 L6,-2 Z" />
        <circle cx="-3.5" cy="-1.4" r="1.3" />
        <circle cx="3.5" cy="-1.4" r="1.3" />
      </g>
    )
  }
  if (tier === 'road') {
    return (
      <g {...stroke}>
        <path d="M-7,-2 L-7,-8 L1,-8 L1,-2 Z M1,-5.5 L4,-5.5 L6.5,-3.5 L6.5,-2 L1,-2" />
        <circle cx="-4" cy="-1.4" r="1.3" />
        <circle cx="4" cy="-1.4" r="1.3" />
      </g>
    )
  }
  return (
    <g {...stroke}>
      <path d="M-5,-2 L-5,-9 A4,4 0 0 1 5,-9 L5,-2 Z M-5,-6 L5,-6 M-2.5,-1.5 L-2.5,0 M2.5,-1.5 L2.5,0" />
    </g>
  )
}

/**
 * The stretches the elevation service has not covered, and a profile with them bridged over.
 *
 * A partly measured line is drawn rather than withheld -- see planLine's `tolerateGaps` -- and it
 * arrives with NaN at every station that was not read. A NaN reaching a path coordinate does not
 * make a gap, it makes the entire `d` attribute invalid and the series vanishes, so the values are
 * bridged from the measured stations either side and the stretch is then covered by an opaque band.
 *
 * Interpolated ground is therefore never seen and never read: it exists so the paths on either side
 * of a gap stay one drawable shape, and everything that would show it -- the fills, the hover
 * readout, the two markers -- is either painted over or asks `measured` first. It is a drawing
 * convenience and not a measurement, which is why it stops here rather than going anywhere near
 * `rawMetricsAt`, where the same NaN is skipped outright.
 */
const BRIDGED: (keyof ProfileSample)[] = ['ground', 'surface', 'groundMax', 'surfaceMax']

export function bridgeGaps(profile: ProfileSample[]): {
  samples: ProfileSample[]
  gaps: [number, number][]
  measured: boolean[]
} {
  const measured = profile.map((s) => !Number.isNaN(s.ground))
  if (measured.every(Boolean)) return { samples: profile, gaps: [], measured }

  const samples = profile.map((s) => ({ ...s }))
  const gaps: [number, number][] = []
  for (let i = 0; i < samples.length; i++) {
    if (measured[i]) continue
    let end = i
    while (end + 1 < samples.length && !measured[end + 1]) end++
    // Held flat from whichever side has ground, so a gap at an end of the span does not slope off
    // to nowhere. A gap with measured ground on both sides is a straight ramp between them.
    const before = i > 0 ? samples[i - 1]! : null
    const after = end + 1 < samples.length ? samples[end + 1]! : null
    for (let j = i; j <= end; j++) {
      const t = before && after ? (j - i + 1) / (end - i + 2) : before ? 1 : 0
      for (const key of BRIDGED) {
        const lo = (before ?? after)![key]
        const hi = (after ?? before)![key]
        ;(samples[j]! as unknown as Record<string, number>)[key] = lo + (hi - lo) * t
      }
    }
    gaps.push([samples[i]!.d, samples[end]!.d])
    i = end
  }
  return { samples, gaps, measured }
}

export function ProfileChart({ c, profile, cover, params }: Props) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const { samples: p, gaps, measured } = bridgeGaps(profile)
  const crossings = c.crossings ?? []

  /**
   * A profile series read at any distance along the span, not only at its samples.
   *
   * A crossing lands where the road is, which is almost never on a sample: at 120 points a 500 m
   * line is sampled every four metres and a residential street is six wide.
   */
  const seriesAt = (d: number, key: SeriesKey): number => {
    const last = p.length - 1
    const t = c.length > 0 ? Math.min(1, Math.max(0, d / c.length)) : 0
    const at = t * last
    const i = Math.min(last, Math.floor(at))
    const f = at - i
    return f === 0 ? p[i]![key] : p[i]![key] * (1 - f) + p[Math.min(last, i + 1)]![key] * f
  }

  /**
   * What holds a crossing up: the road's own surveyed height where the crossing carries one, and
   * otherwise the profile under the line -- the ground for a road on the ground, the surface for
   * one on a bridge, since the terrain model is bare earth and runs straight underneath a deck.
   *
   * The road's own height matters now that a crossing can sit off to the side: drawing a street
   * three metres beside a rooftop span at the roof's height would put the slab in mid-air and the
   * clearance line with it.
   */
  const carrierOf = (x: (typeof crossings)[number], d: number) =>
    x.carrier ?? seriesAt(d, x.onBridge ? 'surface' : 'ground')

  /** The most demanding crossing covering a distance, or null where nothing does. */
  const demandAt = (d: number) => {
    let worst: { extra: number; x: (typeof crossings)[number] } | null = null
    for (const x of crossings) {
      if (d < x.from || d > x.to) continue
      const extra = params.roadClearance[x.tier]
      if (!worst || extra > worst.extra) worst = { extra, x }
    }
    return worst
  }

  /**
   * The clearance rule as one series: flat at `minClearance` over open ground, stepping up over
   * anything carrying traffic. Where the sagging line dips below it, the line does not qualify.
   *
   * Sampled at the profile's own points plus a pair either side of every kerb, so the steps are
   * vertical rather than ramps a few metres wide.
   */
  const EDGE = 0.05
  const requiredPoints = (() => {
    const ds = new Set<number>(p.map((s) => s.d))
    for (const x of crossings) {
      for (const edge of [x.from, x.to]) {
        ds.add(Math.max(0, Math.min(c.length, edge - EDGE)))
        ds.add(Math.max(0, Math.min(c.length, edge + EDGE)))
      }
    }
    return [...ds]
      .sort((u, v) => u - v)
      .map((d) => {
        const worst = demandAt(d)
        // Over open water the base figure drops -- falling in a lake is how a session ends -- and
        // over traffic it climbs. Both are the same rule seen from either side, so the line is one
        // series and the higher demand wins wherever they overlap.
        const base = seriesAt(d, 'ground') + seriesAt(d, 'needed')
        const road = worst ? carrierOf(worst.x, d) + params.minClearance + worst.extra : -Infinity
        return { d, v: Math.max(base, road) }
      })
  })()

  const lo = Math.min(...p.map((s) => s.ground)) - 2
  // The required-clearance line is part of the picture, so a 23 m demand over a railway has to fit
  // in it rather than run off the top. So is the band envelope, which is what a rejected line is
  // usually rejected by.
  const hi =
    Math.max(
      ...p.map((s) => Math.max(s.surfaceMax, s.line)),
      ...requiredPoints.map((q) => q.v),
    ) + 3
  /** Whether the band found anything the centreline did not, which is when it is worth drawing. */
  const bandShows = p.some((s) => s.groundMax > s.ground + 0.05)
  const canopyBandShows = p.some((s) => s.surfaceMax > s.surface + 0.05)
  const iw = W - PAD.left - PAD.right
  const ih = H - PAD.top - PAD.bottom

  const x = (d: number) => PAD.left + (d / c.length) * iw
  const y = (v: number) => PAD.top + ih - ((v - lo) / (hi - lo)) * ih

  /** The sagging line itself, which is a span rather than terrain and so walks no walls. */
  const path = (key: SeriesKey) =>
    p.map((s, i) => `${i ? 'L' : 'M'}${x(s.d).toFixed(1)},${y(s[key]).toFixed(1)}`).join('')

  const draw = (points: Vertex[], from = 0) =>
    points.map((v, i) => `${i || from ? 'L' : 'M'}${x(v.d).toFixed(1)},${y(v.h).toFixed(1)}`).join('')
  /** Every series that follows the terrain, so all of them step at the same wall. */
  const walled = (height: (s: ProfileSample) => number, foot?: (i: number) => number) =>
    steppedOutline(p, cover, height, foot)
  const outline = walled((s) => s.ground, cover ? (i) => cover.bare[i]! : undefined)
  const surfaceOutline = walled((s) => s.surface)
  const groundBand = walled((s) => s.groundMax)
  const canopyBand = walled((s) => s.surfaceMax)
  const groundPath = draw(outline)
  /** The shape between two of them, each walking its own walls. */
  const between = (top: Vertex[], bottom: Vertex[]) =>
    `${draw(top)}${draw([...bottom].reverse(), 1)}Z`

  const groundFill = `${groundPath}L${x(c.length)},${PAD.top + ih}L${PAD.left},${PAD.top + ih}Z`
  const canopyFill = between(surfaceOutline, outline)

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

  // Mark the two numbers the score actually turns on. Exposure is a centreline measurement -- how
  // high the line is over what is directly beneath it -- and clearance is a band one, so the
  // tightest marker has to be drawn against the envelope or it would contradict the panel's figure.
  // Over measured ground only. Both mark a figure the panel reports, and the panel computed it from
  // the ground it actually read -- pointing either marker at a bridged station would put a number
  // on the chart that nothing measured.
  const seen = p.filter((_, i) => measured[i])
  const deepest = seen.reduce((a, s) => (s.line - s.ground > a.line - a.ground ? s : a), seen[0]!)
  const inner = seen.filter((s) => s.d >= 10 && s.d <= c.length - 10)
  const tightest = inner.length
    ? inner.reduce((a, s) => (s.line - s.groundMax < a.line - a.groundMax ? s : a), inner[0]!)
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
  /** Whether the station under the pointer was measured, or is bridged over a gap. */
  const hoverKnown = hoverIndex === null || measured[hoverIndex]!

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

      {/* Vegetation the band reaches but the centreline misses: shown, never scored. */}
      {canopyBandShows && (
        <path
          d={between(canopyBand, surfaceOutline)}
          fill="var(--canopy)"
          opacity="0.22"
        />
      )}
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
      <path d={groundPath} stroke="#a08a72" strokeWidth="1.25" fill="none" />
      {/* The worst the band reaches, which is what clearance is actually measured against. */}
      {bandShows && (
        <>
          <path
            d={between(groundBand, outline)}
            fill="var(--ground)"
            opacity="0.45"
          />
          <path
            d={draw(groundBand)}
            stroke="#a08a72"
            strokeWidth="1"
            strokeDasharray="4 3"
            fill="none"
            opacity="0.9"
          />
        </>
      )}

      <line
        x1={x(deepest.d)} x2={x(deepest.d)} y1={y(deepest.line)} y2={y(deepest.ground)}
        stroke="#38bdf8" strokeWidth="1" strokeDasharray="3 2"
      />
      <text x={x(deepest.d) + 5} y={(y(deepest.line) + y(deepest.ground)) / 2} fill="#38bdf8" fontSize="10">
        {c.exposure.toFixed(1)} m air
      </text>

      <line
        x1={x(tightest.d)} x2={x(tightest.d)} y1={y(tightest.line)} y2={y(tightest.groundMax)}
        stroke="#fbbf24" strokeWidth="1" strokeDasharray="3 2"
      />
      <text x={x(tightest.d) + 5} y={y(tightest.groundMax) - 4} fill="#fbbf24" fontSize="10">
        {c.clearanceMin.toFixed(1)} m
      </text>

      {/* The clearance rule, drawn before the line so the line reads as sitting over or under it. */}
      {requiredPoints.length > 1 && (
        <path
          d={requiredPoints
            .map((q, i) => `${i ? 'L' : 'M'}${x(q.d).toFixed(1)},${y(q.v).toFixed(1)}`)
            .join('')}
          stroke="var(--road)"
          strokeWidth="1.25"
          strokeDasharray="5 3"
          fill="none"
          opacity="0.85"
        />
      )}
      {crossings.map((r, i) => {
        const carrier = carrierOf(r, r.d)
        const left = x(r.from)
        const width = Math.max(4, x(r.to) - left)
        const short = params.minClearance + params.roadClearance[r.tier] - (seriesAt(r.d, 'line') - carrier)
        return (
          <g key={`${r.d}-${i}`}>
            {/* The stretch of span the road is under the band for, as a slab on what carries it. */}
            <rect
              x={left}
              y={y(carrier) - 2}
              width={width}
              height="4"
              fill={short > 0 ? 'var(--bad)' : 'var(--road)'}
              opacity={r.offset > 0 ? 0.55 : 1}
            />
            <g transform={`translate(${x(r.d)},${y(carrier) - 3})`}>
              <TrafficIcon tier={r.tier} />
            </g>
          </g>
        )
      })}

      {/* Over every terrain shape and under the span, which is a parabola and known regardless of
          what is beneath it. Opaque, so the bridged ground under here is covered rather than
          faded -- a hint of invented terrain would be read as terrain. */}
      {gaps.map(([from, to]) => (
        <g key={`gap-${from}`}>
          <rect
            x={x(from)} y={PAD.top} width={Math.max(2, x(to) - x(from))} height={ih}
            fill="var(--panel, #12151b)" opacity="0.96"
          />
          <rect
            x={x(from)} y={PAD.top} width={Math.max(2, x(to) - x(from))} height={ih}
            fill="none" stroke="#8b93a3" strokeWidth="1" strokeDasharray="4 3" opacity="0.8"
          />
        </g>
      ))}
      {gaps.length > 0 && (
        <text
          x={x((gaps[0]![0] + gaps[0]![1]) / 2)} y={PAD.top + ih / 2}
          fill="#8b93a3" fontSize="10" textAnchor="middle"
        >
          not surveyed
        </text>
      )}

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
          {hoverKnown && <circle cx={hoverX} cy={y(hover.ground)} r="3" fill="#e6e8ec" />}
          <rect
            x={readoutFlipped ? hoverX - 148 : hoverX + 6} y={PAD.top + 2}
            width="142" height={!hoverKnown ? 20 : hover.halfWidth > 0 ? 48 : 34} rx="4"
            fill="rgba(15,17,21,0.92)" stroke="#2a2f3a"
          />
          {/* Bridged ground is a drawing convenience, so the readout refuses to quote it rather
              than reporting an interpolation as a measurement. */}
          {!hoverKnown && (
            <text
              x={readoutFlipped ? hoverX - 140 : hoverX + 14} y={PAD.top + 15}
              fill="#8b93a3" fontSize="11"
            >
              ground not surveyed here
            </text>
          )}
          {hoverKnown && (
            <text
              x={readoutFlipped ? hoverX - 140 : hoverX + 14} y={PAD.top + 15}
              fill="#e6e8ec" fontSize="11"
            >
              {(hover.line - hover.ground).toFixed(1)} m above ground
            </text>
          )}
          {hoverKnown && (
            <text
              x={readoutFlipped ? hoverX - 140 : hoverX + 14} y={PAD.top + 29}
              fill="#8b93a3" fontSize="11"
            >
              ground at {hover.ground.toFixed(1)} m
            </text>
          )}
          {hoverKnown && hover.halfWidth > 0 && (
            <text
              x={readoutFlipped ? hoverX - 140 : hoverX + 14} y={PAD.top + 43}
              fill="#8b93a3" fontSize="11"
            >
              {(hover.line - hover.groundMax).toFixed(1)} m within &plusmn;
              {hover.halfWidth.toFixed(1)} m
            </text>
          )}
        </g>
      )}

      <text x={PAD.left} y={H - 6} fill="#8b93a3" fontSize="10">A</text>
      <text x={W - PAD.right} y={H - 6} fill="#8b93a3" fontSize="10" textAnchor="end">
        B &middot; {c.length.toFixed(0)} m
      </text>
    </svg>
  )
}
