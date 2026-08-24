import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AnchorDump,
  Candidate,
  Dataset,
  Hotspots,
  MaskCells,
  StoredProfile,
  TileUsage,
} from '../shared/types.js'
import { rescoreAtSag } from '../shared/scoring.js'
import { buildProfile, packProfile, unpackProfile } from '../shared/profile.js'
import { BASEMAPS, DEBUG_COLORS, MIX_MAX, MapView } from './MapView.js'
import { place, type CustomPoints, type LatLon } from './planPoints.js'
import { toUtm33 } from '../shared/geo.js'
import { PLANNED_ID, planLine, type PlannedLine, type RigHeights } from '../shared/plan.js'
import { ensureTerrain, groundSampler, surfaceSampler } from './terrain.js'
import { Details } from './Details.js'
import { Slider } from './Slider.js'
import { cacheStats, clearTileCache } from './tileCache.js'
import { parseUrl, toSearch } from './urlState.js'
import { optimizeStep } from './optimize.js'
import { toWgs84 } from '../shared/geo.js'

type DebugLayer = 'none' | 'coarse' | 'terrain' | 'surface'

/**
 * What each debug view means, beside the map that draws it.
 *
 * These views are of the pipeline rather than of the terrain, so a colour on its own says nothing.
 * The figures live here rather than in the button because they are the reading, not the label.
 */
