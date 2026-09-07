import { useEffect, useState, type CSSProperties } from 'react'
import type { Candidate, LineKind, Params, ProfileSample } from '../shared/types.js'
import { PLANNED_ID, type PlannedLine, type RigHeights } from '../shared/plan.js'
import { TRUNK_FRACTION, rigMeans, rigRange, type Standing } from '../shared/anchoring.js'
import type { Cover } from './landcover.js'
import { ProfileChart, type Wings } from './ProfileChart.js'
import { Slider, type SliderBand } from './Slider.js'
import {
  NEIGHBOURHOOD,
  PLANNED_REFINE_RADIUS,
  PLANNED_REFINE_FINEST,
  PLANNED_REFINE_RINGS,
  PLANNED_REFINE_START,
} from './optimize.js'
import { spanGeometry, type LatLon } from './planPoints.js'
import { Terrain3D } from './Terrain3D.js'

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
/**
 * How far the rig slider reaches, which follows what is standing there rather than a constant.
 *
 * The old cap was two metres, which is the right range for the only anchor the search knows how to
 * rig -- and useless for the ones a person can. A wood asks for its own height and a little over,
 * an open field asks for enough to stand something in, and either way a value already set is inside
 * the range so a link cannot open on a thumb pinned to the end.
 */
const RIG_FLOOR = 3

function rigCeiling(s: Standing, value: number): number {
  const top = Math.max(RIG_FLOOR, s.canopy * 1.25, Number.isFinite(value) ? value : 0)
  // To a whole metre, so the track's own scale does not jitter as an anchor is dragged.
  return Math.ceil(top)
}

/**
 * The track's stretches, in the same colours the profile and the 3D scene use for the same things.
 *
 * Four of them, and any may be empty: a roof has no trunk and no crown, an open field has neither
 * either, and where there is no surface model the canopy is unknown and reads as none. An empty band
 * takes no width, which is the honest picture -- there is nothing to climb there.
 */
function rigBands(s: Standing, p: Params, max: number): SliderBand[] {
  const free = rigRange(s.onRoof, p).max
  const trunk = Math.max(free, TRUNK_FRACTION * s.canopy)
  const crown = Math.max(trunk, s.canopy)
  return [
    { to: free, color: 'var(--ground)' },
    { to: trunk, color: 'var(--canopy)' },
    { to: crown, color: 'var(--crown)' },
    { to: max, color: 'var(--brought)' },
  ]
}

/**
 * What the height under the thumb would take, in words, with the figure that justifies it.
 *
 * The colour says which band; this says why that band is where it is. "Twelve metres" means nothing
 * without the twenty-four metre canopy it is half of, and on ground with nothing standing on it the
 * useful sentence is that there is nothing standing on it.
 */
