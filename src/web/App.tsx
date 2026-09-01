import { useEffect, useMemo, useRef, useState } from 'react'
import { LINE_KINDS } from '../shared/types.js'
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
  Region,
  StoredProfile,
  TileUsage,
} from '../shared/types.js'
import { rescoreAtSag, rescoreForDisplay } from '../shared/scoring.js'
import {
  VIEWER_PROFILE, buildProfile, measuredHalfWidth, packProfile, unpackProfile,
} from '../shared/profile.js'
import {
  BASEMAPS, DEBUG_COLORS, LINES_FROM, MIX_MAX, MapView, SAME_VINTAGE_MS, type TileLayer,
} from './MapView.js'
import { place, type CustomPoints, type LatLon } from './planPoints.js'
import { toUtm33 } from '../shared/geo.js'
import { PLANNED_ID, planLine, type PlannedLine, type RigHeights } from '../shared/plan.js'
import {
  DRAG_LOOKAHEAD, ensureTerrain, fetchingWindows, groundSampler, onBuilding, onWindowActivity,
  roofs, surfaceSampler,
} from './terrain.js'
import { coverAlong, coverFailed, ensureCover, roadsFor, water } from './landcover.js'

import { Details } from './Details.js'
import { Guide, useGuide } from './Guide.js'
import { fitHeader } from './headerFit.js'
import { useRemembered } from './remembered.js'
import { watchLocation, type Fix } from './locate.js'
import { holds, touches, type Bbox } from './inView.js'
import { failureText, report } from './report.js'
import { RangeSlider, Slider } from './Slider.js'
import { cacheStats, clearTileCache } from './tileCache.js'
import { changed, FILTER_DEFAULTS, movedFilters, parseUrl, toSearch } from './urlState.js'
import { optimizeFrame, scanMargin, startingSpacing } from './optimize.js'
import { emitProbes } from './probeOverlay.js'

/** How long the button keeps offering a wider search after a run ends. */
const OFFER_MS = 2000
import { toWgs84 } from '../shared/geo.js'

type DebugLayer = 'none' | 'coarse' | 'terrain' | 'surface' | 'buildings' | 'roads' | 'regions'

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

/** Whether these placed points are just a candidate's own coordinates written back. */
function sameLine(points: CustomPoints, c: Candidate): boolean {
  const near = (p: LatLon | null, a: { lat: number; lon: number }) =>
    !!p && Math.abs(p.lat - a.lat) < 1e-5 && Math.abs(p.lon - a.lon) < 1e-5
  return near(points.a, c.a) && near(points.b, c.b)
}

