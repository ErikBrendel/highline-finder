import { useEffect, useMemo, useRef, useState } from 'react'
import { LINE_KINDS } from '../shared/types.js'
import type { Pos } from '../shared/grid.js'
import { withSpan } from '../shared/roads.js'
import type {
  AnchorDump,
  ByKind,
  Candidate,
  DatasetMeta,
  DrawnSpots,
  HotspotArrays,
  Hotspots,
  LineKind,
  MaskCells,
  Params,
  Region,
  TileUsage,
} from '../shared/types.js'
import { rescoreAtSag } from '../shared/scoring.js'
import { VIEWER_PROFILE, measuredHalfWidth, unpackProfile } from '../shared/profile.js'
import { DEFAULT_PARAMS } from '../pipeline/params.js'
import { DEV_MODE } from './devMode.js'
import {
  BASEMAPS, DEBUG_COLORS, LINES_FROM, MIX_MAX, MapView, SAME_VINTAGE_MS, type TileLayer,
} from './MapView.js'
import { NO_LINE, place, type CustomPoints, type LatLon, type LineSpec } from './planPoints.js'
import { useSpots } from './useSpots.js'
import { defaultLineName, spotFromHash, spotTitle, type Spot, type SpotLine } from './spots.js'
import { SpotsPanel, type Lit } from './SpotsPanel.js'
import type { SavedDrawn } from './MapView.js'
import { toUtm33 } from '../shared/geo.js'
import { PLANNED_ID, planLine, type PlannedLine, type RigHeights } from '../shared/plan.js'
import {
  DRAG_LOOKAHEAD, ensureTerrain, fetchingWindows, groundSampler, onBuilding, onWindowActivity,
  roofs, canopyAlong, surfaceSampler, type Canopy,
} from './terrain.js'
import { sourceFor } from './sources.js'
import { coverAlong, coverFailed, ensureCover, onCoverChange, roadsFor, water } from './landcover.js'

import { Details } from './Details.js'
import type { WingSample } from './ProfileChart.js'
import { Guide, useGuide } from './Guide.js'
import { fitHeader } from './headerFit.js'
import { ShareButton } from './ShareButton.js'
import { useRemembered } from './remembered.js'
import { watchLocation, type Fix } from './locate.js'
import { overlaps, touches, type Bbox } from './inView.js'
import { failureText, report } from './report.js'
import { RangeSlider, Slider } from './Slider.js'
import { cacheStats, clearTileCache } from './tileCache.js'
import { changed, FILTER_DEFAULTS, movedFilters, parseUrl, toSearch } from './urlState.js'
import { optimizeFrame, scanMargin, startingSpacing } from './optimize.js'
import { emitProbes } from './probeOverlay.js'

/**
 * The tightest sag a line may be measured at, in per cent of span.
 *
 * A planned line is measured from the terrain on the spot, so it can be measured at any sag. Only
 * the found lines are bound to the sag the dataset was generated at -- see `rescored`.
 */
const SAG_MIN_PCT = 1

/** How far from the middle of the open line another line of its spot may be and still share its 3D view. */
const COMPANION_REACH = 500

/** How long the button keeps offering a wider search after a run ends. */
const OFFER_MS = 2000

/** How far past each anchor the profile shows terrain, and at how many samples. */
const WING_FRACTION = 0.02
const WING_POINTS = 20
import { toWgs84 } from '../shared/geo.js'

type DebugLayer = 'none' | 'coarse' | 'terrain' | 'surface' | 'buildings' | 'roads' | 'regions'

/**
 * What is known about what stands along the corridor a line of this span is measured over.
 *
 * One expression, used both to tell the reader and to tell `planLine`, so the banner and the
 * figures cannot end up disagreeing about whether anything was known about what is standing here.
 * The corridor is the one the measurement actually reads -- see `measuredHalfWidth` -- rather than
 * the wider one the drag prefetches.
 */
const canopyOver = (a: Pos, b: Pos, length: number, p: Params): Canopy =>
  canopyAlong(a, b, measuredHalfWidth(length, p))

/** What each anchor class actually means for the trip, which the word alone does not say. */
const KIND_HELP: Record<LineKind, string> = {
  natural: 'Both ends on the ground. Walk in and rig.',
  urban: 'At least one end on a roof. Needs access to the building and permission to rig off it.',
}

/**
 * What each debug view means, beside the map that draws it.
 *
 * These views are of the pipeline rather than of the terrain, so a colour on its own says nothing.
 * The figures live here rather than in the button because they are the reading, not the label.
 */
