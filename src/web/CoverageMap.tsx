import { useMemo, useState } from 'react'
import { STATES } from './coverage.js'
import { integration, searchedStates, tierOf, type StateFacts, type Tier } from './integration.js'
import type { Region } from '../shared/types.js'

/**
 * Sixteen states, coloured by how much of them this app can actually measure.
 *
 * The guide used to say "past the outlines you can still place two anchors by hand, though with
 * less to measure it against", which is true and tells you nothing: less than what, and where does
 * it stop being worth doing? The answer differs four ways across the country and changes as
 * services are found, so it is drawn rather than written -- and drawn from what the code does, not
 * from a list kept beside it. See integration.ts.
 *
 * Small on purpose. It sits inside a panel of prose at about the size of a postage stamp per state,
 * which is enough to find the one you live in and no more; everything else is in the row underneath,
 * which follows the pointer and stays put when it leaves.
 */

const TIERS: { id: Tier; label: string; hint: string }[] = [
  { id: 'searched', label: 'Searched', hint: 'lines already found, ready to browse' },
  { id: 'measured', label: 'Full measurement', hint: 'plan by hand, ground and canopy both read' },
  { id: 'terrain', label: 'Terrain only', hint: 'plan by hand, nothing known about the trees' },
]

/**
 * Equirectangular, with longitude squeezed by the cosine of the middle latitude.
 *
 * Germany on a Mercator projection is noticeably taller than the shape everyone recognises from a
 * road atlas, and at this size a projection is a drawing decision rather than a measurement: nothing
 * is read off it, nothing is clicked through to a coordinate. This is the cheap one that looks
 * right.
 */
function projector(width: number, height: number) {
  const points = STATES.filter((s) => s.code !== 'DE').flatMap((s) => s.rings.flat())
  const lons = points.map((p) => p[0]!)
  const lats = points.map((p) => p[1]!)
  const [w, e, s, n] = [Math.min(...lons), Math.max(...lons), Math.min(...lats), Math.max(...lats)]
  const k = Math.cos((((s + n) / 2) * Math.PI) / 180)
  const scale = Math.min((width - 2) / ((e - w) * k), (height - 2) / (n - s))
  const offX = (width - (e - w) * k * scale) / 2
  const offY = (height - (n - s) * scale) / 2
  return (lon: number, lat: number): [number, number] => [
    offX + (lon - w) * k * scale,
    height - offY - (lat - s) * scale,
  ]
}

const VIEW_W = 236
const VIEW_H = 300
const at = projector(VIEW_W, VIEW_H)

export function CoverageMap({ regions }: { regions: Region[] | null }) {
  const facts = useMemo(() => integration(searchedStates(regions)), [regions])
  /**
   * Biggest first, so a city state is drawn on top of the state around it rather than under it.
   *
   * Berlin is a hole in Brandenburg and Bremen two holes in Lower Saxony, and in the order these
   * come in the file the big one is painted second and covers the small one completely. Area of the
   * bounding box is enough to sort by -- nothing here is close enough for the difference between
   * that and the real area to change the order.
   */
  const shapes = useMemo(() => {
    const byName = new Map(STATES.map((s) => [s.name, s.rings]))
    const area = (rings: number[][][]) => {
      const pts = rings.flat()
      const lons = pts.map((q) => q[0]!)
      const lats = pts.map((q) => q[1]!)
      return (Math.max(...lons) - Math.min(...lons)) * (Math.max(...lats) - Math.min(...lats))
    }
    return facts
      .map((f) => {
        const rings = byName.get(f.name) ?? []
        return {
          facts: f,
          area: area(rings),
          small: area(rings) < SMALL,
          at: centre(rings),
          d: rings
            .map(
              (ring) =>
                `M${ring.map((q) => at(q[0]!, q[1]!).map((v) => v.toFixed(1)).join(' ')).join('L')}Z`,
            )
            .join(''),
        }
      })
      .sort((x, y) => y.area - x.area)
  }, [facts])

  /**
   * What the row underneath is describing: whatever was last pointed at, and Brandenburg to begin
   * with. It does not clear on leaving -- a caption that empties as the pointer goes to read it is
   * a caption nobody finishes reading.
   */
  const [shown, setShown] = useState('Brandenburg')
  const here = facts.find((f) => f.name === shown) ?? facts[0]!

  return (
    <div className="coverage">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        role="img"
        aria-label="What is measured in each German state"
      >
        {shapes.map(({ facts: f, d, small, at: [cx, cy] }) => (
          <g
            key={f.code}
            className="state"
            data-tier={tierOf(f)}
            data-on={f.name === shown || undefined}
            tabIndex={0}
            role="button"
            aria-label={summary(f)}
            onMouseEnter={() => setShown(f.name)}
            onFocus={() => setShown(f.name)}
            onClick={() => setShown(f.name)}
          >
            {/* A city state's own shape is a few pixels across: neither visible as a colour nor
                findable as a hover target, and drawn at this scale its outline is a burr on the
                state around it. So it becomes a dot instead of a shape -- the only mark here that
                is a symbol rather than a measurement, which is why it is the only one with a ring
                round it. Bremen is two places and gets one dot; at four pixels that is the truth
                at the resolution available. */}
            {small ? <circle cx={cx} cy={cy} r={4.5} /> : <path d={d} />}
          </g>
        ))}
      </svg>

      <div className="detail">
        <b>{here.name}</b>
        <ul>
          <Row on={here.ground === 'survey'} label="Ground height">
            {here.ground === 'survey' ? "the state's own survey" : 'via hoehendaten.de'}
          </Row>
          <Row on={here.canopy} label="Canopy height">
            {here.canopy ? 'measured' : 'not published where a browser can read it'}
          </Row>
          <Row on={here.shade === 'survey'} label="Hillshade">
            {here.shade === 'survey' ? "1 m, the state's own" : '5 m, basemap.de'}
          </Row>
          <Row on={here.ortho === 'survey'} label="Aerial imagery">
            {here.ortho === 'survey' ? '20 cm or better' : '10 m, Sentinel-2'}
          </Row>
          <Row on={here.lines} label="Lines found">
            {here.lines ? 'searched by the pipeline' : 'plan your own'}
          </Row>
        </ul>
      </div>

      <ul className="legend">
        {TIERS.map((t) => (
          <li key={t.id}>
            <i data-tier={t.id} />
            <b>{t.label}</b> {t.hint}
          </li>
        ))}
      </ul>
    </div>
  )
}

function Row({ on, label, children }: { on: boolean; label: string; children: React.ReactNode }) {
  return (
    <li data-on={on || undefined}>
      <span>{label}</span>
      <span>{children}</span>
    </li>
  )
}

/** Below this many square degrees a state gets a dot as well as its shape. Berlin, Bremen, Hamburg. */
const SMALL = 0.35

/** The middle of a state's largest ring, in drawing coordinates. */
function centre(rings: number[][][]): [number, number] {
  const ring = rings.reduce((big, r) => (r.length > big.length ? r : big), rings[0] ?? [])
  if (!ring.length) return [0, 0]
  const mid = ring.reduce(([x, y], q) => [x + q[0]! / ring.length, y + q[1]! / ring.length], [0, 0])
  return at(mid[0]!, mid[1]!)
}

const summary = (f: StateFacts) =>
  `${f.name}: ${TIERS.find((t) => t.id === tierOf(f))!.label.toLowerCase()}`
