import { useEffect, useState, type CSSProperties } from 'react'
import type { Candidate, LineKind, Params, ProfileSample } from '../shared/types.js'
import { PLANNED_ID, PLANNED_RIG_MAX, type PlannedLine, type RigHeights } from '../shared/plan.js'
import type { Cover } from './landcover.js'
import { ProfileChart } from './ProfileChart.js'
import { Slider } from './Slider.js'
import {
  NEIGHBOURHOOD,
  PLANNED_REFINE_RADIUS,
  PLANNED_REFINE_FINEST,
  PLANNED_REFINE_RINGS,
  PLANNED_REFINE_START,
} from './optimize.js'
import { spanGeometry, type LatLon } from './planPoints.js'

function scoreColor(score: number): string {
  if (score >= 70) return '#22c55e'
  if (score >= 60) return '#a3e635'
  if (score >= 50) return '#f59e0b'
  return '#64748b'
}

const DASH = '—'

/**
 * What the button is about to do, in enough detail to trust or distrust the result.
 *
 * Long on purpose. A button that silently moves your line somewhere else has to say how it chose,
 * because "optimise" could mean anything from a global search to a single nudge, and this is much
 * closer to the nudge.
 */
function optimizeHelp(offer: number | null): string {
  const reach = offer ?? 1
  const spacing = PLANNED_REFINE_START * reach
  const lines = [
    'Hill-climb both anchors toward a better score, one at a time.',
    '',
    `Each step scans ${NEIGHBOURHOOD.length} positions around anchor A — a hexagonal patch of a ` +
      `triangular lattice, ${PLANNED_REFINE_RINGS} rings out — and moves it to the best one, if ` +
      `any beats where it stands. Then the same for B, against A’s new position. ` +
      `${NEIGHBOURHOOD.length * 2} ` +
      'candidate lines per step, not the square of that: the two ends are scanned separately, so ' +
      'a move that only helps if both ends make it together is invisible to it.',
    '',
    'Scanning a patch rather than a ring of directions means each step chooses how far to move as ' +
      'well as which way, so it strides out where the ground rewards it and shortens up near the ' +
      'top.',
    '',
    `The lattice starts at ${spacing.toFixed(1)} m and halves whenever the scan stalls, down to ` +
      `${PLANNED_REFINE_FINEST * 100} cm — so a run arrives quickly and then settles at full ` +
      'resolution however coarsely it started. Each spacing runs until it has nothing left to ' +
      'find, however long that takes, and never goes back up.',
    '',
    `A centimetre because the elevation is a 1 m grid read by interpolation: everywhere except a ` +
      'cell’s centre, the height under the line is a guess between four measurements. This lattice ' +
      'is fine enough to stand on the measurements.',
    '',
    'It stops when even the finest patch makes things worse, or when both anchors are ' +
      `${PLANNED_REFINE_RADIUS * reach} m from where you put them.`,
    '',
    'Score here counts hard-constraint failures too, so a line running through terrain or a ' +
      'building is walked out of it before anything gets polished.',
    '',
    'This finds the top of the hill it is standing on, not the highest hill.',
    '',
    'The sparks on the map are the positions it measured, so you can see how far each run reached.',
  ]
  if (offer !== null) {
    lines.push(
      '',
      `Now offering ${offer}× reach. Click again while this lasts to double it — the same ` +
        `${NEIGHBOURHOOD.length} points spread over ${offer}× the ground, so a wider search but ` +
        'one that can miss something narrow between them on the way.',
    )
  }
  return lines.join('\n')
}

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
  /** Land cover per profile sample, or null when it is still loading or unavailable. */
  cover: Cover | null
  /** The run's parameters, for the clearance rule the chart draws. */
  params: Params
  /**
   * Whether the road network under a planned line is known yet.
   *
   * Only a planned line has one: a found candidate carries the crossings the pipeline measured. It
   * has to be said out loud, because "no roads found" and "roads not checked" look identical on the
   * chart and only one of them means the line is safe to believe.
   */
  roadState: 'ok' | 'loading' | 'failed'
  /** Which ends stand on a building rather than on terrain. */
  onRoof: { a: boolean; b: boolean } | null
  planned: PlannedLine | null
  /** Endpoints to fall back on before there is a measurement to read them from. */
  at: { a: LatLon; b: LatLon } | null
  /** Why there is no chart, or null while one may still arrive. */
  failed: string | null
  /** Whether elevation is still arriving, which is what makes a gap in the chart temporary. */
  fetching: boolean
  optimizing: boolean
  /** Reach the button is offering for the next run, or null for the careful default. */
  offer: number | null
  onOptimize: () => void
  rig: RigHeights | null
  onRig: (r: RigHeights | null) => void
  onClose: () => void
}

