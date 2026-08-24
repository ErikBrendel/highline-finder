import { useEffect, useMemo, useState } from 'react'
import type { AnchorDump, Candidate, Dataset, Hotspots } from '../shared/types.js'
import { rescoreAtSag } from '../shared/scoring.js'
import { BASEMAPS, MIX_MAX, MapView } from './MapView.js'
import { place, type CustomPoints, type LatLon } from './planPoints.js'
import { toUtm33 } from '../shared/geo.js'
import { PLANNED_ID, planLine, type PlannedLine, type RigHeights } from '../shared/plan.js'
import { ensureTerrain, groundSampler, surfaceSampler } from './terrain.js'
import { Details } from './Details.js'
import { Slider } from './Slider.js'
import { cacheStats, clearTileCache } from './tileCache.js'

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

export function App() {
  const [data, setData] = useState<Dataset | null>(null)
  const [error, setError] = useState<string | null>(null)
  // null until the dataset is loaded, because the floor comes from the pipeline's own sag.
  const [sagPct, setSagPct] = useState<number | null>(null)
  const [minScore, setMinScore] = useState(0)
  const [minLength, setMinLength] = useState(0)
  const [minExposure, setMinExposure] = useState(0)
  const [maxCanopy, setMaxCanopy] = useState(100)
  const [maxOffLevel, setMaxOffLevel] = useState(100)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [basemapMix, setBasemapMix] = useState(0)
  const [showLines, setShowLines] = useState(true)
  const [showFilters, setShowFilters] = useState(true)
  const [anchorDump, setAnchorDump] = useState<AnchorDump | null>(null)
  const [hotspots, setHotspots] = useState<Hotspots | null>(null)
  const [custom, setCustom] = useState<CustomPoints>({ a: null, b: null })
  // null means "as level and as high as the ground allows", the same choice the search makes.
  const [rig, setRig] = useState<RigHeights | null>(null)
  // Bumped when a terrain fetch actually delivers something new, which is what re-measurement
  // depends on. Keeping it a counter rather than storing the measurement means the planned line is
  // computed, not held in state, so no effect has to write it.
  const [terrainVersion, setTerrainVersion] = useState(0)
  const [terrainFailed, setTerrainFailed] = useState(false)
  const [layerError, setLayerError] = useState<string | null>(null)

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}candidates.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: Dataset) => {
        // A file from an older pipeline would otherwise fail deep inside rendering, which reads as
        // a broken app rather than as stale output.
        if (!d.meta?.regions?.length) throw new Error('no regions in it — re-run `npm run pipeline`')
        setData(d)
        setSagPct(d.meta.params.sagRatio * 100)
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

  /**
   * The "where is anything possible at all" layer. Fetched on demand like the anchor dump, but
   * unlike it this one ships: it is a few tens of kilobytes and is the only view that stays
   * meaningful as the searched area grows.
   */
  const toggleHotspots = () => {
    if (hotspots) {
      setHotspots(null)
      return
    }
    setLayerError(null)
    fetch(`${import.meta.env.BASE_URL}hotspots.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setHotspots)
      .catch(() => setLayerError('hotspots.json missing — run `npm run pipeline`'))
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

  if (error) return <div className="loading">Failed to load candidates.json &mdash; {error}</div>
  if (!data || sagPct === null) return <div className="loading">Loading&hellip;</div>

  const { stats, regions } = data.meta
  const aoiCount = regions.reduce((n, r) => n + r.aois.length, 0)
  const areaKm2 = regions.reduce((s, r) => s + r.width * r.height, 0) / 1e6
  const groundMin = Math.min(...regions.map((r) => r.groundMin))
  const groundMax = Math.max(...regions.map((r) => r.groundMax))
  const maxScore = Math.ceil(Math.max(...data.candidates.map((c) => c.score), 1))
  const maxLen = Math.ceil(Math.max(...data.candidates.map((c) => c.length), 100))
  const maxExp = Math.ceil(Math.max(...data.candidates.map((c) => c.exposure), 10))
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
            <button data-active={!!hotspots} onClick={toggleHotspots}>
              {hotspots ? `${hotspots.lat.length.toLocaleString()} hotspots` : 'hotspots'}
            </button>
            <button data-active={!!anchorDump} onClick={toggleAnchors}>
              {anchorDump ? `${anchorDump.lat.length.toLocaleString()} anchors` : 'anchors'}
            </button>
            <button data-active={showFilters} onClick={() => setShowFilters(!showFilters)}>
              filters
            </button>
          </div>
          {layerError && <div className="togglenote">{layerError}</div>}

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
            hotspots={hotspots}
            custom={custom}
            showLines={showLines}
            onSelect={setSelectedId}
            onSetCustom={setCustomPoint}
            onClearCustom={clearCustom}
            onMoveAnchor={moveAnchor}
          />

          {(selected || planPending) && (
            <Details
              c={selected}
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