function rigWords(height: number, s: Standing, p: Params): string | null {
  if (!Number.isFinite(height)) return null
  const h = height.toFixed(1)
  const canopy = s.canopy.toFixed(0)
  switch (rigMeans(height, s, p)) {
    case 'edge':
      return null
    case 'aFrame':
      return null
    case 'trunk':
      return `${h} m up — inside the lower half of a ${canopy} m canopy, so a trunk to climb`
    case 'crown':
      return `${h} m up — the thin top of a ${canopy} m canopy, where a trunk may not hold`
    default:
      return s.onRoof
        ? `${h} m above the roof — something you would build up there`
        : s.canopy > 0
          ? `${h} m up — above the ${canopy} m standing here, so a mast rather than a tree`
          : `${h} m up with nothing standing here — a mast, scaffold or crane`
  }
}

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
  /** Ground beyond the anchors, for context behind the span. Null when there is none to be had. */
  wings: Wings | null
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
  /**
   * Whether anything is known about what stands on the ground under this line.
   *
   * False outside Brandenburg, where the terrain comes from a source with no surface model. Every
   * figure stays finite -- the surface is taken to be the ground -- so clearance over terrain is
   * exact and the canopy ones describe a bare field. Which is only acceptable while it is said.
   */
  canopyKnown: boolean
  /**
   * Hard constraints the *re-measured* line fails, for a line out of the dataset. Null before the
   * finer profile has been built, and empty once it has and the line still clears everything.
   *
   * It can be non-empty for a line the search accepted, and that is not a contradiction: the search
   * measured it every four metres and this measures it every one, so a margin of a couple of
   * centimetres can go either way. The panel says which measurement it is showing.
   */
  violations: string[] | null
  /**
   * The sag every line is measured at, and the lowest the dataset allows.
   *
   * The same state the filter panel's slider holds, not a copy: sag is the one control that
   * re-measures rather than hides, so a second one that meant something different would be two
   * charts of the same line disagreeing. Null before the dataset has said what its floor is.
   */
  sag: { pct: number; floor: number } | null
  onSag: (pct: number) => void
  /** Whether this line fills the window. Lives in the URL, so it is the App's to hold. */
  full: boolean
  onFull: (full: boolean) => void
  /** An anchor dropped in the 3D view, which places it and then settles it. */
  onMoveAnchor: (which: 'a' | 'b', at: LatLon) => void
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
  c, profile, wings, cover, params, roadState, onRoof, planned, at, failed, fetching, violations,
  canopyKnown, sag, onSag, full, onFull, onMoveAnchor, optimizing, offer, onOptimize,
  rig, onRig, onClose,
}: Props) {
  /**
   * The full-screen view of one line.
   *
   * Not remembered between lines. It is a thing you go into to look at one place and come out of,
   * like a photograph you hold up, and a panel that opened full every time would be in the way of
   * the map that got you here.
   */
  useEffect(() => {
    if (!full) return
    const onKey = (e: KeyboardEvent) => {
      // Escape leaves the full view rather than closing the line, which is the smaller undo and so
      // the one a key with no label should do.
      if (e.key === 'Escape') onFull(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [full])

  /**
   * Where the pointer is on the profile, shared with the 3D view below it.
   *
   * Held here because both views are this panel's children and neither is above the other: the
   * chart says where the pointer is and the scene marks it, and nothing outside this panel has any
   * use for the answer.
   */
  /**
   * What is standing at each anchor, which is what decides whether a raised rig is a climb or a
   * crane. Read from the profile's own first and last stations, since those *are* the anchors --
   * no extra sampling, and it follows the line as it is dragged.
   */
  const standingAt = (end: 'a' | 'b'): Standing => {
    const s = end === 'a' ? profile?.[0] : profile?.[profile.length - 1]
    const read = s && Number.isFinite(s.surface) && Number.isFinite(s.ground)
    return { onRoof: !!onRoof?.[end], canopy: read ? Math.max(0, s.surface - s.ground) : 0 }
  }

  /**
   * How high one end is rigged, or NaN.
   *
   * `aFrame` is measured against the ground the survey actually read, and over ground it has not
   * read there is none -- so it is NaN, and handing NaN to a range input is both a React warning
   * and a thumb in an arbitrary place. The set rig heights are preferred where there are any, since
   * those are a decision rather than a measurement and are known whatever the terrain is doing.
   */
  const rigAt = (end: 'a' | 'b') => rig?.[end] ?? c?.[end].aFrame ?? NaN

  /**
   * The top of each slider's scale, frozen while a thumb is being dragged.
   *
   * The ceiling follows what is standing there *and* the value already set, so that a link opening
   * at forty metres is not pinned to the end of its own track. Recomputed live that made the top of
   * the track run away from the thumb: every metre dragged raised the ceiling, so the end could
   * never be reached and the scale under the pointer kept changing. So it settles on release, which
   * is also when a new scale is least disruptive to read.
   */
  const [rigTop, setRigTop] = useState({ a: RIG_FLOOR, b: RIG_FLOOR })
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    if (dragging) return
    const next = {
      a: rigCeiling(standingAt('a'), rigAt('a')),
      b: rigCeiling(standingAt('b'), rigAt('b')),
    }
    setRigTop((cur) => (cur.a === next.a && cur.b === next.b ? cur : next))
  })

  /**
   * Release is watched on the window rather than on the input: a thumb dragged past the edge of the
   * panel is let go of somewhere else entirely, and the drag has to end there too. Same reason the
   * resize grip above does it this way.
   */
  useEffect(() => {
    if (!dragging) return
    const stop = () => setDragging(false)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    window.addEventListener('keyup', stop)
    return () => {
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      window.removeEventListener('keyup', stop)
    }
  }, [dragging])

  const [hoverAt, setHoverAt] = useState<number | null>(null)

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

  /**
   * Whether this is still the line the search produced.
   *
   * The only thing the panel branches on any more, and it is provenance rather than mode: a dataset
   * line can say "the search accepted this and a finer measurement disagrees", and a line you made
   * cannot, because nothing accepted it. Every control is the same either way -- editing a found
   * line forks it, exactly as dragging its anchor always has, and from then on it is one you made.
   */
  const fromDataset = !!c && c.id !== PLANNED_ID
  /** Stations the elevation service has not covered. See planLine's `tolerateGaps`. */
  const unmeasured = profile?.filter((s) => Number.isNaN(s.ground)).length ?? 0
  const pctUnmeasured = profile?.length
    ? `${Math.max(1, Math.round((100 * unmeasured) / profile.length))} %`
    : ''
  /**
   * Whether the span is drawn at a height nobody measured.
   *
   * A worse thing to be missing than a gap in the middle, and worth its own sentence: a gap leaves
   * the line where it is and hides a stretch of what is under it, but an unmeasured anchor means
   * the line's own elevation was guessed and the whole curve could be sitting anywhere. The first
   * and last stations are the anchors, so the profile says this too -- see planLine's `standOn`.
   */
  const assumedEnds = profile?.length
    ? [profile[0]!, profile[profile.length - 1]!].filter((s) => Number.isNaN(s.ground)).length
    : 0
  const ends = c ? { a: c.a, b: c.b } : at
  // Length needs no elevation, so it is shown before the measurement lands.
  const geom = c ?? (ends && spanGeometry(ends.a, ends.b))
  /**
   * A figure, or a dash where there is none.
   *
   * The NaN check covers a partially measured line: a metric with nothing behind it comes through
   * as NaN rather than as zero, precisely so it cannot be read as "measured, and fine". Checked on
   * the formatted string so every row gets it without seventeen separate guards.
   */
  const stat = (fn: (c: Candidate) => string) => {
    if (!c) return DASH
    const shown = fn(c)
    return shown.includes('NaN') ? DASH : shown
  }
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
    // The full view has sliders for these; here they are a figure like any other.
    ...(full
      ? []
      : [
          {
            label: 'Rig height A / B',
            value: stat((c) => {
              const at = (end: 'a' | 'b') =>
                Number.isFinite(c[end].aFrame) ? `+${c[end].aFrame.toFixed(1)}` : DASH
              return `${at('a')} / ${at('b')} m`
            }),
          },
        ]),
    {
      label: 'Score: exp / len / canopy / clear / level',
      value: stat((c) => {
        const s = c.scoreParts
        return [s.exposure, s.length, s.canopy, s.margin, s.level].map(pct).join('/')
      }),
    },
  ]

  return (
    <div className="details" data-full={full || undefined} style={widthVar}>
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
        <strong style={{ color: c && Number.isFinite(c.score) ? scoreColor(c.score) : undefined }}>
          {c && Number.isFinite(c.score)
            ? `Score ${c.score.toFixed(1)}`
            : c
              ? 'not measured yet'
              : failed
                ? 'could not measure'
                : 'measuring…'}
        </strong>
        {c && (
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
            {geom.length.toFixed(0)} m
            {c && (
              <>
                {' '}&middot; midspan sag {c.sag.toFixed(1)} m
                &middot; offlevel {c.offLevel.toFixed(1)} m (
                {(c.offLevelRatio * 100).toFixed(1)} %)
              </>
            )}
          </span>
        )}
        <span className="headbtns">
          {!full && (
            <button
              className="close"
              onClick={() => onFull(true)}
              title="Fill the window: the profile at full width, and the site in three dimensions"
            >
              full view
            </button>
          )}
          {/* One way out, and it undoes one step: from the full view back to the card, and from the
              card back to the map. Two buttons side by side both saying close-ish is a choice
              nobody wants to have to read. */}
          <button className="close" onClick={() => (full ? onFull(false) : onClose())}>
            close
          </button>
        </span>
      </div>

      {/* Only in the full view: on the card the filter panel is a click away and the room is worth
          more than a duplicate. Here there is room, and this is where the answer it changes is. */}
      {full && sag && (
        <div className="sagbar">
          <Slider
            label="Midspan sag"
            value={sag.pct}
            min={sag.floor}
            max={10}
            step={0.5}
            unit=" % of span"
            format={(v) => v.toFixed(1)}
            onChange={onSag}
          />
        </div>
      )}

      <div className="cols">
        <div className="chart">
          {c && profile?.length ? (
            <>
              <ProfileChart
                c={c}
                profile={profile}
                wings={wings}
                cover={cover}
                params={params}
                fetching={fetching}
                onHover={setHoverAt}
              />
              {/* Over the chart rather than instead of it, and only where the chart has a hole to
                  explain. Elevation is in flight for all sorts of reasons -- another line, the
                  optimiser, the map -- and a badge over a complete profile says the thing being
                  looked at is unfinished when it is not. What this adds is which kind of gap the
                  gaps are, since ground still coming and ground the survey does not have look
                  exactly alike. */}
              {fetching && unmeasured > 0 && (
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

      {full && c && (
        <>
          <div className="rig" onPointerDown={() => setDragging(true)} onKeyDown={() => setDragging(true)}>
            {(['a', 'b'] as const).map((which) => {
              const here = rigAt(which)
              const measured = Number.isFinite(here)
              const stands = standingAt(which)
              const ceiling = Math.max(rigTop[which], measured ? here : 0)
              const words = rigWords(here, stands, params)
              return (
                <div className="rigend" key={which}>
                <Slider
                  key={which}
                  label={`Rig ${which.toUpperCase()}`}
                  value={measured ? here : 0}
                  min={0}
                  max={ceiling}
                  bands={rigBands(stands, params, ceiling)}
                  step={0.1}
                  unit={measured ? ' m' : ''}
                  format={() => (measured ? here.toFixed(1) : DASH)}
                  derived={rig === null}
                  // Touching either slider is taking the heights by hand, so an end whose own
                  // height was never measurable becomes a plain zero rather than staying unknown.
                  onChange={(v) => {
                    const other = rigAt(which === 'a' ? 'b' : 'a')
                    const kept = Number.isFinite(other) ? other : 0
                    onRig(which === 'a' ? { a: v, b: kept } : { a: kept, b: v })
                  }}
                />
                  {/* Attached to its own slider rather than collected below both, so on a phone --
                      where the two stack -- the sentence stays with the thumb it is about. Only the
                      ends that need one get one: a rig inside the A-frame is the ordinary case. */}
                  {words && (
                    <div className="note" data-means={rigMeans(here, stands, params)}>
                      {words}
                    </div>
                  )}
                </div>
              )
            })}
            <button
              className="rigauto"
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
            {assumedEnds > 0 && (
              <>
                {assumedEnds === 2
                  ? 'Neither anchor has ground under it yet, so the span is drawn level at the ' +
                    'average height of the terrain it crosses. '
                  : 'One anchor has no ground under it yet, so the span is drawn level with the ' +
                    'other. '}
                <strong>Its height is a guess, not a measurement.</strong>{' '}
              </>
            )}
            {fetching
              ? 'The figures below cover the part that has arrived, so they can only improve as ' +
                'the rest does. Clearance especially: the tightest point may be in the gap.'
              : 'The survey covers Brandenburg and Berlin only, and part of this line falls ' +
                'outside it. The figures below describe the rest, which makes every one of them ' +
                'the best case — the tightest clearance may be in the stretch nobody measured.'}
          </div>
        </div>
      )}

      {/* Same shape as the road banner and the same reason: a figure nobody measured must not read
          as a figure that came out well. */}
      {!canopyKnown && (
        <div className="violations" data-tone="wait">
          <b>No surface model for this ground</b>
          <div>
            Only Brandenburg publishes one. Everywhere else the terrain is real and the canopy is
            not: this line is measured as though the ground were bare, so{' '}
            <strong>clearance and exposure are exact and the canopy figures are empty</strong>.
            Trees, and anything else standing here, are yours to check.
          </div>
        </div>
      )}

      {/* Said before the verdict, because it qualifies the verdict: a line can only be called clear
          of the roads under it once we know what they are. */}
      {roadState !== 'ok' && (
        <div className="violations" data-tone={roadState === 'loading' ? 'wait' : 'bad'}>
          <b>
            {roadState === 'loading'
              ? 'Checking what this line passes over…'
              : 'No roads or water for this ground'}
          </b>
          <div>
            {roadState === 'loading'
              ? 'Clearance over roads and railways is not in the figures below yet.'
              : 'Outside Berlin and Brandenburg this is asked of OpenStreetMap as the line is ' +
                'placed, and that request did not come back. Until it does, a span over a road ' +
                'reads as a span over a field, and a span over a lake is held to the three metres ' +
                'this search asks over ground rather than the one it asks over water. Cautious in ' +
                'both directions, and blind in both. Moving an anchor asks again.'}
          </div>
        </div>
      )}

      {/* A dataset line, re-measured. The search accepted it at its own resolution; this is what a
          metre apart makes of it, which is occasionally not the same answer. */}
      {fromDataset && violations && violations.length > 0 && (
        <div className="violations">
          <b>Measured again at 1 m, this line would not qualify:</b>
          <ul>
            {violations.map((v) => (
              <li key={v}>{v}</li>
            ))}
          </ul>
          <div>
            The search sampled it every four metres and accepted it. Neither figure is wrong; the
            finer one is the one to walk in on.
          </div>
        </div>
      )}

      {!fromDataset && planned && (
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

      {full && c && (
        <Terrain3D
          a={{ e: c.a.e, n: c.a.n }}
          b={{ e: c.b.e, n: c.b.n }}
          anchorA={c.a.anchor}
          anchorB={c.b.anchor}
          // The sag actually drawn, not the dataset's: the slider re-measures every line, and the
          // span in the picture has to be the span in the figures beside it.
          sagRatio={c.length > 0 ? c.sag / c.length : 0}
          hoverAt={hoverAt}
          onMoveAnchor={onMoveAnchor}
        />
      )}
      </div>
    </div>
  )
}