/** The anchor class in terms of the two ends, rather than the one word the filter uses. */
const KIND_TEXT: Record<LineKind, string> = {
  natural: 'ground to ground',
  urban: 'at least one end on a roof',
}

/**
 * Panel width in pixels, or null for whatever the stylesheet chooses.
 *
 * At module scope rather than in state so it survives the panel closing: picking a different line
 * unmounts this component, and having the panel snap back to its default every time would make the
 * setting useless. Not persisted -- it is a working preference for the session, not a setting.
 */
let preferredWidth: number | null = null

/** Narrowest useful panel, and how much window has to stay visible beside the widest one. */
const MIN_WIDTH = 360
const KEEP_VISIBLE = 40

export function Details({
  c, profile, cover, params, roadState, onRoof, planned, at, failed, fetching, optimizing,
  offer, onOptimize,
  rig, onRig, onClose,
}: Props) {
  const [width, setWidth] = useState(preferredWidth)
  useEffect(() => {
    preferredWidth = width
  }, [width])

  /**
   * Drag the right edge to widen the panel.
   *
   * Set as a custom property rather than as `width`, so the narrow-screen rule in the stylesheet
   * still wins outright: on a phone the panel is the width of the screen and dragging it is neither
   * possible nor wanted. The chart inside is an SVG scaled to its container, so widening the panel
   * enlarges the profile in both directions without anything here knowing about it.
   */
  const widthVar = { '--details-w': width === null ? undefined : `${width}px` } as CSSProperties

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const grip = e.currentTarget
    const startX = e.clientX
    const startWidth = grip.parentElement?.getBoundingClientRect().width ?? MIN_WIDTH
    grip.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) =>
      setWidth(
        Math.max(
          MIN_WIDTH,
          Math.min(window.innerWidth - KEEP_VISIBLE, startWidth + ev.clientX - startX),
        ),
      )
    const stop = () => {
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', stop)
      grip.removeEventListener('pointercancel', stop)
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', stop)
    grip.addEventListener('pointercancel', stop)
  }

  // Only the planned line is ever shown without a measurement; found lines carry their own.
  const isPlanned = !c || c.id === PLANNED_ID
  /** Stations the elevation service has not covered. See planLine's `tolerateGaps`. */
  const unmeasured = profile?.filter((s) => Number.isNaN(s.ground)).length ?? 0
  const pctUnmeasured = profile?.length
    ? `${Math.max(1, Math.round((100 * unmeasured) / profile.length))} %`
    : ''
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
    // Named here as well as shown per end below, because it is what the anchor filter splits on.
    { label: 'Anchors', value: stat((c) => KIND_TEXT[c.kind]) },
    {
      // A roof counts as ground, so this figure is the roof where an end stands on a building.
      label: 'Ground A / B',
      value: stat((c) => {
        const end = (v: number, roof: boolean) => `${v.toFixed(1)}${roof ? ' (roof)' : ''}`
        return `${end(c.a.ground, !!onRoof?.a)} / ${end(c.b.ground, !!onRoof?.b)} m`
      }),
    },
    // The planned line has sliders for these instead.
    ...(isPlanned
      ? []
      : [{ label: 'Rig height A / B', value: stat((c) => `+${c.a.aFrame.toFixed(1)} / +${c.b.aFrame.toFixed(1)} m`) }]),
    {
      label: 'Score: exp / len / canopy / clear / level',
      value: stat((c) => {
        const s = c.scoreParts
        return [s.exposure, s.length, s.canopy, s.margin, s.level].map(pct).join('/')
      }),
    },
  ]

  return (
    <div className="details" style={widthVar}>
      <div
        className="grip"
        role="separator"
        aria-label="Resize panel"
        title="Drag to widen — double-click to reset"
        onPointerDown={startResize}
        onDoubleClick={() => setWidth(null)}
      />
      <div className="body">
      <div className="head">
        <strong style={{ color: isPlanned ? '#22c55e' : scoreColor(c!.score) }}>
          {isPlanned && 'Planned line · '}
          {c ? `Score ${c.score.toFixed(1)}` : failed ? 'could not measure' : 'measuring…'}
        </strong>
        {isPlanned && c && (
          <button
            className="optimize"
            data-running={optimizing}
            data-offer={!optimizing && offer !== null}
            onClick={onOptimize}
            title={optimizing ? 'Stop' : optimizeHelp(offer)}
          >
            {optimizing ? 'optimising…' : offer !== null ? `optimise ${offer}×` : 'optimise'}
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
          {c && profile?.length ? (
            <>
              <ProfileChart c={c} profile={profile} cover={cover} params={params} />
              {/* Over the chart rather than instead of it. Most of a line measured is worth looking
                  at while the rest arrives, and the gaps in it are drawn where they are -- what
                  this adds is which kind of gap they are, since ground still coming and ground the
                  survey does not have look exactly alike. */}
              {fetching && (
                <div className="chartbusy">
                  <i className="spinner" />
                  <span>loading elevation&hellip;</span>
                </div>
              )}
            </>
          ) : (
            <div className="chartwait">
              {failed ? (
                <span className="chartfail">
                  <strong>No profile for this line</strong>
                  {failed}
                  <em>
                    Elevation comes from the Brandenburg survey (isk.geobasis-bb.de), which covers
                    Brandenburg and Berlin only. Outside that there is nothing to fetch; inside it,
                    this is a request that failed &mdash; the browser console has the detail.
                  </em>
                </span>
              ) : (
                <>
                  <i className="spinner" />
                  <span>loading elevation&hellip;</span>
                </>
              )}
            </div>
          )}
          <div className="legend">
            <span><i style={{ background: 'var(--ground)' }} />terrain (DGM 1 m, LGB)</span>
            <span><i style={{ background: 'var(--canopy)' }} />canopy (bDOM, LGB)</span>
            <span><i style={{ background: 'var(--building)' }} />building, counted as ground (LoD1, Brandenburg only)</span>
            <span><i style={{ background: 'var(--water)' }} />water (OSM)</span>
            <span><i style={{ background: 'var(--road)' }} />road or rail crossed (OSM)</span>
            <span><i className="dashed" style={{ borderColor: 'var(--road)' }} />clearance required</span>
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

      {/* Same reason as the road banner below, and a stronger one: every figure a partial line
          reports is measured over the ground that was read, so all of them are optimistic in the
          same direction. The clearance minimum is the one that matters -- it cannot see into a
          stretch it never had, and the hill that would have set it may be exactly in there. */}
      {unmeasured > 0 && (
        <div className="violations" data-tone={fetching ? 'wait' : 'bad'}>
          <b>
            {fetching
              ? 'Still measuring this line…'
              : `No elevation for ${pctUnmeasured} of this line`}
          </b>
          <div>
            {fetching
              ? 'The figures below cover the part that has arrived, so they can only improve as ' +
                'the rest does. Clearance especially: the tightest point may be in the gap.'
              : 'The survey covers Brandenburg and Berlin only, and part of this line falls ' +
                'outside it. The figures below describe the rest, which makes every one of them ' +
                'the best case — the tightest clearance may be in the stretch nobody measured.'}
          </div>
        </div>
      )}

      {/* Said before the verdict, because it qualifies the verdict: a line can only be called clear
          of the roads under it once we know what they are. */}
      {isPlanned && roadState !== 'ok' && (
        <div className="violations" data-tone={roadState === 'loading' ? 'wait' : 'bad'}>
          <b>
            {roadState === 'loading'
              ? 'Checking what this line passes over…'
              : 'Road data unavailable'}
          </b>
          <div>
            {roadState === 'loading'
              ? 'Clearance over roads and railways is not in the figures below yet.'
              : 'The road data that ships with this app did not load, so nothing below accounts ' +
                'for roads or railways under this line. This is a broken deployment rather than ' +
                'something you did.'}
          </div>
        </div>
      )}

      {isPlanned && planned && (
        planned.violations.length > 0 ? (
          <div className="violations">
            <b>
              Would not qualify as a candidate &mdash; costing {planned.penalty.toFixed(1)} score:
            </b>
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
    </div>
  )
}