function DebugLegend({
  layer, mask, tiles, regions,
}: {
  layer: Exclude<DebugLayer, 'none'>
  mask: MaskCells | null
  tiles: TileUsage | null
  regions: Region[]
}) {
  /**
   * A swatch names a colour, so it is drawn at full strength.
   *
   * It used to carry the map layer's own fill-opacity, on the theory that the key should look like
   * the map. It cannot: the map composites its fill over terrain and orthophoto, the legend over a
   * flat dark panel, so the same alpha that reads as a pale blue wash over a hillside reads as
   * almost nothing here -- the coarse layer's 0.16 was invisible.
   */
  const key = (color: string, text: string) => (
    <div className="key" key={text}>
      <i style={{ background: color }} />
      <span>{text}</span>
    </div>
  )

  if (layer === 'coarse') {
    if (!mask) return null
    const total = (mask.res / mask.sourceRes) ** 2
    const pct = (v: number) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)} %`
    const needed = mask.minCoverage
    const below = mask.passing.filter((c) => c / total < needed).length
    return (
      <div className="legendbox">
        <h3>Coarse pre-pass</h3>
        {key(DEBUG_COLORS.maskBelow, `under ${pct(needed)} of the tile — never fetched`)}
        {key(DEBUG_COLORS.maskAbove, 'over it — fetched, fading as the margin grows')}
        <div className="stat">
          {below.toLocaleString()} of {mask.passing.length.toLocaleString()} tiles under the
          threshold
        </div>
        <div className="about">
          One square per source tile, shaded by how much of it can fall {mask.minDrop} m within{' '}
          {mask.sourceRes * 2} m &mdash; measured on a {mask.sourceRes} m grid that costs almost
          nothing to fetch, and counted out of the {total.toLocaleString()} cells a whole tile
          holds. A tile is fetched at {pct(needed)}, and the tile is the unit: a single good
          hillside does not carry the square kilometre it sits in. It measures bare earth, which is
          its blind spot &mdash; the buildings view counts what that skips.
        </div>
      </div>
    )
  }

  if (layer === 'regions') {
    const times = regions.map((r) => Date.parse(r.generatedAt)).filter((t) => !Number.isNaN(t))
    const [newest, oldest] = [Math.max(...times), Math.min(...times)]
    const oneBatch = newest - oldest < SAME_VINTAGE_MS
    const day = (t: number) => new Date(t).toISOString().slice(0, 10)
    return (
      <div className="legendbox">
        <h3>Region vintage</h3>
        {key(DEBUG_COLORS.fresh, oneBatch ? 'all of one vintage' : `newest — ${day(newest)}`)}
        {!oneBatch && key(DEBUG_COLORS.aged, `oldest — ${day(oldest)}`)}
        <div className="stat">
          {regions.length} region{regions.length === 1 ? '' : 's'}
          {oneBatch
            ? `, all computed ${day(newest)}`
            : `, spanning ${Math.round((newest - oldest) / 86_400_000)} days`}
        </div>
        <div className="about">
          A region is computed once and kept until a run is told to rebuild it, so a dataset is not
          necessarily of one vintage and its lines are not necessarily comparable with each other.
          The shading is fitted to whatever range this dataset happens to span rather than to a
          fixed number of days, since what matters is which parts lag behind the rest, not how old
          the whole thing is. Age is all there is to go on: neither a change to the parameters nor one to the search
          itself leaves any other mark, which is the price of not throwing away every region
          whenever the code moves. The boxes are areas of interest today; once the search is cut
          into fixed chunks instead, this becomes the map of what has been covered and when.
        </div>
      </div>
    )
  }

  if (!tiles) return null
  const fetched = (layer === 'surface' ? tiles.surface : tiles.terrain).filter(Boolean).length
  const barren = tiles.terrain.filter((t, i) => t && tiles.anchors[i] === 0).length

  if (layer === 'buildings') {
    const withRoofs = tiles.roofCells.filter((c) => c > 0).length
    const missed = tiles.roofCells.filter((c, i) => c > 0 && !tiles.terrain[i])
    const missedCells = missed.reduce((s, c) => s + c, 0)
    return (
      <div className="legendbox">
        <h3>Buildings</h3>
        {key(DEBUG_COLORS.roofs, 'roofs on ground the search loaded — anchors and obstacles')}
        {key(DEBUG_COLORS.roofsMissed, 'roofs the search never saw — the pre-pass skipped this tile')}
        {key(DEBUG_COLORS.skipped, 'no buildings')}
        <div className="stat">
          {withRoofs} of {tiles.lat.length} tiles carry a building;{' '}
          {missed.length} of those were skipped ({missedCells.toLocaleString()} roof cells unseen)
        </div>
        <div className="about">
          The city model is asked about every tile, including the ones the coarse pass rejected, at
          5&ndash;50 KB each. Red is what that pass costs: it judges a tile on bare earth, so a flat
          square with a thirty-metre building on it is skipped before any roof is known about. A red
          tile is ground with something worth anchoring to that the search never looked at.
        </div>
      </div>
    )
  }

  if (layer === 'roads') {
    const killed = tiles.roadKills.reduce((s, n) => s + n, 0)
    const worst = Math.max(0, ...tiles.roadKills)
    return (
      <div className="legendbox">
        <h3>Lines killed by a road</h3>
        {key(DEBUG_COLORS.killsMany, 'many died here')}
        {key(DEBUG_COLORS.killsFew, 'a few died here')}
        {key(DEBUG_COLORS.skipped, 'none')}
        <div className="stat">
          {killed.toLocaleString()} lines rejected for passing too low over traffic, worst tile{' '}
          {worst.toLocaleString()}
        </div>
        <div className="about">
          Counted at the crossing rather than at an anchor, so a bright square is a road doing the
          killing rather than a place lines start from. This is the only filter whose numbers are
          pure judgement &mdash; a footpath asks for nothing extra and a railway for twenty metres
          &mdash; so it is the one worth looking at before changing them.
        </div>
      </div>
    )
  }

  if (layer === 'terrain') {
    return (
      <div className="legendbox">
        <h3>Terrain tiles fetched</h3>
        {key(DEBUG_COLORS.productive, 'fetched, and the 1 m scan found anchors in it')}
        {key(DEBUG_COLORS.barren, 'fetched and yielded nothing — the filter being too loose')}
        {key(DEBUG_COLORS.skipped, 'skipped — dark beside green means too tight')}
        <div className="stat">
          {fetched} of {tiles.lat.length} fetched, {barren} of those barren (~
          {Math.round(barren * 1.4)} MB for nothing)
        </div>
        <div className="about">
          One square per {tiles.size / 1000} km source tile, at 1.4 MB each. This is the
          granularity every fetching decision is actually taken at, whatever the coarse pass
          concluded at its own much finer scale.
        </div>
      </div>
    )
  }

  return (
    <div className="legendbox">
      <h3>Surface tiles fetched</h3>
      {key(DEBUG_COLORS.productive, 'a line crosses it, so canopy had to be measured')}
      {key(DEBUG_COLORS.skipped, 'no line crosses it — skipped')}
      <div className="stat">
        {fetched} of {tiles.lat.length} fetched, {tiles.lat.length - fetched} skipped (~
        {Math.round((tiles.lat.length - fetched) * 32)} MB saved)
      </div>
      <div className="about">
        Same {tiles.size / 1000} km squares as the terrain view. The surface model is 32 MB per
        tile against the terrain model&rsquo;s 1.4, and canopy is only ever scored, never a gate —
        so it is fetched after the terrain search, for the corridors that survived it.
      </div>
    </div>
  )
}

/**
 * Basemap tiles are served with `no-cache`, so they are cached in IndexedDB instead. Showing the
 * size makes that visible rather than mysterious, and gives a way out if it ever misbehaves.
 */
function CacheBadge() {
  const [stats, setStats] = useState(cacheStats())
  useEffect(() => {
    // Reads an in-memory index, so polling costs nothing and keeps the figure live as tiles load.
    const t = setInterval(() => setStats(cacheStats()), 2000)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="cachebadge">
      <span>
        {stats.count} tiles &middot; {(stats.bytes / 1048576).toFixed(0)} MB cached
      </span>
      <button onClick={() => void clearTileCache().then(() => setStats(cacheStats()))}>
        clear
      </button>
    </div>
  )
}

/**
 * A count, and the whole of which it is part when the two differ.
 *
 * Same number twice is not information, so at the opening view -- where everything switched on is
 * also on screen -- the button reads exactly as it always did.
 */
const here = (shown: number, total: number) =>
  shown === total ? total.toLocaleString() : `${shown.toLocaleString()} of ${total.toLocaleString()}`

/** A button's label while what it counts is still on the wire. */
const Spinner = ({ label }: { label: string }) => (
  <>
    <i className="spin" />
    {label}
  </>
)

/**
 * A label and what it shrinks to when the header runs out of room.
 *
 * Both are rendered and one is hidden, rather than measuring the header and choosing: the widths
 * involved are known at design time, and a resize observer to pick between two strings would be a
 * layout dependency where a media query is enough. See `.full` and `.abbr` in styles.css.
 */
const Label = ({ full, short }: { full: string; short: string }) => (
  <>
    <span className="full">{full}</span>
    <span className="abbr">{short}</span>
  </>
)

export function App() {
  // Read once. The URL is an input at startup and an output thereafter; treating it as live state
  // both ways is how a URL writer and a URL reader start feeding each other.
  const [initial] = useState(() => parseUrl(window.location.search))
  const [sharedSpot] = useState(() => spotFromHash(window.location.hash))
  const header = useRef<HTMLElement>(null)
  // Measured once the row is in the document, and re-applied on every resize thereafter.
  useEffect(() => (header.current ? fitHeader(header.current) : undefined), [])
  /**
   * The run, and the lines it found, fetched separately because they are wanted at different times.
   *
   * meta.json is forty kilobytes and settles the filter panel, the map's outlines and every
   * parameter the planner measures with; candidates.json is three megabytes of lines and settles
   * only what is drawn. Waiting for the second to use the first is the whole reason for the split.
   */
  const [meta, setMeta] = useState<DatasetMeta | null>(null)
  const [lines, setLines] = useState<ByKind<Candidate[]> | null>(null)
  const [error, setError] = useState<string | null>(null)
  // null until the dataset is loaded, because the floor comes from the pipeline's own sag.
  // Each slider starts where the link put it, or at the value where it filters nothing.
  const filter = <K extends keyof typeof FILTER_DEFAULTS>(field: K) =>
    initial.filters[field] ?? FILTER_DEFAULTS[field]
  const [minScore, setMinScore] = useState(filter('minScore'))
  const [minLength, setMinLength] = useState(filter('minLength'))
  const [maxLength, setMaxLength] = useState(filter('maxLength'))
  const [minExposure, setMinExposure] = useState(filter('minExposure'))
  const [maxCanopy, setMaxCanopy] = useState(filter('maxCanopy'))
  const [maxOffLevel, setMaxOffLevel] = useState(filter('maxOffLevel'))
  /**
   * Whether the planned line's panel is open.
   *
   * There is one line that can be open, and it is always the planned one: picking a found line
   * places the planned line's two points on its anchors. A link with both points opens on it.
   */
  const [bbox, setBbox] = useState(initial.bbox)
  // Google's map zoom is the same web-mercator scale MapLibre uses, so it transfers directly.
  const [zoom, setZoom] = useState(13)
  // OSM by default: paths, roads and place names orient you before you know where you are looking.
  const [basemapMix, setBasemapMix] = useState(
    Math.min(MIX_MAX, Math.max(0, initial.basemapMix ?? MIX_MAX)),
  )
  const [showLines, setShowLines] = useState(initial.showLines ?? true)
  /**
   * Which anchor classes are shown. All three by default: the split exists so a person can put the
   * town away when they want a forest line, not so the app decides for them which they wanted.
   */
  const [kinds, setKinds] = useState<ReadonlySet<LineKind>>(new Set(initial.kinds ?? LINE_KINDS))
  // Closed by default: the control column is 288 px, which is most of a phone screen, and someone
  // arriving has a map to look at before they have anything to filter.
  const [showFilters, setShowFilters] = useRemembered('highline-finder.filters-open', false)
  const [anchorDump, setAnchorDump] = useState<AnchorDump | null>(null)
  const [hotspots, setHotspots] = useState<Hotspots | null>(null)
  const [showHotspots, setShowHotspots] = useState(initial.showHotspots ?? true)
  const [mask, setMask] = useState<MaskCells | null>(null)
  const [tiles, setTiles] = useState<TileUsage | null>(null)
  /**
   * One debug view at a time. A coarse field and a grid of tiles drawn together are unreadable, and
   * the useful comparison is between them rather than of both at once.
   */
  const [debugLayer, setDebugLayer] = useState<DebugLayer>('none')
  /**
   * Where the search looked, off by default. Context for reading the map, not part of the answer,
   * and clutter over ground you are actually studying.
   *
   * The other footprint -- where the search was allowed to stand on a roof -- has no switch of its
   * own. It is only ever the answer to "why are there no urban lines here", so it follows the urban
   * filter: asking for urban lines is the one moment the rectangles they can exist in are worth
   * drawing, and a second switch to say so was a step nobody made the connection through.
   */
  /**
   * Whether elevation is still arriving, so a gap in the profile can be told apart from a hole the
   * survey does not fill. Driven by the events terrain.ts already emits for the map overlay rather
   * than by a second count kept alongside the fetches.
   */
  const [fetchingElevation, setFetchingElevation] = useState(false)
  useEffect(() => {
    let queued = 0
    const off = onWindowActivity((e) => {
      setFetchingElevation(fetchingWindows())
      if (e.state === 'loading') return
      /**
       * One redraw a frame, however many windows land together.
       *
       * Bumping per window is the point -- a line is drawn again as each piece of it arrives
       * instead of staying blank until the last one does -- but the profile is rebuilt from
       * scratch each time, four thousand stations of it, and a prefetch resolving thirty windows
       * at once would rebuild it thirty times in as many milliseconds for the same picture.
       */
      if (queued) return
      queued = requestAnimationFrame(() => {
        queued = 0
        setTerrainVersion((v) => v + 1)
      })
    })
    return () => {
      off()
      if (queued) cancelAnimationFrame(queued)
    }
  }, [])

  const [showAreas, setShowAreas] = useState(initial.showAreas ?? false)
  /**
   * The kept lines, and the spot being worked in. The planner's line is always that spot's active
   * line: a switch of line comes in through `loadLine`, and every change goes back out through the
   * sync below.
   */
  const spots = useSpots({ line: initial.line, name: initial.name, spot: sharedSpot }, (l) => loadLine(l))
  const [line, setLine] = useState<LineSpec>(() =>
    spots.active ? { a: spots.active.a, b: spots.active.b, rig: spots.active.rig, sag: spots.active.sag } : initial.line,
  )
  const loadLine = (l: LineSpec | null) => {
    setOptimizing(false)
    setPlacing(null)
    setLine(l ? { a: l.a, b: l.b, rig: l.rig, sag: l.sag } : NO_LINE)
  }
  useEffect(() => spots.sync(line), [line])
  /** The card is the open line: there is one exactly when a line is open, and closing it closes the line. */
  const open = !!line.a && !!line.b
  const [spotsOpen, setSpotsOpen] = useRemembered('highline-finder.spotsopen', false)
  const activeName = spots.active?.name ?? (spots.open.kind === 'found' ? spots.open.name : null)
  const ownName = activeName && line.a && line.b && activeName !== defaultLineName(line.a, line.b) ? activeName : null
  const [saving, setSaving] = useState(false)
  const [lit, setLit] = useState<Lit | null>(null)
  const [focus, setFocus] = useState<{ bbox: [number, number, number, number]; key: number } | null>(null)
  const focusOn = (s: Spot) => {
    const ends = s.lines.flatMap((l) => [l.a, l.b])
    const lats = ends.map((p) => p.lat)
    const lons = ends.map((p) => p.lon)
    setFocus({ bbox: [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)], key: Date.now() })
  }
  useEffect(() => {
    if (sharedSpot && !initial.bbox && spots.spot) focusOn(spots.spot)
  }, [])
  // Opening a line of a spot shows the spot, which is where its lines are named and kept.
  const openSpotId = spots.spot?.id ?? null
  useEffect(() => {
    if (openSpotId) setSpotsOpen(true)
  }, [openSpotId])
  /** Which line of the open spot is the planner's, and so not drawn among the kept ones. */
  const openIndex = spots.open.kind === 'spot' || spots.open.kind === 'shared' ? spots.open.line : null
  const savedDrawn: SavedDrawn[] = useMemo(() => {
    const o = spots.open
    const openId = o.kind === 'spot' ? o.spot : o.kind === 'shared' ? 'shared' : null
    const groups: [string, SavedDrawn['kind'], SpotLine[]][] = [
      ...spots.lib.spots.map((s): [string, SavedDrawn['kind'], SpotLine[]] => [s.id, 'saved', s.lines]),
      ...(spots.shared ? [['shared', 'shared', spots.shared.lines] as [string, SavedDrawn['kind'], SpotLine[]]] : []),
      ...(spots.lib.draft && o.kind !== 'draft' ? [['draft', 'draft', [spots.lib.draft]] as [string, SavedDrawn['kind'], SpotLine[]]] : []),
    ]
    return groups.flatMap(([id, kind, lines]) =>
      lines.flatMap((l, i) =>
        id === openId && i === openIndex
          ? []
          : [{
              spot: id,
              line: i,
              kind,
              a: l.a,
              b: l.b,
              working: id === openId,
              lit: lit?.spot === id && (lit.line === null || lit.line === i),
            }],
      ),
    )
  }, [spots.lib, spots.shared, spots.open, openIndex, lit])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      e.preventDefault()
      if (e.shiftKey) spots.redo()
      else spots.undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  // null means "as level and as high as the ground allows", the same choice the search makes.
  const [optimizing, setOptimizing] = useState(false)
  /**
   * Which point the next click on the map places, while the "plan a line" button is being followed.
   *
   * The context menu does the same, and nobody finds a context menu without being told -- on a
   * phone not even then. On a map whose only use is placing two points, the way to place them has
   * to be on screen.
   */
  const [placing, setPlacing] = useState<'a' | 'b' | null>(null)
  /**
   * Reach of the run in progress, and the reach the button is offering next.
   *
   * The offer is the whole feature. One click asks "is there something better right here"; while a
   * run's offer still stands, clicking again doubles the reach, so spamming the button is a person
   * saying "look much further" without needing a second control to say it with. Let the offer lapse
   * and the next click is careful again.
   */
  const [reach, setReach] = useState(1)
  const [offer, setOffer] = useState<number | null>(null)
  // Bumped when a terrain fetch actually delivers something new, which is what re-measurement
  // depends on. Keeping it a counter rather than storing the measurement means the planned line is
  // computed, not held in state, so no effect has to write it.
  const [terrainVersion, setTerrainVersion] = useState(0)
  // The same idea for land cover: bumped when an Overpass request delivers a corridor that was
  // missing, which is what makes the planned line re-measure against the roads it just learned of.
  const [coverVersion, setCoverVersion] = useState(0)
  /** Why the elevation for the planned line could not be had, or null while it can. */
  const [terrainFailed, setTerrainFailed] = useState<string | null>(null)
  const [layerError, setLayerError] = useState<string | null>(null)
  /** Whether the pointer is on the lines count, which is the cue to make them easy to spot. */
  const [emphasiseLines, setEmphasiseLines] = useState(false)
  /** Whether the open line fills the window. In the URL, so a link can be sent from that view. */
  const [full, setFull] = useState(initial.full ?? false)
  // Which guide this reader gets: the one for the view they are actually in. `full` can be set
  // without a line to be full of, so both have to hold.
  const guide = useGuide(full && open ? 'line' : 'map')
  /**
   * Following the device, and the last position it gave.
   *
   * A failure switches the toggle back off rather than latching, so pressing it again is a retry --
   * the one thing MapLibre's own control will not do once a prompt has been refused.
   */
  /**
   * Remembered, because it is a choice about the workspace rather than about the map -- the same
   * reason the guide and the filter panel are, and the same reason it is not in the URL: a shared
   * link should not switch on the recipient's location.
   *
   * Restoring it re-prompts where permission was never granted, and that is the honest behaviour:
   * the effect below switches the toggle back off on refusal, so a remembered "on" that the browser
   * declines costs one prompt and lands in the same place as never having asked.
   */
  const [locating, setLocating] = useRemembered('highline-finder.locating', false)
  const [fix, setFix] = useState<Fix | null>(null)
  const [locateError, setLocateError] = useState<string | null>(null)

  useEffect(() => {
    if (!locating) return setFix(null)
    setLocateError(null)
    return watchLocation(setFix, (why) => {
      setLocateError(why)
      setLocating(false)
    })
  }, [locating])
  const load = <T,>(file: string) =>
    fetch(`${import.meta.env.BASE_URL}${file}`).then((r) =>
      r.ok ? (r.json() as Promise<T>) : Promise.reject(new Error(`HTTP ${r.status}`)),
    )

  useEffect(() => {
    if (!DEV_MODE) return
    load<DatasetMeta>('meta.json')
      .then((m) => {
        // A file from an older pipeline would otherwise fail deep inside rendering, which reads as
        // a broken app rather than as stale output.
        if (!m?.regions?.length) throw new Error('no regions in it — re-run `npm run pipeline`')
        setMeta(m)
      })
      .catch((e: unknown) => {
        report('loading meta.json, which describes the run', e)
        setError(failureText(e))
      })
  }, [])

  /**
   * What every line is measured with. The dataset's own in dev mode, so a picked line is measured
   * the way the search measured it; the current defaults otherwise, with no file to wait for.
   */
  const params: Params | null = DEV_MODE ? (meta?.params ?? null) : DEFAULT_PARAMS
  const sagDefault = params ? params.sagRatio * 100 : null
  const sagPct = sagDefault === null ? line.sag : Math.max(SAG_MIN_PCT, line.sag ?? sagDefault)
  const setSagPct = (pct: number) => setLine((l) => ({ ...l, sag: changed(pct, sagDefault) }))
  const setRig = (r: RigHeights | null) => {
    if (spots.editable) setLine((l) => ({ ...l, rig: r }))
  }

  useEffect(() => {
    if (!DEV_MODE) return
    load<{ lines: ByKind<Candidate[]> }>('candidates.json')
      .then((d) => {
        if (!d?.lines?.natural) throw new Error('no lines in it — re-run `npm run pipeline`')
        setLines(d.lines)
      })
      .catch((e: unknown) => {
        report('loading candidates.json, which is every line found', e)
        setError(failureText(e))
      })
  }, [])

  /**
   * The three stored lists as one, with the kind each list implies written back onto its lines.
   *
   * The file omits it per line because the list already says it -- see Dataset.lines -- so this is
   * where the two halves of that arrangement meet. Everything downstream then sees one shape and
   * one list, exactly as it did when there was only ever one.
   *
   * Crossings are repaired here for the same reason: a dataset written before crossings became a
   * stretch of span carries neither end of one, and one place to put that right beats a fallback at
   * every point that reads them.
   */
  const candidates = useMemo(
    () =>
      lines
        ? LINE_KINDS.flatMap((kind) =>
            lines[kind].map((c) => ({
              ...c,
              kind,
              crossings: c.crossings?.map(withSpan),
            })),
          )
        : [],
    [lines],
  )

  /**
   * Sag is re-applied client side rather than baked in: the stored profile carries terrain and
   * canopy heights, and the two attachment heights give the chord, so the line at any sag follows
   * without the raster. Only tightening is offered -- candidates the pipeline rejected are absent
   * from the dataset, so a lower sag would report an incomplete set as if it were complete.
   */
  const rescored = useMemo(() => {
    if (!meta || sagPct === null) return []
    // A sag looser than the dataset's leaves its lines where the dataset put them.
    const generated = meta.params.sagRatio * 100
    if (sagPct <= generated) return candidates
    return candidates
      .map((c) => rescoreAtSag(c, sagPct / 100, meta.params))
      .filter((c): c is Candidate => c !== null)
  }, [meta, candidates, sagPct])

  /**
   * The "where is anything possible at all" layer, loaded eagerly and shown by default: it is 6 KB,
   * and at the zoom the map opens at it is the only layer that says anything useful.
   */
  /**
   * Cycles the debug views: the coarse pre-pass, then what was actually fetched per source tile for
   * terrain and for surface. Off by default -- these are views of the pipeline, not of the terrain.
   */
  const DEBUG_ORDER =
    ['none', 'coarse', 'terrain', 'surface', 'buildings', 'roads', 'regions'] as const
  /** Which gitignored file each view needs. Region vintage rides along in candidates.json. */
  const DEBUG_FILE: Partial<Record<DebugLayer, 'mask.json' | 'tiles.json'>> = {
    coarse: 'mask.json',
    terrain: 'tiles.json',
    surface: 'tiles.json',
    buildings: 'tiles.json',
    roads: 'tiles.json',
  }
  const cycleDebug = () => {
    const next = DEBUG_ORDER[(DEBUG_ORDER.indexOf(debugLayer) + 1) % DEBUG_ORDER.length]!
    setDebugLayer(next)
    setLayerError(null)
    const file = DEBUG_FILE[next]
    if (!file || (file === 'mask.json' ? mask : tiles)) return
    fetch(`${import.meta.env.BASE_URL}${file}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => (file === 'mask.json' ? setMask(d) : setTiles(d)))
      .catch((e: unknown) => {
        report(`loading ${file} for the ${next} debug layer`, e)
        setLayerError(`${file}: ${failureText(e)} — run \`npm run pipeline\` if it is missing`)
      })
  }

  /**
   * Which of the per-tile questions the squares are answering, or null when the current view is not
   * one of them. Both the source and the colouring key off this, so they cannot drift apart.
   */
  const tileLayer: TileLayer | null =
    debugLayer === 'terrain' || debugLayer === 'surface' ||
    debugLayer === 'buildings' || debugLayer === 'roads'
      ? debugLayer
      : null

  const DEBUG_LABELS: Record<DebugLayer, string> = {
    none: 'debug layers',
    coarse: 'coarse pre-pass',
    terrain: 'terrain tiles',
    surface: 'surface tiles',
    buildings: 'buildings',
    roads: 'road kills',
    regions: 'region vintage',
  }

  useEffect(() => {
    if (!DEV_MODE) return
    fetch(`${import.meta.env.BASE_URL}hotspots.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setHotspots)
      .catch((e: unknown) => {
        report('loading hotspots.json', e)
        setLayerError(`hotspots.json: ${failureText(e)} — run \`npm run pipeline\` if it is missing`)
      })
  }, [])

  /**
   * The selected kinds' spots, narrowed to those a line could still pass the filters at.
   *
   * The kinds are clustered independently in the pipeline, so a place where both a natural and an
   * urban line work is a spot in both. Concatenating can therefore put two spots within a cluster
   * radius of each other -- which is the honest picture: the heatmap is showing two different
   * answers that happen to share a hillside, and it burns brighter where both hold.
   *
   * Each filter is tested against the matching bound the spot carries, one at a time. A spot with a
   * 400 m line and a separate very exposed 90 m one survives a filter asking for both at once, and
   * that is accepted: the alternative is shipping the lines themselves, which is what the layer
   * exists to avoid. Wrong in the generous direction only -- a spot is never hidden while a line
   * there still matches.
   *
   * The sag slider is the one filter this cannot follow. It re-evaluates every line against a
   * different sag before the others are applied, and the bounds here were measured at the sag the
   * dataset was generated with.
   */
  const shownHotspots = useMemo((): DrawnSpots | null => {
    if (!hotspots) return null
    const passes = (h: HotspotArrays, i: number) =>
      h.score[i]! >= minScore &&
      h.lengthMax[i]! >= minLength &&
      h.lengthMin[i]! <= maxLength &&
      h.exposureMax[i]! >= minExposure &&
      h.canopyMin[i]! * 100 <= maxCanopy &&
      h.offLevelMin[i]! * 100 <= maxOffLevel
    // flatMap rather than push(...spread): the spots are already in the thousands, and spreading an
    // array of that size as arguments is what already broke the endpoint pooling in the pipeline.
    const kept = LINE_KINDS.filter((k) => kinds.has(k)).map((k) => {
      const h = hotspots[k]
      return { h, at: h.lat.map((_, i) => i).filter((i) => passes(h, i)) }
    })
    const column = (name: keyof DrawnSpots) =>
      kept.flatMap(({ h, at }) => at.map((i) => h[name][i]!))
    return { lat: column('lat'), lon: column('lon'), count: column('count'), score: column('score') }
  }, [
    hotspots, kinds, minScore, minLength, maxLength, minExposure, maxCanopy, maxOffLevel,
  ])

  const customUtm = useMemo(() => {
    if (!line.a || !line.b) return null
    const [ae, an] = toUtm33(line.a.lat, line.a.lon)
    const [be, bn] = toUtm33(line.b.lat, line.b.lon)
    return { a: { e: ae, n: an }, b: { e: be, n: bn } }
  }, [line.a, line.b])

  // The only job of this effect is fetching. It deliberately does not compute or store the
  // measurement: an effect that writes what another effect reads is how this file previously
  // managed to feed itself.
  useEffect(() => {
    if (!customUtm || !params) return
    let stale = false
    // This effect runs on every move, so the line supplies itself as it goes. The optimiser is the
    // one thing that cannot work that way -- see wanderMargin.
    const span = Math.hypot(customUtm.b.e - customUtm.a.e, customUtm.b.n - customUtm.a.n)
    const { a, b } = customUtm
    // The corridor, plus a small halo at each anchor. The corridor is what the measurement reads;
    // the halo is what stops a drag stuttering, since an anchor whose own ground has not landed has
    // no attachment height and produces no line at all rather than a partial one. See
    // DRAG_LOOKAHEAD.
    Promise.all([
      ensureTerrain(a, b, measuredHalfWidth(span, params)),
      ensureTerrain(a, a, DRAG_LOOKAHEAD),
      ensureTerrain(b, b, DRAG_LOOKAHEAD),
    ])
      .then(() => {
        // No version bump here: every window announces its own arrival, and the subscription above
        // is what turns that into a redraw. Waiting for the whole set is exactly what kept a chart
        // blank while most of its ground was already in hand.
        if (!stale) setTerrainFailed(null)
      })
      .catch((e: unknown) => {
        report('fetching elevation for the planned line', e)
        if (!stale) setTerrainFailed(failureText(e))
      })
    return () => {
      stale = true
    }
  }, [customUtm, params])

  /**
   * The layers a planned line is measured against, beyond the two elevation rasters.
   *
   * Roads are null until the corridor's blocks have been read, and null is not "no roads" -- it is
   * "not yet known". `roadState` reports which of the three it is, so the panel never presents an
   * unchecked line as a valid one. Failure now means only one thing: the blocks ship with the app,
   * so a block the index lists and the server will not serve is a broken deployment.
   */
  const scene = useMemo(() => {
    void coverVersion
    return { roofs, roads: customUtm ? roadsFor(customUtm.a, customUtm.b) : null, water }
  }, [customUtm, coverVersion])

  const roadState: 'ok' | 'loading' | 'failed' =
    !customUtm || scene.roads ? 'ok' : coverFailed(customUtm.a, customUtm.b) ? 'failed' : 'loading'

  /**
   * The planned line, measured by the same code the search uses.
   *
   * Derived rather than stored, so dragging an anchor cannot start a render loop: the two anchor
   * positions and the sag setting fully determine it, and `terrainVersion` only changes when a
   * fetch delivers a window that was genuinely missing.
   */
  const planned: PlannedLine | null = useMemo(() => {
    if (!params || !customUtm || sagPct === null) return null
    void terrainVersion
    return planLine(
      customUtm.a,
      customUtm.b,
      groundSampler,
      surfaceSampler,
      sagPct / 100,
      // The viewer's resolution, like the selected line's. The optimiser calls planLine too and
      // deliberately does not get this: it evaluates dozens of positions a step, and it is choosing
      // where to put an anchor rather than reporting what is under one.
      { ...params, ...VIEWER_PROFILE },
      line.rig,
      scene,
      // A dragged anchor crosses into ground still being fetched constantly, and a chart of most of
      // the line beats a spinner over all of it. What is missing comes back as a count and the panel
      // says so -- see PlannedLine.unmeasured.
      {
        tolerateGaps: true,
        canopyKnown:
          canopyOver(
            customUtm.a,
            customUtm.b,
            Math.hypot(customUtm.b.e - customUtm.a.e, customUtm.b.n - customUtm.a.n),
            params,
          ) !== 'none',
      },
    )
  }, [params, customUtm, sagPct, terrainVersion, line.rig, scene])

  /**
   * The spot's other lines that share the 3D view with this one, each measured like it.
   *
   * Keyed on those lines alone, so dragging the active one does not measure them all again.
   */
  const companionKey = JSON.stringify(
    (spots.spot?.lines ?? []).map((l, i) => (i === openIndex ? null : [l.a, l.b, l.rig, l.sag])),
  )
  const companionLines = useMemo(() => {
    if (!customUtm) return []
    const mid = { e: (customUtm.a.e + customUtm.b.e) / 2, n: (customUtm.a.n + customUtm.b.n) / 2 }
    return (spots.spot?.lines ?? []).flatMap((l, index) => {
      if (index === openIndex) return []
      const [a, b] = [l.a, l.b].map((p) => {
        const [e, n] = toUtm33(p.lat, p.lon)
        return { e, n }
      }) as [{ e: number; n: number }, { e: number; n: number }]
      if ([a, b].some((p) => Math.hypot(p.e - mid.e, p.n - mid.n) > COMPANION_REACH)) return []
      return [{ index, a, b, rig: l.rig, sag: l.sag }]
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companionKey, customUtm && Math.round(customUtm.a.e / 50), customUtm && Math.round(customUtm.a.n / 50)])
  useEffect(() => {
    if (!params) return
    for (const c of companionLines) {
      const span = Math.hypot(c.b.e - c.a.e, c.b.n - c.a.n)
      ensureTerrain(c.a, c.b, measuredHalfWidth(span, params)).catch((e: unknown) =>
        report('fetching elevation for the other lines of this spot', e),
      )
    }
  }, [companionLines, params])
  const companions = useMemo(() => {
    if (!params || sagDefault === null) return []
    void terrainVersion
    return companionLines.flatMap((c) => {
      const sag = Math.max(SAG_MIN_PCT, c.sag ?? sagDefault) / 100
      const measured = planLine(c.a, c.b, groundSampler, surfaceSampler, sag, params, c.rig, { roofs, water }, {
        tolerateGaps: true,
      })
      if (!measured) return []
      const m = measured.candidate
      return [{ index: c.index, a: c.a, b: c.b, anchorA: m.a.anchor, anchorB: m.b.anchor, sagRatio: m.length > 0 ? m.sag / m.length : 0 }]
    })
  }, [companionLines, params, sagDefault, terrainVersion])

  /**
   * A placed line with no measurement yet. The details panel renders regardless, blank and with a
   * placeholder chart, so placing a line always produces the panel it is going to fill.
   */
  const planPending = open && !planned

  /** Adopts a new pair of planned points. */
  const commit = (next: CustomPoints & Partial<LineSpec>) => {
    // Any hand movement ends an optimisation: it is descending from a point the user has left.
    setOptimizing(false)
    const complete = !!next.a && !!next.b
    setLine((l) => ({ ...l, ...next, rig: complete ? (next.rig === undefined ? l.rig : next.rig) : null }))
  }

  /**
   * What a click on the map asks for: a found line, the planned line, or neither.
   *
   * A found line is not selected as itself. Its two anchors become the planned line's, with the
   * rig heights the search chose, so it is measured live like any other and every control in the
   * panel works on it without first having to turn it into something else.
   */
  const select = (id: string | null) => {
    if (spots.holding) return
    if (id === null) return clearCustom()
    if (id === PLANNED_ID) return
    const found = visible.find((c) => c.id === id)
    if (!found) return
    const rigged = Number.isFinite(found.a.aFrame) && Number.isFinite(found.b.aFrame)
    // Picking is looking: it changes no kept line, the draft line included.
    spots.viewFound()
    commit({
      a: { lat: found.a.lat, lon: found.a.lon },
      b: { lat: found.b.lat, lon: found.b.lon },
      rig: rigged ? { a: found.a.aFrame, b: found.b.aFrame } : null,
    })
  }

  /** Turns one anchor class on or off. All three off is a legitimate setting: no lines. */
  const toggleKind = (kind: LineKind) =>
    setKinds((cur) => {
      const next = new Set(cur)
      if (!next.delete(kind)) next.add(kind)
      return next
    })

  /**
   * One step of the button's placement: A starts a new line, B finishes it and opens it. The line
   * already on the map survives until the first tap, so changing your mind costs nothing.
   */
  const placeNext = (at: LatLon) => {
    if (placing === 'a') {
      spots.beginNewLine()
      commit({ a: at, b: null, sag: null })
      setPlacing('b')
    } else {
      commit({ a: line.a, b: at })
      setPlacing(null)
    }
  }

  /** Places one end of the planned line. */
  const setCustomPoint = (which: 'a' | 'b', at: LatLon | null) => {
    if (spots.editable) return commit(place(line, which, at))
    spots.beginNewLine()
    commit({ a: which === 'a' ? at : null, b: which === 'b' ? at : null, sag: null })
  }

  // One call, not two setCustomPoint calls: both would read the same pre-update `custom`, so the
  // second would put the first end back.
  const clearCustom = () => {
    if (spots.holding) return
    commit({ a: null, b: null })
    spots.close()
  }

  const saveButton = (
    <button className="keep" onClick={() => { setSpotsOpen(true); setSaving(true) }} title="Keep this line, on its own or with others nearby">
      save
    </button>
  )
  const editButton = (label: string, title: string) => (
    <button className="keep" data-edit="true" onClick={() => spots.edit(line)} title={title}>{label}</button>
  )
  /** The card's buttons for keeping and changing the line, which depend on where it lives. */
  const keep = (() => {
    const o = spots.open
    if (o.kind === 'draft') {
      return (
        <>
          {saveButton}
          <button className="keep" data-saved="true" onClick={spots.discardDraft} title="Throw this draft line away (undo brings it back)">
            discard
          </button>
        </>
      )
    }
    if (o.kind === 'found') {
      return (
        <>
          {saveButton}
          {spots.lib.draft
            ? editButton('edit (replaces draft)', 'Move its anchors and rig: it becomes your draft line, in place of the one you have (undo brings that back)')
            : editButton('edit', 'Move its anchors and rig: it becomes your draft line')}
        </>
      )
    }
    if (o.kind !== 'spot') return null
    return (
      <>
        {o.editing ? (
          <button className="keep" data-edit="true" onClick={spots.done} title="Stop editing; the line is saved as it is">
            done editing
          </button>
        ) : (
          editButton('edit', 'Move its anchors and rig; every change is saved as you make it')
        )}
      </>
    )
  })()

  /** Dragging an anchor handle. */
  const moveAnchor = (which: 'a' | 'b', at: LatLon) => {
    if (spots.editable) commit(place(line, which, at))
  }

  /**
   * Swaps which end is called A.
   *
   * The line does not move: the profile is read from the other end, the chart's left becomes its
   * right and the bearing turns through 180 degrees. Worth a button because which end is A decides
   * how the whole view is laid out, and there is no other way to choose it -- on a picked line it
   * was decided by whichever anchor the search happened to reach first. Rig heights go with their
   * ends.
   */
  const flipAnchors = () => {
    if (!line.a || !line.b || !spots.editable) return
    commit({ a: line.b, b: line.a, rig: line.rig && { a: line.rig.b, b: line.rig.a } })
  }

  /**
   * Debug overlay of every anchor the openness scan kept. Development only: anchors.json is
   * gitignored and never deployed, and this is diagnostics for the scan rather than a feature.
   * Fetched on first use so the normal load never pays for ~25k points.
   */
  const toggleAnchors = () => {
    if (anchorDump) {
      setAnchorDump(null)
      return
    }
    setLayerError(null)
    fetch(`${import.meta.env.BASE_URL}anchors.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setAnchorDump)
      .catch((e: unknown) => {
        report('loading anchors.json', e)
        setLayerError(`anchors.json: ${failureText(e)} — run \`npm run pipeline\` if it is missing`)
      })
  }

  const visible = useMemo(() => {
    if (!lines) return []
    return rescored
      .filter(
        (c) =>
          kinds.has(c.kind) &&
          c.score >= minScore &&
          c.length >= minLength &&
          c.length <= maxLength &&
          c.exposure >= minExposure &&
          c.canopyBlockedFraction * 100 <= maxCanopy &&
          c.offLevelRatio * 100 <= maxOffLevel,
      )
      .sort((a, b) => b.score - a.score)
  }, [lines, rescored, kinds, minScore, minLength, maxLength, minExposure, maxCanopy, maxOffLevel])

  /**
   * How much of what is switched on is actually on screen.
   *
   * A tester who zooms to their own village sees empty ground beside a button claiming twenty-two
   * thousand lines, and cannot tell "nothing here" from "your filters hid it". So the button says
   * both figures -- but only when they differ, because at the opening view they are the same number
   * twice and a count of everything out of everything is noise.
   *
   * Lines only. A hotspot is a cluster whose size depends on the clustering radius rather than on
   * anything in the terrain, so counting them measures the algorithm and not the ground -- the
   * layer is there to be looked at, not tallied.
   */
  const view = bbox as Bbox | null
  const linesHere = useMemo(
    () => (view ? visible.filter((c) => touches(view, c.a, c.b)).length : visible.length),
    [view, visible],
  )
  /**
   * Whether the view has left the ground everything is known about.
   *
   * In dev mode that is the searched ground. Panning off it is not an error and nothing stops it --
   * the basemap keeps working, so the map looks fine and is simply empty, which reads as "this tool
   * found nothing in my town" rather than "this tool has never looked at my town". Measured against
   * the areas actually searched rather than a rectangle round the state, so it is the honest
   * boundary: overlap even one of them and there was a search here.
   *
   * Without the search there is nothing to have left but the surface model: a line placed by hand
   * is measured anywhere a survey reaches, and what changes is only whether trees are known about.
   */
  const offMap = useMemo(() => {
    if (!view) return null
    if (DEV_MODE) {
      if (!meta) return null
      const searched = meta.regions.some((r) =>
        r.aois.some((a) => overlaps(view, [a.south, a.west, a.north, a.east])),
      )
      if (searched) return null
    }
    // Two different nothings. Ground the search never covered can still be measured by hand, and
    // saying only "nothing here" would send someone away from a tool that would have answered them.
    const [e, n] = toUtm33((view[0] + view[2]) / 2, (view[1] + view[3]) / 2)
    const source = sourceFor(e, n)
    // What will be measured here, said before the measurement rather than after it. The three
    // tiers the guide's coverage map draws are the same question, and the guide is shut by the
    // time anyone has panned this far.
    if (!source) return { where: 'nothing' as const, surface: false }
    if (!DEV_MODE && source.hasSurface) return null
    return { where: 'plannable' as const, surface: source.hasSurface }
  }, [view, meta])

  // The planned line is exempt from every filter and from the validity gate, by design.
  const selected = open ? (planned?.candidate ?? null) : null

  /**
   * The optimiser, run as an animation rather than to completion.
   *
   * The loop reads the live positions from a ref instead of taking `line` as a dependency: an
   * effect that both reads and writes the same state is how this file previously managed to feed
   * itself, and here it would do so sixty times a second rather than once.
   */
  const lineRef = useRef(line)
  lineRef.current = line

  /** Ends a run, however it ended, and puts the next reach up on the button. */
  const endRun = () => {
    setOptimizing(false)
    setOffer(reach * 2)
  }

  useEffect(() => {
    if (offer === null) return
    const timer = setTimeout(() => setOffer(null), OFFER_MS)
    return () => clearTimeout(timer)
  }, [offer])

  useEffect(() => {
    if (!optimizing || !params || sagPct === null || !customUtm) return
    const origin = customUtm
    let timer: ReturnType<typeof setTimeout>
    let stopped = false
    // Carried across ticks. Restarting it each frame would spend the frame re-walking the halving
    // ladder from a metre back down to a centimetre instead of moving the line -- see optimizeFrame.
    let spacing = startingSpacing(reach)

    const tick = async () => {
      if (stopped) return
      const live = lineRef.current
      if (!live.a || !live.b) return endRun()
      const [ae, an] = toUtm33(live.a.lat, live.a.lon)
      const [be, bn] = toUtm33(live.b.lat, live.b.lon)
      // Collected for the frame and handed over in one go, so the overlay rewrites its source once
      // per frame rather than once per measurement.
      const probes: number[] = []
      let advance
      try {
        advance = await optimizeFrame(
          { a: { e: ae, n: an }, b: { e: be, n: bn } },
          {
            origin,
            ground: groundSampler,
            surface: surfaceSampler,
            sagRatio: sagPct / 100,
            params,
            rig: line.rig,
            scene,
            reach,
            onProbe: (e, n) => probes.push(e, n),
            // One honeycomb, around wherever the walk has got to, before every scan it makes.
            // Nothing is fetched for ground the line never reaches, and a step that stays inside
            // the window it started in -- almost all of them -- asks for nothing.
            ensure: (plan, at) =>
              ensureTerrain(
                plan.a,
                plan.b,
                scanMargin(Math.hypot(plan.b.e - plan.a.e, plan.b.n - plan.a.n), at, params),
              ),
          },
          spacing,
        )
      } catch (e: unknown) {
        report('fetching elevation for the optimiser to walk over', e)
        if (stopped) return
        setTerrainFailed(failureText(e))
        return endRun()
      }
      if (stopped) return
      emitProbes(probes)
      if (!advance) return endRun()
      spacing = advance.spacing
      const { plan } = advance
      setLine((l) => ({ ...l, a: toWgs84(plan.a.e, plan.a.n), b: toWgs84(plan.b.e, plan.b.n) }))
      timer = setTimeout(() => void tick(), 100)
    }

    timer = setTimeout(() => void tick(), 0)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
    // customUtm is read once, as the origin the wander is measured from, so it is deliberately not
    // a dependency -- otherwise every step would restart the run and reset that origin. `reach` is
    // set in the same click that starts the run, so it is already current when this effect runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optimizing, params, sagPct, line.rig])

  const shownProfile = useMemo(() => {
    if (!selected?.profile || sagPct === null || !params) return null
    return unpackProfile(
      selected.profile,
      selected.length,
      selected.a.anchor,
      selected.b.anchor,
      sagPct / 100,
      params,
    )
  }, [selected, sagPct, params])

  /**
   * Ground a little way past each anchor, for the chart to draw behind the span.
   *
   * A profile that stops dead at the anchor says nothing about what that anchor is standing on the
   * edge of, and whether the ground falls away past it or carries on flat is most of what tells a
   * cliff top from a field. Read from the same samplers everything else uses, so it costs no fetch:
   * the band already loaded for measuring the line reaches this far past its ends.
   *
   * Samples over ground nobody has covered are dropped rather than guessed, so a wing simply stops
   * where the survey does.
   */
  const wings = useMemo(() => {
    const c = selected
    if (!c || !(c.length > 0)) return null
    const margin = c.length * WING_FRACTION
    const [de, dn] = [(c.b.e - c.a.e) / c.length, (c.b.n - c.a.n) / c.length]
    const at = (d: number) => ({ e: c.a.e + de * d, n: c.a.n + dn * d })
    const arm = (from: number, to: number) => {
      // Buildings and water from the same reader the measured stretch uses, over the wing's own two
      // ends, so the two halves of the chart cannot disagree about what is a building.
      const cover = coverAlong(at(from), at(to), WING_POINTS + 1)
      const out: WingSample[] = []
      for (let i = 0; i <= WING_POINTS; i++) {
        const d = from + ((to - from) * i) / WING_POINTS
        const { e, n } = at(d)
        const ground = groundSampler.sample(e, n)
        if (Number.isNaN(ground)) continue
        const surface = surfaceSampler.sample(e, n)
        out.push({
          d,
          ground,
          surface: Number.isNaN(surface) ? ground : surface,
          kind: cover.kind[i]!,
          bare: cover.bare[i]!,
        })
      }
      return out
    }
    const before = arm(-margin, 0)
    const after = arm(c.length, c.length + margin)
    // No margin at all rather than an empty strip: the chart's width is worth more than a gesture
    // toward ground that was never measured.
    if (before.length < 2 && after.length < 2) return null
    return { before, after, margin }
  }, [selected, terrainVersion, coverVersion])

  const shownEnds = useMemo(
    () =>
      selected && { a: { e: selected.a.e, n: selected.a.n }, b: { e: selected.b.e, n: selected.b.n } },
    [selected],
  )

  /**
   * Whether the canopy figures for this line were measured, estimated, or describe bare earth.
   *
   * Where no survey's surface model can be read the canopy map's estimate stands in, and where that
   * fails too the surface is the terrain, so every figure stays finite. Either is fine as long as it
   * is said out loud.
   */
  const canopy = useMemo(
    (): Canopy =>
      !shownEnds || !params
        ? 'measured'
        : canopyOver(shownEnds.a, shownEnds.b, selected!.length, params),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shownEnds, params, terrainVersion],
  )

  /**
   * Land cover along whatever line is on screen: water for the chart to draw, and roads for the
   * planner to hold the line to.
   *
   * Debounced, because dragging an anchor moves the line many times a second and this is a public
   * Overpass instance. Buildings need no equivalent -- they arrive with the elevation, since they
   * are part of the measurement rather than an annotation on it.
   *
   * One fetch serves both, because the shown line is always the planned one.
   */
  useEffect(() => {
    if (!shownEnds) return
    const timer = setTimeout(() => {
      ensureCover(shownEnds.a, shownEnds.b).catch((e: unknown) =>
        report('loading roads and water along the shown line', e),
      )
    }, 300)
    return () => clearTimeout(timer)
  }, [shownEnds])

  /**
   * Everything measured against roads and water is rebuilt whenever any of it lands.
   *
   * Not on the corridor fetch above resolving: the 3D view asks for the square around the line, so
   * whichever of the two asked second was told nothing had arrived and this never fired. The
   * profile then kept the clearance it was built with -- three metres over what the chart was by
   * then drawing as a lake.
   */
  useEffect(() => onCoverChange(() => setCoverVersion((v) => v + 1)), [])

  const cover = useMemo(() => {
    if (!shownEnds || !shownProfile) return null
    void coverVersion
    return coverAlong(shownEnds.a, shownEnds.b, shownProfile.length)
  }, [shownEnds, shownProfile, coverVersion])

  /** Which ends stand on a roof rather than on the ground, so the panel can say so. */
  const onRoof = useMemo(
    () =>
      shownEnds && {
        a: onBuilding(shownEnds.a.e, shownEnds.a.n),
        b: onBuilding(shownEnds.b.e, shownEnds.b.n),
      },
    [shownEnds],
  )

  /**
   * The URL, rewritten in place as the view changes.
   *
   * The dataset's controls are written only in dev mode. Outside it they cannot be changed, and a
   * link from a dev session would otherwise carry its filters through every reshare.
   */
  const search = useMemo(
    () =>
      toSearch({
        bbox,
        line,
        name: ownName,
        basemapMix: changed(basemapMix, MIX_MAX),
        showAreas: changed(showAreas, false),
        full: changed(full, false),
        ...(DEV_MODE
          ? {
              showLines: changed(showLines, true),
              showHotspots: changed(showHotspots, true),
              // Every class on is the default, so only a narrowed selection is worth a parameter.
              kinds: kinds.size === LINE_KINDS.length ? null : LINE_KINDS.filter((k) => kinds.has(k)),
              filters: movedFilters({
                minScore, minLength, maxLength, minExposure, maxCanopy, maxOffLevel,
              }),
            }
          : { showLines: null, showHotspots: null, kinds: null, filters: {} }),
      }),
    [
      bbox, line, ownName, basemapMix, showLines, showHotspots, showAreas, full,
      kinds, minScore, minLength, maxLength, minExposure, maxCanopy, maxOffLevel,
    ],
  )

  useEffect(() => {
    // replaceState, not pushState: panning the map should not fill the back button.
    history.replaceState(null, '', search ? `?${search}` : window.location.pathname)
  }, [search])

  if (error) return <div className="loading">Failed to load the dataset &mdash; {error}</div>

  /**
   * Everything below tolerates there being no dataset yet, and that is the point.
   *
   * candidates.json is four megabytes over the wire, and in dev mode the whole page used to be one
   * `Loading…` in the corner until it landed. Nothing about the map needs it: the basemaps, the
   * borders, the terrain probe and placing a line by hand all work on their own, so they are on
   * screen within a frame and the found lines drop in on top when they arrive. Every readout that
   * genuinely does depend on the file says so by omitting its figure rather than by blocking.
   */
  const regions = meta?.regions ?? []
  /**
   * Where each slider's track ends. Null until meta.json has landed, which is nearly at once.
   *
   * Every end comes out of the metadata rather than off the lines: the pipeline already knows the
   * longest line it found and writes the figure down, so the panel is fitted to the dataset without
   * having to hold it. That is what lets the filters work while the lines are still arriving.
   */
  const bounds =
    meta && sagPct !== null
      ? {
          // The filter slider cannot go looser than the dataset, whatever the line's own slider says.
          sag: Math.max(sagPct, meta.params.sagRatio * 100),
          sagFloor: meta.params.sagRatio * 100,
          maxScore: meta.ranges.score,
          minLen: Math.floor(meta.params.minLength),
          maxLen: meta.ranges.length,
          maxExp: meta.ranges.exposure,
          // The pipeline already caps offlevel, so the slider only needs to reach that cap.
          offLevelCap: Math.ceil(meta.params.maxOffLevelRatio * 100 * 10) / 10,
        }
      : null

  /**
   * How many of the filter panel's controls are narrowing what is on the map.
   *
   * On the closed button, because a panel that is shut can still be hiding most of the dataset and
   * "why is there nothing here" is otherwise unanswerable without opening it. Counted against each
   * control's most permissive setting rather than against its initial one: a filter is active when
   * it is throwing something away, and the two differ for sag, whose floor is whatever the dataset
   * was generated at.
   *
   * Sag and the anchor classes count, for that reason -- both drop lines from the map as surely as
   * the sliders under the Filters heading do, whichever heading they sit under.
   */
  const activeFilters = useMemo(() => {
    const moved = movedFilters({
      minScore, minLength, maxLength, minExposure, maxCanopy, maxOffLevel,
    })
    const tighterSag = !!bounds && sagPct !== null && sagPct > bounds.sagFloor + 1e-9
    return Object.keys(moved).length + (tighterSag ? 1 : 0) + (kinds.size < LINE_KINDS.length ? 1 : 0)
  }, [minScore, minLength, maxLength, minExposure, maxCanopy, maxOffLevel, bounds, sagPct, kinds])

  return (
    <>
      <header ref={header}>
        <img className="logo" src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" />
        <h1><Label full="Highline Finder" short="HF" /></h1>
        {bbox && (
          <a
            className="external gm"
            href={`https://www.google.com/maps/@${((bbox[0] + bbox[2]) / 2).toFixed(6)},${(
              (bbox[1] + bbox[3]) / 2
            ).toFixed(6)},${zoom.toFixed(2)}z/data=!3m1!1e3`}
            target="_blank"
            rel="noreferrer"
            title="Open this view in Google Maps satellite imagery"
          >
            <Label full="Google Maps ↗" short="GM ↗" />
          </a>
        )}
        <span className="spacer" />
        <a
          className="external gh"
          href="https://github.com/ErikBrendel/highline-finder"
          target="_blank"
          rel="noreferrer"
          title="Source code, and how the search works"
        >
          <Label full="GitHub ↗" short="GH ↗" />
        </a>
        <button
          className="spotsbtn"
          data-active={spotsOpen || undefined}
          onClick={() => setSpotsOpen(!spotsOpen)}
          title="Lines you have kept"
        >
          <Label full={`My lines${spots.lib.spots.length ? ` (${spots.lib.spots.length})` : ''}`} short="Mine" />
        </button>
        <ShareButton className="share" />
        <button
          className="guidebtn"
          onClick={guide.show}
          title="What this is, where the data comes from, and how to use it"
          aria-label="About Highline Finder"
        >
          i
        </button>
      </header>

      <div className="layout">
        {spotsOpen && (
          <SpotsPanel
            spots={spots}
            line={line}
            centre={bbox && { lat: (bbox[0] + bbox[2]) / 2, lon: (bbox[1] + bbox[3]) / 2 }}
            saving={saving}
            onSaving={setSaving}
            onLit={setLit}
            onFocus={focusOn}
            onAddLine={() => setPlacing('a')}
            onClose={() => {
              setSpotsOpen(false)
              setSaving(false)
            }}
          />
        )}
        <div className="mapwrap">
          <div className="controls">
          <div className="basemaps">
            <input
              type="range"
              min={0}
              max={MIX_MAX}
              step={0.1}
              value={basemapMix}
              aria-label="basemap blend"
              onChange={(e) => setBasemapMix(Number(e.target.value))}
            />
            <div className="ticks">
              {BASEMAPS.map((b, i) => (
                <button
                  key={b.id}
                  data-active={Math.abs(basemapMix - i) < 0.05}
                  onClick={() => setBasemapMix(i)}
                >
                  {b.label}
                </button>
              ))}
            </div>
          </div>

          {DEV_MODE && (
          <div className="toggles">
            {/* Pointing at the count is the natural gesture when hunting for the lines it counts,
                so it is also what swells them. Focus as well as hover, for a keyboard. */}
            <button
              data-active={showLines}
              onClick={() => setShowLines(!showLines)}
              onPointerEnter={() => setEmphasiseLines(true)}
              onPointerLeave={() => setEmphasiseLines(false)}
              onFocus={() => setEmphasiseLines(true)}
              onBlur={() => setEmphasiseLines(false)}
            >
              {!lines ? (
                <Spinner label="lines" />
              ) : zoom < LINES_FROM ? (
                // Below this zoom the layer draws nothing, so a count of what is "here" would be a
                // count of things nobody can see. Say why the map is bare instead.
                `${visible.length.toLocaleString()} lines · zoom in`
              ) : (
                `${here(linesHere, visible.length)} lines`
              )}
            </button>
            <button data-active={showHotspots} onClick={() => setShowHotspots(!showHotspots)}>
              hotspots
            </button>
            {/* anchors.json is gitignored, so this only exists where the pipeline has run.
                Vite folds the constant away, dropping the button from the bundle entirely. */}
            {import.meta.env.DEV && (
              <button data-active={!!anchorDump} onClick={toggleAnchors}>
                {anchorDump ? `${anchorDump.lat.length.toLocaleString()} anchors` : 'anchors'}
              </button>
            )}
            {/* Dev only, like the anchor overlay: mask.json and tiles.json are gitignored, and
                these are views of the pipeline rather than features. Vite folds the constant away,
                so the fetches and the legend leave the bundle entirely. */}
            {import.meta.env.DEV && (
              <button data-active={debugLayer !== 'none'} onClick={cycleDebug}>
                {DEBUG_LABELS[debugLayer]}
              </button>
            )}
            {/* The superchunk grid is how the search was organised, not something a visitor is
                looking for. Vite folds the constant away, so the button leaves the bundle. */}
            {import.meta.env.DEV && (
              <button data-active={showAreas} onClick={() => setShowAreas(!showAreas)}>
                {meta ? `${regions.length} areas` : 'areas'}
              </button>
            )}
            <button
              data-active={showFilters || activeFilters > 0}
              onClick={() => setShowFilters(!showFilters)}
              title={
                activeFilters > 0
                  ? `${activeFilters} filter${activeFilters === 1 ? '' : 's'} narrowing the map`
                  : 'Nothing is being filtered out'
              }
            >
              filters
              {activeFilters > 0 && <span className="count">{activeFilters}</span>}
            </button>
          </div>
          )}
          {layerError && <div className="togglenote">{layerError}</div>}
          {locateError && <div className="togglenote">{locateError}</div>}
          {import.meta.env.DEV && debugLayer !== 'none' && (
            <DebugLegend
              layer={debugLayer}
              mask={mask}
              tiles={tiles}
              regions={regions}
            />
          )}

          {DEV_MODE && showFilters && !bounds && (
            <div className="filters">
              <div className="note" style={{ marginBottom: 0 }}>
                Every range here is fitted to the dataset &mdash; the longest line in it, the sag it
                was generated at &mdash; so the filters arrive with it.
              </div>
            </div>
          )}

          {DEV_MODE && showFilters && meta && bounds && (
            <div className="filters">
              <h2>Rigging</h2>
              <Slider
                label="Midspan sag"
                value={bounds.sag}
                min={bounds.sagFloor}
                max={10}
                step={0.5}
                unit=" % of span"
                format={(v) => v.toFixed(1)}
                onChange={setSagPct}
              />
              <div className="note">
                {lines
                  ? `${rescored.length} of ${candidates.length} lines still clear the terrain at ` +
                    `${bounds.sag.toFixed(1)} %. `
                  : 'Applies to the lines as they arrive. '}
                Cannot go below {bounds.sagFloor.toFixed(1)} % &mdash; the dataset was generated
                there, so looser lines were never evaluated.
              </div>

              <h2 style={{ marginTop: 14 }}>Anchors</h2>
              <div className="kinds">
                {LINE_KINDS.map((kind) => (
                  <button
                    key={kind}
                    data-active={kinds.has(kind)}
                    onClick={() => toggleKind(kind)}
                    title={KIND_HELP[kind]}
                  >
                    <b>{kind}</b>
                    <span>{meta.lineCounts[kind].toLocaleString()}</span>
                  </button>
                ))}
              </div>
              <div className="note">
                By what the two ends stand on, not by what is around them &mdash; a ground line
                threading between two houses is still natural.
              </div>

              <h2 style={{ marginTop: 14 }}>Filters</h2>
              <Slider label="Min score" value={Math.min(minScore, bounds.maxScore)} min={0} max={bounds.maxScore} step={1} unit="" onChange={setMinScore} />
              {/* Logarithmic, because the search spans a decade and the short end is where the
                  choices are: half the dataset is under 150 m, which is a fifth of a linear track.
                  The floor is the shortest line the pipeline will report rather than zero, both
                  because a ratio needs a positive end and because nothing exists below it. */}
              <RangeSlider
                label="Length"
                from={minLength}
                to={Math.min(maxLength, bounds.maxLen)}
                min={bounds.minLen}
                max={bounds.maxLen}
                step={10}
                unit=" m"
                log
                onChange={(from, to) => {
                  // At either end of the track the filter stops filtering rather than pinning
                  // itself to a number that came from whichever dataset happened to be loaded.
                  setMinLength(from <= bounds.minLen ? 0 : from)
                  setMaxLength(to >= bounds.maxLen ? Infinity : to)
                }}
              />
              <Slider label="Min exposure (air below)" value={minExposure} min={0} max={bounds.maxExp} step={1} unit=" m" onChange={setMinExposure} />
              <Slider label="Max canopy blocked" value={maxCanopy} min={0} max={100} step={1} unit=" %" onChange={setMaxCanopy} />
              <Slider
                label="Max offlevel"
                value={Math.min(maxOffLevel, bounds.offLevelCap)}
                min={0}
                max={bounds.offLevelCap}
                step={0.1}
                unit=" % of span"
                // At the top of the track the filter stops filtering, the way Length does at either
                // end. The track's ceiling is the cap the pipeline already applied, so a thumb
                // parked there is asking for every line there is -- and holding 3 rather than the
                // default kept it in the link and in the count of what is being narrowed, both of
                // which said something was being filtered out when nothing was.
                onChange={(v) =>
                  setMaxOffLevel(v >= bounds.offLevelCap ? FILTER_DEFAULTS.maxOffLevel : v)
                }
              />
              <div className="note" style={{ marginBottom: 0 }}>
                Terrain clearance is enforced; canopy is only scored. A line with a high
                &ldquo;blocked&rdquo; figure runs through the trees and is not walkable as-is.
              </div>
            </div>
          )}

          <button
            className="planbtn"
            data-active={placing !== null}
            data-editing={spots.holding || undefined}
            onClick={() => {
              if (placing) return setPlacing(null)
              if (spots.holding) return spots.done()
              setPlacing('a')
            }}
            title={
              placing ? 'Stop placing'
              : spots.holding ? 'Stop editing this line; it is saved as it is'
              : spots.open.kind === 'spot' ? 'Place another line in this spot'
              : spots.lib.draft ? 'Place two anchors for a new draft line; the first one replaces the draft line you have (undo brings it back)'
              : 'Place two anchors on the map'
            }
          >
            {placing
              ? `Tap the map for point ${placing.toUpperCase()} — cancel`
              : spots.holding
                ? 'Done editing'
                : spots.open.kind === 'spot' && spots.spot
                  ? `+ line in ${spotTitle(spots.spot)}`
                  : spots.lib.draft
                    ? 'Plan a new line (replaces draft)'
                    : 'Plan a line'}
          </button>

          <CacheBadge />
        </div>

          <MapView
            meta={meta}
            params={params}
            visible={visible}
            emphasiseLines={emphasiseLines}
            open={open}
            basemapMix={basemapMix}
            anchorDump={anchorDump}
            hotspots={showHotspots ? shownHotspots : null}
            mask={debugLayer === 'coarse' ? mask : null}
            regions={debugLayer === 'regions' ? regions : null}
            showAreas={showAreas}
            showUrban={kinds.has('urban')}
            tiles={tileLayer ? tiles : null}
            tileLayer={tileLayer ?? 'terrain'}
            initialBbox={initial.bbox}
            fix={fix}
            locating={locating}
            onLocate={setLocating}
            custom={line}
            editable={spots.editable}
            canClear={!spots.holding}
            showLines={showLines}
            onSelect={select}
            placing={placing}
            onPlace={placeNext}
            onSetCustom={setCustomPoint}
            onClearCustom={clearCustom}
            onMoveAnchor={moveAnchor}
            saved={savedDrawn}
            onOpenSaved={(spot, i) => {
              if (spots.holding) return
              if (spot === 'draft') spots.openDraft()
              else if (spot === 'shared') spots.openShared(i)
              else spots.openLine(spot, i)
            }}
            focus={focus}
            onViewport={(b, z) => {
              setBbox(b)
              setZoom(z)
            }}
          />

          {offMap && (
            <div className="offmap" data-where={offMap.where}>
              {offMap.where === 'plannable' ? (
                <>
                  {DEV_MODE && (
                    <>
                      No lines were searched here &mdash; that covers Berlin and Brandenburg only.
                      You can still <b>right-click to place two anchors</b> and have a line measured
                      against the survey for this ground.{' '}
                    </>
                  )}
                  {offMap.surface ? (
                    <>Ground and canopy are both read here.</>
                  ) : (
                    <>
                      <b>Canopy estimated here:</b> the trees come from a satellite canopy map that
                      can be metres off, and there are no buildings in it &mdash; a roof would
                      measure as the ground under it.
                    </>
                  )}
                </>
              ) : (
                <>
                  Nothing to measure here. Every height this tool reads comes from a German state
                  survey, so outside Germany &mdash; and outside the part of it this map&rsquo;s
                  projection is honest over &mdash; there is nothing to fetch. Zoom out to find your
                  way back.
                </>
              )}
            </div>
          )}

          {(selected || planPending) && params && (
            <Details
              c={selected}
              profile={shownProfile}
              wings={wings}
              cover={cover}
              params={params}
              roadState={roadState}
              onRoof={onRoof}
              optimizing={optimizing}
              offer={offer}
              onOptimize={() => {
                if (optimizing) return endRun()
                setReach(offer ?? 1)
                setOffer(null)
                setOptimizing(true)
              }}
              planned={planned}
              at={line.a && line.b ? { a: line.a, b: line.b } : null}
              failed={terrainFailed}
              fetching={fetchingElevation}
              canopy={canopy}
              sag={sagPct !== null ? { pct: sagPct, floor: SAG_MIN_PCT } : null}
              onSag={setSagPct}
              full={full}
              onFull={setFull}
              onMoveAnchor={moveAnchor}
              onFlip={flipAnchors}
              onGuide={guide.show}
              guideOpen={guide.open}
              rig={line.rig}
              onRig={setRig}
              companions={companions}
              onCompanion={(i) => {
                const c = companions[i]
                if (!c || !spots.spot) return
                if (spots.open.kind === 'shared') spots.openShared(c.index)
                else spots.openLine(spots.spot.id, c.index)
              }}
              editable={spots.editable}
              holding={spots.holding}
              keep={keep}
              onClose={clearCustom}
            />
          )}
        </div>
      </div>

      {guide.open && (
        <Guide
          kind={full && open ? 'line' : 'map'}
          onClose={guide.close}
          regions={meta?.regions ?? null}
        />
      )}
    </>
  )
}