export function App() {
  // Read once. The URL is an input at startup and an output thereafter; treating it as live state
  // both ways is how a URL writer and a URL reader start feeding each other.
  const [initial] = useState(() => parseUrl(window.location.search))
  const guide = useGuide()
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
  const [sagPct, setSagPct] = useState<number | null>(initial.sagPct)
  // Each slider starts where the link put it, or at the value where it filters nothing.
  const filter = <K extends keyof typeof FILTER_DEFAULTS>(field: K) =>
    initial.filters[field] ?? FILTER_DEFAULTS[field]
  const [minScore, setMinScore] = useState(filter('minScore'))
  const [minLength, setMinLength] = useState(filter('minLength'))
  const [maxLength, setMaxLength] = useState(filter('maxLength'))
  const [minExposure, setMinExposure] = useState(filter('minExposure'))
  const [maxCanopy, setMaxCanopy] = useState(filter('maxCanopy'))
  const [maxOffLevel, setMaxOffLevel] = useState(filter('maxOffLevel'))
  const [selectedId, setSelectedId] = useState<string | null>(null)
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
  const [custom, setCustom] = useState<CustomPoints>(initial.custom)
  // null means "as level and as high as the ground allows", the same choice the search makes.
  const [rig, setRig] = useState<RigHeights | null>(initial.rig)
  const [optimizing, setOptimizing] = useState(false)
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
  const [fetchedProfile, setFetchedProfile] = useState<{ id: string; profile: StoredProfile } | null>(
    null,
  )
  const [layerError, setLayerError] = useState<string | null>(null)
  /** Whether the pointer is on the lines count, which is the cue to make them easy to spot. */
  const [emphasiseLines, setEmphasiseLines] = useState(false)
  /**
   * Following the device, and the last position it gave.
   *
   * A failure switches the toggle back off rather than latching, so pressing it again is a retry --
   * the one thing MapLibre's own control will not do once a prompt has been refused.
   */
  const [locating, setLocating] = useState(false)
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
  /** Why the selected candidate has no chart, or null while it might still get one. */
  const [profileFailed, setProfileFailed] = useState<string | null>(null)

  const load = <T,>(file: string) =>
    fetch(`${import.meta.env.BASE_URL}${file}`).then((r) =>
      r.ok ? (r.json() as Promise<T>) : Promise.reject(new Error(`HTTP ${r.status}`)),
    )

  useEffect(() => {
    load<DatasetMeta>('meta.json')
      .then((m) => {
        // A file from an older pipeline would otherwise fail deep inside rendering, which reads as
        // a broken app rather than as stale output.
        if (!m?.regions?.length) throw new Error('no regions in it — re-run `npm run pipeline`')
        setMeta(m)
        const floor = m.params.sagRatio * 100
        setSagPct((cur) => Math.max(floor, cur ?? floor))
      })
      .catch((e: unknown) => {
        report('loading meta.json, which describes the run', e)
        setError(failureText(e))
      })
  }, [])

  useEffect(() => {
    load<{ lines: ByKind<Candidate[]> }>('candidates.json')
      .then((d) => {
        if (!d?.lines?.natural) throw new Error('no lines in it — re-run `npm run pipeline`')
        setLines(d.lines)
        // A shared candidate is restored by id if the dataset still has it. If regenerating moved
        // the anchor that names it, the link's own geometry rebuilds the same line as a planned
        // one instead -- stale rather than broken.
        const found = LINE_KINDS.flatMap((k) => d.lines[k]).find((c) => c.id === initial.lineId)
        if (found) {
          setSelectedId(found.id)
          // The point parameters are either that candidate's own fallback geometry or a planned
          // line the sharer had placed as well. Identical coordinates mean the former, and
          // adopting it would draw a duplicate line on top of the candidate.
          if (sameLine(initial.custom, found)) setCustom({ a: null, b: null })
        } else if (initial.custom.a && initial.custom.b) {
          setSelectedId(PLANNED_ID)
        }
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
    if (sagPct === meta.params.sagRatio * 100) return candidates
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
    if (!custom.a || !custom.b) return null
    const [ae, an] = toUtm33(custom.a.lat, custom.a.lon)
    const [be, bn] = toUtm33(custom.b.lat, custom.b.lon)
    return { a: { e: ae, n: an }, b: { e: be, n: bn } }
  }, [custom])

  // The only job of this effect is fetching. It deliberately does not compute or store the
  // measurement: an effect that writes what another effect reads is how this file previously
  // managed to feed itself.
  useEffect(() => {
    if (!customUtm || !meta) return
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
      ensureTerrain(a, b, measuredHalfWidth(span, meta.params)),
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
  }, [customUtm, meta])

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
    if (!meta || !customUtm || sagPct === null) return null
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
      { ...meta.params, ...VIEWER_PROFILE },
      rig,
      scene,
      // A dragged anchor crosses into ground still being fetched constantly, and a chart of most of
      // the line beats a spinner over all of it. What is missing comes back as a count and the panel
      // says so -- see PlannedLine.unmeasured.
      { tolerateGaps: true },
    )
  }, [meta, customUtm, sagPct, terrainVersion, rig, scene])

  /**
   * A placed line with no measurement yet. The details panel renders regardless, blank and with a
   * placeholder chart, so placing a line always produces the panel it is going to fill.
   */
  const planPending = selectedId === PLANNED_ID && !!custom.a && !!custom.b && !planned

  /**
   * Adopts a new pair of planned points. Selection happens here rather than in an effect: it is a
   * consequence of the click, and an effect that both reads and writes the selection is exactly
   * what produced a maximum-update-depth loop before.
   */
  const commit = (next: CustomPoints, select: boolean) => {
    // Any hand movement ends an optimisation: it is descending from a point the user has left.
    setOptimizing(false)
    setCustom(next)
    const complete = !!next.a && !!next.b
    if (!complete) setRig(null)
    setSelectedId((cur) => {
      if (!complete) return cur === PLANNED_ID ? null : cur
      // `select` is the difference between asking to see a line and merely moving one. Placing a
      // point is a request for the panel; dragging an anchor is not, so a panel the user has closed
      // stays closed while they rearrange things. An open one follows the line it is describing
      // either way, including when a dragged candidate forks into the planned line.
      return select || cur !== null ? PLANNED_ID : null
    })
  }

  /** Turns one anchor class on or off. All three off is a legitimate setting: no lines. */
  const toggleKind = (kind: LineKind) =>
    setKinds((cur) => {
      const next = new Set(cur)
      if (!next.delete(kind)) next.add(kind)
      return next
    })

  /** Places one end of the planned line. */
  const setCustomPoint = (which: 'a' | 'b', at: LatLon | null) =>
    commit(place(custom, which, at), true)

  // One call, not two setCustomPoint calls: both would read the same pre-update `custom`, so the
  // second would put the first end back.
  const clearCustom = () => commit({ a: null, b: null }, false)

  /**
   * Dragging an anchor handle. Dragging one that belongs to a *found* line forks that line into the
   * planned one, which is the quick way to ask "what if this candidate started three metres over
   * there" -- the candidate itself is untouched and the copy becomes the thing under the pointer.
   */
  const moveAnchor = (which: 'a' | 'b', at: LatLon) => {
    const from =
      selected && selected.id !== PLANNED_ID
        ? {
            a: { lat: selected.a.lat, lon: selected.a.lon },
            b: { lat: selected.b.lat, lon: selected.b.lon },
          }
        : custom
    commit(place(from, which, at), false)
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
   * thousand lines, and cannot tell "nothing here" from "your filters hid it". So the buttons say
   * both figures -- but only when they differ, because at the opening view they are the same number
   * twice and a count of everything out of everything is noise.
   */
  const view = bbox as Bbox | null
  const linesHere = useMemo(
    () => (view ? visible.filter((c) => touches(view, c.a, c.b)).length : visible.length),
    [view, visible],
  )
  const spotsHere = useMemo(() => {
    if (!shownHotspots) return 0
    if (!view) return shownHotspots.lat.length
    let n = 0
    for (let i = 0; i < shownHotspots.lat.length; i++) {
      if (holds(view, shownHotspots.lat[i]!, shownHotspots.lon[i]!)) n++
    }
    return n
  }, [view, shownHotspots])

  // The planned line is exempt from every filter and from the validity gate, by design.
  const selected = useMemo(
    () =>
      (selectedId === PLANNED_ID
        ? planned?.candidate
        : visible.find((c) => c.id === selectedId)) ?? null,
    [visible, selectedId, planned],
  )

  /**
   * The optimiser, run as an animation rather than to completion.
   *
   * The loop reads the live positions from a ref instead of taking `custom` as a dependency: an
   * effect that both reads and writes the same state is how this file previously managed to feed
   * itself, and here it would do so sixty times a second rather than once.
   */
  const customRef = useRef(custom)
  customRef.current = custom

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
    if (!optimizing || !meta || sagPct === null || !customUtm) return
    const origin = customUtm
    let timer: ReturnType<typeof setTimeout>
    let stopped = false
    // Carried across ticks. Restarting it each frame would spend the frame re-walking the halving
    // ladder from a metre back down to a centimetre instead of moving the line -- see optimizeFrame.
    let spacing = startingSpacing(reach)

    const tick = async () => {
      if (stopped) return
      const live = customRef.current
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
            params: meta.params,
            rig,
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
                scanMargin(Math.hypot(plan.b.e - plan.a.e, plan.b.n - plan.a.n), at, meta.params),
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
      setCustom({ a: toWgs84(plan.a.e, plan.a.n), b: toWgs84(plan.b.e, plan.b.n) })
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
  }, [optimizing, meta, sagPct, rig])

  /**
   * A profile for the selected line, when the dataset does not carry one.
   *
   * The dataset carries none, so the chart and the exact metrics are built for the one line being
   * looked at instead of for all of them up front -- from the same elevation service and the same
   * buildProfile the planner uses, but at the viewer's resolution rather than the search's. A metre
   * apart instead of four, which is the difference between seeing a gully and averaging over it.
   *
   * The metrics below are re-derived from this profile, so they are finer than the ones the search
   * assigned. That is the point: a clearance figure that stepped over a four-metre gap was wrong.
   * It does mean the number in the panel can differ slightly from the one the list sorted on.
   */
  useEffect(() => {
    if (!meta || !selected || selected.profile) return
    const a = { e: selected.a.e, n: selected.a.n }
    const b = { e: selected.b.e, n: selected.b.n }
    let stale = false
    setProfileFailed(null)
    // Only as wide as the profile reads. A selected line does not move, so anything beyond the band
    // it samples would be fetched to be looked at and thrown away.
    const band = measuredHalfWidth(selected.length, meta.params)
    Promise.all([ensureTerrain(a, b, band), ensureCover(a, b)])
      .then(() => {
        if (stale) return
        const fine = { ...meta.params, ...VIEWER_PROFILE }
        const built = buildProfile(
          a, b, selected.a.anchor, selected.b.anchor, selected.length,
          groundSampler, surfaceSampler, fine, { water },
        )
        // Holes are drawn as holes rather than thrown away with the rest of the line. Only a
        // profile with nothing in it at all is a failure: that means the service has no cover here,
        // which is a different sentence and one the panel can act on.
        const holes = built.filter((sample) => Number.isNaN(sample.ground)).length
        if (holes === built.length) {
          const why = `elevation is missing along the whole of this line`
          report('building a profile for the selected line', new Error(why))
          setProfileFailed(why)
          return
        }
        setFetchedProfile({ id: selected.id, profile: packProfile(built, fine) })
      })
      .catch((e: unknown) => {
        report('building a profile for the selected line', e)
        if (!stale) setProfileFailed(failureText(e))
      })
    return () => {
      stale = true
    }
    // terrainVersion rebuilds this as each window lands, so a selected line fills in piece by piece
    // like a dragged one does. The fetch inside is a no-op once nothing is missing, so the rebuilds
    // stop of their own accord rather than needing a guard.
  }, [meta, selected, terrainVersion])

  /** The selected line with its stored profile, or the fetched one, or neither yet. */
  const remeasured = useMemo(() => {
    if (!selected || !meta || sagPct === null || selected.profile) return null
    const profile = fetchedProfile?.id === selected.id ? fetchedProfile.profile : null
    if (!profile) return null
    // Now that a profile exists, the figures are recomputed at the chosen sag rather than staying at
    // the one they were generated with -- and for display rather than for filtering, so a line the
    // finer measurement disqualifies is described instead of vanishing. See rescoreForDisplay.
    return rescoreForDisplay({ ...selected, profile }, sagPct / 100, meta.params)
  }, [selected, meta, sagPct, fetchedProfile])

  const detailed = remeasured?.candidate ?? selected

  const shownProfile = useMemo(() => {
    if (!detailed?.profile || sagPct === null || !meta) return null
    return unpackProfile(
      detailed.profile,
      detailed.length,
      detailed.a.anchor,
      detailed.b.anchor,
      sagPct / 100,
      meta.params,
    )
  }, [detailed, sagPct, meta])

  const shownEnds = useMemo(
    () =>
      detailed && { a: { e: detailed.a.e, n: detailed.a.n }, b: { e: detailed.b.e, n: detailed.b.n } },
    [detailed],
  )

  /**
   * Land cover along whatever line is on screen: water for the chart to draw, and roads for the
   * planner to hold the line to.
   *
   * Debounced, because dragging an anchor moves the line many times a second and this is a public
   * Overpass instance. Buildings need no equivalent -- they arrive with the elevation, since they
   * are part of the measurement rather than an annotation on it.
   *
   * One fetch serves both because a planned line *is* the shown line whenever one is placed, so the
   * corridor is the same and so is the cache key. A found candidate carries the crossings the
   * pipeline measured, and only wants the water half.
   */
  useEffect(() => {
    if (!shownEnds) return
    let stale = false
    const timer = setTimeout(() => {
      ensureCover(shownEnds.a, shownEnds.b)
        .then((arrived) => {
          if (!stale && arrived) setCoverVersion((v) => v + 1)
        })
        .catch((e: unknown) => report('loading roads and water along the shown line', e))
    }, 300)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [shownEnds])

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
   * A selected candidate also carries the geometry needed to rebuild it, so the link survives the
   * dataset being regenerated with a different anchor. There is only one pair of point parameters,
   * so a planned line the user placed themselves wins over that fallback -- and on load the two
   * are told apart by whether the coordinates match the candidate.
   */
  const search = useMemo(() => {
    const planning = selectedId === PLANNED_ID || !!custom.a || !!custom.b
    const fallback = planning ? null : selected
    // The sag default is not a constant: the dataset was generated at some sag and the control
    // cannot go below it, so that floor is the default and only a tightened sag belongs in a link.
    const sagFloor = meta ? meta.params.sagRatio * 100 : null
    return toSearch({
      bbox,
      lineId: selectedId && selectedId !== PLANNED_ID ? selectedId : null,
      custom: fallback
        ? {
            a: { lat: fallback.a.lat, lon: fallback.a.lon },
            b: { lat: fallback.b.lat, lon: fallback.b.lon },
          }
        : custom,
      rig: fallback ? { a: fallback.a.aFrame, b: fallback.b.aFrame } : rig,
      sagPct: sagPct === null ? null : changed(sagPct, sagFloor),
      basemapMix: changed(basemapMix, MIX_MAX),
      showLines: changed(showLines, true),
      showHotspots: changed(showHotspots, true),
      showAreas: changed(showAreas, false),
      // Every class on is the default, so only a narrowed selection is worth a parameter.
      kinds: kinds.size === LINE_KINDS.length ? null : LINE_KINDS.filter((k) => kinds.has(k)),
      filters: movedFilters({
        minScore, minLength, maxLength, minExposure, maxCanopy, maxOffLevel,
      }),
    })
  }, [
    bbox, selectedId, selected, custom, rig, sagPct, basemapMix, meta,
    showLines, showHotspots, showAreas, kinds,
    minScore, minLength, maxLength, minExposure, maxCanopy, maxOffLevel,
  ])

  useEffect(() => {
    // replaceState, not pushState: panning the map should not fill the back button.
    history.replaceState(null, '', search ? `?${search}` : window.location.pathname)
  }, [search])

  if (error) return <div className="loading">Failed to load candidates.json &mdash; {error}</div>

  /**
   * Everything below tolerates there being no dataset yet, and that is the point.
   *
   * candidates.json is four megabytes over the wire, and the whole page used to be one
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
          sag: sagPct,
          sagFloor: meta.params.sagRatio * 100,
          maxScore: meta.ranges.score,
          minLen: Math.floor(meta.params.minLength),
          maxLen: meta.ranges.length,
          maxExp: meta.ranges.exposure,
          // The pipeline already caps offlevel, so the slider only needs to reach that cap.
          offLevelCap: Math.ceil(meta.params.maxOffLevelRatio * 100 * 10) / 10,
        }
      : null

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
          className="guidebtn"
          onClick={guide.show}
          title="What this is, where the data comes from, and how to use it"
          aria-label="About Highline Finder"
        >
          i
        </button>
      </header>

      <div className="layout">
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
              {shownHotspots ? `${here(spotsHere, shownHotspots.lat.length)} hotspots` : 'hotspots'}
            </button>
            <button
              data-active={locating}
              onClick={() => setLocating(!locating)}
              title="Centre the map on where you are"
            >
              {locating && !fix ? <Spinner label="locating" /> : 'my location'}
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
            <button data-active={showFilters} onClick={() => setShowFilters(!showFilters)}>
              filters
            </button>
          </div>
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

          {showFilters && !bounds && (
            <div className="filters">
              <div className="note" style={{ marginBottom: 0 }}>
                Every range here is fitted to the dataset &mdash; the longest line in it, the sag it
                was generated at &mdash; so the filters arrive with it.
              </div>
            </div>
          )}

          {showFilters && meta && bounds && (
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
                onChange={setMaxOffLevel}
              />
              <div className="note" style={{ marginBottom: 0 }}>
                Terrain clearance is enforced; canopy is only scored. A line with a high
                &ldquo;blocked&rdquo; figure runs through the trees and is not walkable as-is.
              </div>
            </div>
          )}

          <CacheBadge />
        </div>

          <MapView
            meta={meta}
            visible={visible}
            emphasiseLines={emphasiseLines}
            selected={selected}
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
            custom={custom}
            showLines={showLines}
            onSelect={setSelectedId}
            onSetCustom={setCustomPoint}
            onClearCustom={clearCustom}
            onMoveAnchor={moveAnchor}
            onViewport={(b, z) => {
              setBbox(b)
              setZoom(z)
            }}
          />

          {(selected || planPending) && meta && (
            <Details
              c={detailed}
              profile={shownProfile}
              cover={cover}
              params={meta.params}
              roadState={selectedId === PLANNED_ID ? roadState : 'ok'}
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
              at={custom.a && custom.b ? { a: custom.a, b: custom.b } : null}
              failed={selectedId === PLANNED_ID ? terrainFailed : profileFailed}
              violations={remeasured?.violations ?? null}
              fetching={fetchingElevation}
              rig={rig}
              onRig={setRig}
              onClose={() => setSelectedId(null)}
            />
          )}
        </div>
      </div>

      {guide.open && <Guide onClose={guide.close} />}
    </>
  )
}