function DebugLegend({
  layer, mask, tiles,
}: {
  layer: Exclude<DebugLayer, 'none'>
  mask: MaskCells | null
  tiles: TileUsage | null
}) {
  const key = (color: string, opacity: number, text: string) => (
    <div className="key" key={text}>
      <i style={{ background: color, opacity }} />
      <span>{text}</span>
    </div>
  )

  if (layer === 'coarse') {
    if (!mask) return null
    const below = mask.drop.filter((d) => d < mask.minDrop).length
    return (
      <div className="legendbox">
        <h3>Coarse pre-pass</h3>
        {key(DEBUG_COLORS.maskBelow, 0.62, `falls under ${mask.minDrop} m — judged not worth a look`)}
        {key(DEBUG_COLORS.maskAbove, 0.16, 'falls further — kept, fading as it gets steeper')}
        <div className="stat">
          {below.toLocaleString()} of {mask.drop.length.toLocaleString()} cells below the threshold
        </div>
        <div className="about">
          The greatest fall within {mask.sourceRes * 2} m of each point, measured on a{' '}
          {mask.sourceRes} m grid that costs almost nothing to fetch, and drawn here in{' '}
          {mask.res} m squares that each take the steepest reading inside them. Source data arrives
          in 1 km tiles, so this verdict is acted on a tile at a time: compare it with the terrain
          view, whose squares are eight times wider, to see that gap.
        </div>
      </div>
    )
  }

  if (!tiles) return null
  const fetched = (layer === 'terrain' ? tiles.terrain : tiles.surface).filter(Boolean).length
  const barren = tiles.terrain.filter((t, i) => t && tiles.anchors[i] === 0).length

  if (layer === 'terrain') {
    return (
      <div className="legendbox">
        <h3>Terrain tiles fetched</h3>
        {key(DEBUG_COLORS.productive, 0.22, 'fetched, and the 1 m scan found anchors in it')}
        {key(DEBUG_COLORS.barren, 0.22, 'fetched and yielded nothing — the filter being too loose')}
        {key(DEBUG_COLORS.skipped, 0.55, 'skipped — dark beside green means too tight')}
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
      {key(DEBUG_COLORS.productive, 0.22, 'a line crosses it, so canopy had to be measured')}
      {key(DEBUG_COLORS.skipped, 0.55, 'no line crosses it — skipped')}
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
  const [data, setData] = useState<Dataset | null>(null)
  const [error, setError] = useState<string | null>(null)
  // null until the dataset is loaded, because the floor comes from the pipeline's own sag.
  const [sagPct, setSagPct] = useState<number | null>(initial.sagPct)
  const [minScore, setMinScore] = useState(0)
  const [minLength, setMinLength] = useState(0)
  const [minExposure, setMinExposure] = useState(0)
  const [maxCanopy, setMaxCanopy] = useState(100)
  const [maxOffLevel, setMaxOffLevel] = useState(100)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [bbox, setBbox] = useState(initial.bbox)
  // Google's map zoom is the same web-mercator scale MapLibre uses, so it transfers directly.
  const [zoom, setZoom] = useState(13)
  // OSM by default: paths, roads and place names orient you before you know where you are looking.
  const [basemapMix, setBasemapMix] = useState(
    Math.min(MIX_MAX, Math.max(0, initial.basemapMix ?? MIX_MAX)),
  )
  const [showLines, setShowLines] = useState(true)
  const [showFilters, setShowFilters] = useState(true)
  const [anchorDump, setAnchorDump] = useState<AnchorDump | null>(null)
  const [hotspots, setHotspots] = useState<Hotspots | null>(null)
  const [showHotspots, setShowHotspots] = useState(true)
  const [mask, setMask] = useState<MaskCells | null>(null)
  const [tiles, setTiles] = useState<TileUsage | null>(null)
  /**
   * One debug view at a time. A coarse field and a grid of tiles drawn together are unreadable, and
   * the useful comparison is between them rather than of both at once.
   */
  const [debugLayer, setDebugLayer] = useState<DebugLayer>('none')
  const [custom, setCustom] = useState<CustomPoints>(initial.custom)
  // null means "as level and as high as the ground allows", the same choice the search makes.
  const [rig, setRig] = useState<RigHeights | null>(initial.rig)
  const [optimizing, setOptimizing] = useState(false)
  // Bumped when a terrain fetch actually delivers something new, which is what re-measurement
  // depends on. Keeping it a counter rather than storing the measurement means the planned line is
  // computed, not held in state, so no effect has to write it.
  const [terrainVersion, setTerrainVersion] = useState(0)
  const [terrainFailed, setTerrainFailed] = useState(false)
  const [fetchedProfile, setFetchedProfile] = useState<{ id: string; profile: StoredProfile } | null>(
    null,
  )
  const [layerError, setLayerError] = useState<string | null>(null)

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}candidates.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: Dataset) => {
        // A file from an older pipeline would otherwise fail deep inside rendering, which reads as
        // a broken app rather than as stale output.
        if (!d.meta?.regions?.length) throw new Error('no regions in it — re-run `npm run pipeline`')
        setData(d)
        const floor = d.meta.params.sagRatio * 100
        setSagPct((cur) => Math.max(floor, cur ?? floor))
        // A shared candidate is restored by id if the dataset still has it. If regenerating moved
        // the anchor that names it, the link's own geometry rebuilds the same line as a planned
        // one instead -- stale rather than broken.
        const found = d.candidates.find((c) => c.id === initial.lineId)
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
      .catch((e) => setError(String(e)))
  }, [])

  /**
   * Sag is re-applied client side rather than baked in: the stored profile carries terrain and
   * canopy heights, and the two attachment heights give the chord, so the line at any sag follows
   * without the raster. Only tightening is offered -- candidates the pipeline rejected are absent
   * from the dataset, so a lower sag would report an incomplete set as if it were complete.
   */
  const rescored = useMemo(() => {
    if (!data || sagPct === null) return []
    if (sagPct === data.meta.params.sagRatio * 100) return data.candidates
    return data.candidates
      .map((c) => rescoreAtSag(c, sagPct / 100, data.meta.params))
      .filter((c): c is Candidate => c !== null)
  }, [data, sagPct])

  /**
   * The "where is anything possible at all" layer, loaded eagerly and shown by default: it is 6 KB,
   * and at the zoom the map opens at it is the only layer that says anything useful.
   */
  /**
   * Cycles the debug views: the coarse pre-pass, then what was actually fetched per source tile for
   * terrain and for surface. Off by default -- these are views of the pipeline, not of the terrain.
   */
  const DEBUG_ORDER = ['none', 'coarse', 'terrain', 'surface'] as const
  const cycleDebug = () => {
    const next = DEBUG_ORDER[(DEBUG_ORDER.indexOf(debugLayer) + 1) % DEBUG_ORDER.length]!
    setDebugLayer(next)
    setLayerError(null)
    const need = next === 'coarse' ? !mask : next !== 'none' && !tiles
    if (!need) return
    const file = next === 'coarse' ? 'mask.json' : 'tiles.json'
    fetch(`${import.meta.env.BASE_URL}${file}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => (next === 'coarse' ? setMask(d) : setTiles(d)))
      .catch(() => setLayerError(`${file} missing — run \`npm run pipeline\``))
  }

  const DEBUG_LABELS: Record<DebugLayer, string> = {
    none: 'debug layers',
    coarse: 'coarse pre-pass',
    terrain: 'terrain tiles',
    surface: 'surface tiles',
  }

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}hotspots.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setHotspots)
      .catch(() => setLayerError('hotspots.json missing — run `npm run pipeline`'))
  }, [])

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
    if (!customUtm) return
    let stale = false
    ensureTerrain(customUtm.a, customUtm.b)
      .then((arrived) => {
        if (stale) return
        setTerrainFailed(false)
        if (arrived) setTerrainVersion((v) => v + 1)
      })
      .catch(() => {
        if (!stale) setTerrainFailed(true)
      })
    return () => {
      stale = true
    }
  }, [customUtm])

  /**
   * The planned line, measured by the same code the search uses.
   *
   * Derived rather than stored, so dragging an anchor cannot start a render loop: the two anchor
   * positions and the sag setting fully determine it, and `terrainVersion` only changes when a
   * fetch delivers a window that was genuinely missing.
   */
  const planned: PlannedLine | null = useMemo(() => {
    if (!data || !customUtm || sagPct === null) return null
    void terrainVersion
    return planLine(
      customUtm.a,
      customUtm.b,
      groundSampler,
      surfaceSampler,
      sagPct / 100,
      data.meta.params,
      rig,
    )
  }, [data, customUtm, sagPct, terrainVersion, rig])

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
  const commit = (next: CustomPoints) => {
    // Any hand movement ends an optimisation: it is descending from a point the user has left.
    setOptimizing(false)
    setCustom(next)
    const complete = !!next.a && !!next.b
    if (!complete) setRig(null)
    setSelectedId((cur) => (complete ? PLANNED_ID : cur === PLANNED_ID ? null : cur))
  }

  /** Places one end of the planned line. */
  const setCustomPoint = (which: 'a' | 'b', at: LatLon | null) => commit(place(custom, which, at))

  // One call, not two setCustomPoint calls: both would read the same pre-update `custom`, so the
  // second would put the first end back.
  const clearCustom = () => commit({ a: null, b: null })

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
    commit(place(from, which, at))
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
      .catch(() => setLayerError('anchors.json missing — run `npm run pipeline`'))
  }

  const visible = useMemo(() => {
    if (!data) return []
    return rescored
      .filter(
        (c) =>
          c.score >= minScore &&
          c.length >= minLength &&
          c.exposure >= minExposure &&
          c.canopyBlockedFraction * 100 <= maxCanopy &&
          c.offLevelRatio * 100 <= maxOffLevel,
      )
      .sort((a, b) => b.score - a.score)
  }, [data, rescored, minScore, minLength, minExposure, maxCanopy, maxOffLevel])

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
  useEffect(() => {
    if (!optimizing || !data || sagPct === null || !customUtm) return
    const origin = customUtm
    let timer: ReturnType<typeof setTimeout>
    let stopped = false

    const tick = () => {
      if (stopped) return
      const live = customRef.current
      if (!live.a || !live.b) return setOptimizing(false)
      const [ae, an] = toUtm33(live.a.lat, live.a.lon)
      const [be, bn] = toUtm33(live.b.lat, live.b.lon)
      const next = optimizeStep(
        { a: { e: ae, n: an }, b: { e: be, n: bn } },
        {
          origin,
          ground: groundSampler,
          surface: surfaceSampler,
          sagRatio: sagPct / 100,
          params: data.meta.params,
          rig,
        },
      )
      if (!next) return setOptimizing(false)
      setCustom({ a: toWgs84(next.a.e, next.a.n), b: toWgs84(next.b.e, next.b.n) })
      timer = setTimeout(tick, 100)
    }

    timer = setTimeout(tick, 0)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
    // customUtm is read once, as the origin the wander is measured from, so it is deliberately not
    // a dependency -- otherwise every step would restart the run and reset that origin.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optimizing, data, sagPct, rig])

  /**
   * A profile for the selected line, when the dataset does not carry one.
   *
   * This is the other half of `storeProfiles: false` -- the chart and the exact metrics still exist,
   * they are just built for the one line being looked at instead of all of them up front, from the
   * same elevation service and the same buildProfile the planner uses.
   */
  useEffect(() => {
    if (!data || !selected || selected.profile) return
    const a = { e: selected.a.e, n: selected.a.n }
    const b = { e: selected.b.e, n: selected.b.n }
    let stale = false
    ensureTerrain(a, b)
      .then(() => {
        if (stale) return
        const built = buildProfile(
          a, b, selected.a.anchor, selected.b.anchor, selected.length,
          groundSampler, surfaceSampler, data.meta.params,
        )
        if (built.some((s) => Number.isNaN(s.ground))) return
        setFetchedProfile({ id: selected.id, profile: packProfile(built) })
      })
      .catch(() => undefined)
    return () => {
      stale = true
    }
  }, [data, selected])

  /** The selected line with its stored profile, or the fetched one, or neither yet. */
  const detailed = useMemo(() => {
    if (!selected || !data || sagPct === null) return selected
    if (selected.profile) return selected
    const profile = fetchedProfile?.id === selected.id ? fetchedProfile.profile : null
    if (!profile) return selected
    // Now that a profile exists, the figures can be recomputed at the chosen sag rather than
    // staying at the one they were generated with.
    return rescoreAtSag({ ...selected, profile }, sagPct / 100, data.meta.params) ?? selected
  }, [selected, data, sagPct, fetchedProfile])

  const shownProfile = useMemo(() => {
    if (!detailed?.profile || sagPct === null) return null
    return unpackProfile(
      detailed.profile,
      detailed.length,
      detailed.a.anchor,
      detailed.b.anchor,
      sagPct / 100,
    )
  }, [detailed, sagPct])

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
      sagPct,
      basemapMix,
    })
  }, [bbox, selectedId, selected, custom, rig, sagPct, basemapMix])

  useEffect(() => {
    // replaceState, not pushState: panning the map should not fill the back button.
    history.replaceState(null, '', search ? `?${search}` : window.location.pathname)
  }, [search])

  if (error) return <div className="loading">Failed to load candidates.json &mdash; {error}</div>
  if (!data || sagPct === null) return <div className="loading">Loading&hellip;</div>

  const { stats, regions } = data.meta
  const aoiCount = regions.reduce((n, r) => n + r.aois.length, 0)
  const areaKm2 = regions.reduce((s, r) => s + r.width * r.height, 0) / 1e6
  const groundMin = Math.min(...regions.map((r) => r.groundMin))
  const groundMax = Math.max(...regions.map((r) => r.groundMax))
  // Reduced rather than spread into Math.max: the dataset is tens of thousands of lines now, and
  // spreading that many arguments exceeds the call stack.
  const highest = (pick: (c: Candidate) => number, floor: number) =>
    Math.ceil(data.candidates.reduce((m, c) => Math.max(m, pick(c)), floor))
  const maxScore = highest((c) => c.score, 1)
  const maxLen = highest((c) => c.length, 100)
  const maxExp = highest((c) => c.exposure, 10)
  // The pipeline already caps offlevel, so the slider only needs to reach that cap.
  const offLevelCap = Math.ceil(data.meta.params.maxOffLevelRatio * 100 * 10) / 10
  const sagFloor = data.meta.params.sagRatio * 100

  return (
    <>
      <header>
        <h1>Highline Finder</h1>
        <span className="meta">
          {aoiCount} AOI{aoiCount === 1 ? '' : 's'}
          {regions.length !== aoiCount && ` in ${regions.length} regions`}
          {' · '}{areaKm2.toFixed(1)} km&sup2;
          {' · '}terrain {groundMin}&ndash;{groundMax} m
        </span>
        {bbox && (
          <a
            className="external"
            href={`https://www.google.com/maps/@${((bbox[0] + bbox[2]) / 2).toFixed(6)},${(
              (bbox[1] + bbox[3]) / 2
            ).toFixed(6)},${zoom.toFixed(2)}z/data=!3m1!1e3`}
            target="_blank"
            rel="noreferrer"
            title="Open this view in Google Maps satellite imagery"
          >
            Google Maps ↗
          </a>
        )}
        <span className="spacer" />
        <span className="meta">
          {stats.anchorsKept.toLocaleString()} anchors {' · '}
          {stats.candidatesAfterDedup.toLocaleString()} distinct lines {' · '}
          {(stats.runtimeMs / 1000).toFixed(1)}s
        </span>
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
            <button data-active={showLines} onClick={() => setShowLines(!showLines)}>
              {visible.length} lines
            </button>
            <button data-active={showHotspots} onClick={() => setShowHotspots(!showHotspots)}>
              {hotspots ? `${hotspots.lat.length.toLocaleString()} hotspots` : 'hotspots'}
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
            <button data-active={showFilters} onClick={() => setShowFilters(!showFilters)}>
              filters
            </button>
          </div>
          {layerError && <div className="togglenote">{layerError}</div>}
          {import.meta.env.DEV && debugLayer !== 'none' && (
            <DebugLegend layer={debugLayer} mask={mask} tiles={tiles} />
          )}

          {showFilters && (
            <div className="filters">
              <h2>Rigging</h2>
              <Slider
                label="Midspan sag"
                value={sagPct}
                min={sagFloor}
                max={10}
                step={0.5}
                unit=" % of span"
                format={(v) => v.toFixed(1)}
                onChange={setSagPct}
              />
              <div className="note">
                {rescored.length} of {data.candidates.length} lines still clear the terrain at{' '}
                {sagPct.toFixed(1)} %. Cannot go below {sagFloor.toFixed(1)} % &mdash; the dataset
                was generated there, so looser lines were never evaluated.
              </div>

              <h2 style={{ marginTop: 14 }}>Filters</h2>
              <Slider label="Min score" value={Math.min(minScore, maxScore)} min={0} max={maxScore} step={1} unit="" onChange={setMinScore} />
              <Slider label="Min length" value={minLength} min={0} max={maxLen} step={10} unit=" m" onChange={setMinLength} />
              <Slider label="Min exposure (air below)" value={minExposure} min={0} max={maxExp} step={1} unit=" m" onChange={setMinExposure} />
              <Slider label="Max canopy blocked" value={maxCanopy} min={0} max={100} step={1} unit=" %" onChange={setMaxCanopy} />
              <Slider
                label="Max offlevel"
                value={Math.min(maxOffLevel, offLevelCap)}
                min={0}
                max={offLevelCap}
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
            data={data}
            visible={visible}
            selected={selected}
            basemapMix={basemapMix}
            anchorDump={anchorDump}
            hotspots={showHotspots ? hotspots : null}
            mask={debugLayer === 'coarse' ? mask : null}
            tiles={debugLayer === 'terrain' || debugLayer === 'surface' ? tiles : null}
            tileLayer={debugLayer === 'surface' ? 'surface' : 'terrain'}
            initialBbox={initial.bbox}
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

          {(selected || planPending) && (
            <Details
              c={detailed}
              profile={shownProfile}
              optimizing={optimizing}
              onOptimize={() => setOptimizing(!optimizing)}
              planned={planned}
              at={custom.a && custom.b ? { a: custom.a, b: custom.b } : null}
              failed={terrainFailed}
              rig={rig}
              onRig={setRig}
              onClose={() => setSelectedId(null)}
            />
          )}
        </div>
      </div>
    </>
  )
}
