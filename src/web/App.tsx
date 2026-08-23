import { useEffect, useMemo, useState } from 'react'
import type { AnchorDump, Candidate, Dataset } from '../shared/types.js'
import { rescoreAtSag } from '../shared/scoring.js'
import { BASEMAPS, MIX_MAX, MapView, type CustomPoints } from './MapView.js'
import { toUtm33 } from '../shared/geo.js'
import { PLANNED_ID, planLine, type PlannedLine } from '../shared/plan.js'
import { ensureTerrain, groundSampler, surfaceSampler } from './terrain.js'
import { ProfileChart } from './ProfileChart.js'
import { cacheStats, clearTileCache } from './tileCache.js'

function scoreColor(score: number): string {
  if (score >= 70) return '#22c55e'
  if (score >= 60) return '#a3e635'
  if (score >= 50) return '#f59e0b'
  return '#64748b'
}

function Slider({
  label, value, min, max, step, unit, format, onChange,
}: {
  label: string; value: number; min: number; max: number; step: number; unit: string
  format?: (v: number) => string
  onChange: (v: number) => void
}) {
  return (
    <div className="filter">
      <label>
        <span>{label}</span>
        <span>{format ? format(value) : value}{unit}</span>
      </label>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
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
  const [custom, setCustom] = useState<CustomPoints>({ a: null, b: null })
  // Bumped when a terrain fetch actually delivers something new, which is what re-measurement
  // depends on. Keeping it a counter rather than storing the measurement means the planned line is
  // computed, not held in state, so no effect has to write it.
  const [terrainVersion, setTerrainVersion] = useState(0)
  const [terrainFailed, setTerrainFailed] = useState(false)
  const [anchorError, setAnchorError] = useState<string | null>(null)

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}candidates.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: Dataset) => {
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
        if (!stale && arrived) setTerrainVersion((v) => v + 1)
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
    )
  }, [data, customUtm, sagPct, terrainVersion])

  const planError =
    customUtm && !planned
      ? terrainFailed
        ? 'could not load elevation for this area'
        : 'no elevation data here yet'
      : null

  /**
   * Moving or placing an anchor. Selection happens here rather than in an effect: it is a
   * consequence of the click, and an effect that both reads and writes the selection is exactly
   * what produced a maximum-update-depth loop before.
   */
  const setCustomPoint = (which: 'a' | 'b', at: { lat: number; lon: number } | null) => {
    setCustom((prev) => ({ ...prev, [which]: at }))
    const other = which === 'a' ? custom.b : custom.a
    if (at && other) setSelectedId(PLANNED_ID)
    if (!at) setSelectedId((cur) => (cur === PLANNED_ID ? null : cur))
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
    setAnchorError(null)
    fetch(`${import.meta.env.BASE_URL}anchors.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setAnchorDump)
      .catch(() => setAnchorError('anchors.json missing — run `npm run pipeline`'))
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

  const { stats, aoi } = data.meta
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
          {aoi.south.toFixed(4)},{aoi.west.toFixed(4)} &rarr; {aoi.north.toFixed(4)},{aoi.east.toFixed(4)}
          {' · '}{stats.aoiWidth}&times;{stats.aoiHeight} m
          {' · '}terrain {stats.groundMin}&ndash;{stats.groundMax} m
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
            <button data-active={!!anchorDump} onClick={toggleAnchors}>
              {anchorDump ? `${anchorDump.lat.length.toLocaleString()} anchors` : 'anchors'}
            </button>
            <button data-active={showFilters} onClick={() => setShowFilters(!showFilters)}>
              filters
            </button>
          </div>
          {anchorError && <div className="togglenote">{anchorError}</div>}

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

        {planError && <div className="planerror">{planError}</div>}

          <MapView
            data={data}
            visible={visible}
            selected={selected}
            basemapMix={basemapMix}
            anchorDump={anchorDump}
            custom={custom}
            showLines={showLines}
            onSelect={setSelectedId}
            onSetCustom={setCustomPoint}
          />

          {selected && (
            <div className="details">
              <div className="head">
                <strong
                  style={{ color: selected.id === PLANNED_ID ? '#22c55e' : scoreColor(selected.score) }}
                >
                  {selected.id === PLANNED_ID ? 'Planned line · ' : ''}Score {selected.score.toFixed(1)}
                </strong>
                <span className="sub">
                  {selected.length.toFixed(0)} m &middot; bearing {selected.bearing.toFixed(0)}&deg;
                  &middot; midspan sag {selected.sag.toFixed(1)} m
                  &middot; offlevel {selected.offLevel.toFixed(1)} m (
                  {(selected.offLevelRatio * 100).toFixed(2)} %)
                </span>
                <button className="close" onClick={() => setSelectedId(null)}>close</button>
              </div>

              <div className="cols">
                <div className="chart">
                  <ProfileChart c={selected} />
                  <div className="legend">
                    <span><i style={{ background: 'var(--ground)' }} />terrain (DGM 1 m)</span>
                    <span><i style={{ background: 'var(--canopy)' }} />canopy / structures (bDOM)</span>
                    <span><i style={{ background: 'var(--line)' }} />line with sag</span>
                  </div>
                </div>

                <dl className="stats">
                  <dt>Exposure (max air)</dt>
                  <dd>{selected.exposure.toFixed(1)} m</dd>
                  <dt>Min terrain clearance</dt>
                  <dd>{selected.clearanceMin.toFixed(1)} m</dd>
                  <dt>Min canopy clearance</dt>
                  <dd className={selected.canopyClearanceMin < 0 ? 'neg' : ''}>
                    {selected.canopyClearanceMin.toFixed(1)} m
                  </dd>
                  <dt>Canopy blocked</dt>
                  <dd className={selected.canopyBlockedFraction > 0 ? 'neg' : ''}>
                    {(selected.canopyBlockedFraction * 100).toFixed(0)} %
                  </dd>
                  <dt>Offlevel</dt>
                  <dd>
                    {selected.offLevel.toFixed(2)} m &middot;{' '}
                    {(selected.offLevelRatio * 100).toFixed(2)} %
                  </dd>
                  <dt>Ground A / B</dt>
                  <dd>{selected.a.ground.toFixed(1)} / {selected.b.ground.toFixed(1)} m</dd>
                  <dt>Rig height A / B</dt>
                  <dd>+{selected.a.aFrame.toFixed(2)} / +{selected.b.aFrame.toFixed(2)} m</dd>
                  <dt>Score: exp / len / canopy / margin / level</dt>
                  <dd>
                    {(selected.scoreParts.exposure * 100).toFixed(0)}/
                    {(selected.scoreParts.length * 100).toFixed(0)}/
                    {(selected.scoreParts.canopy * 100).toFixed(0)}/
                    {(selected.scoreParts.margin * 100).toFixed(0)}/
                    {(selected.scoreParts.level * 100).toFixed(0)}
                  </dd>
                </dl>
              </div>

              {selected.id === PLANNED_ID && planned && planned.violations.length > 0 && (
                <div className="violations">
                  <b>Would not qualify as a candidate:</b>
                  <ul>
                    {planned.violations.map((v) => (
                      <li key={v}>{v}</li>
                    ))}
                  </ul>
                </div>
              )}
              {selected.id === PLANNED_ID && planned && planned.violations.length === 0 && (
                <div className="note" style={{ margin: '8px 0 0' }}>
                  Meets every hard constraint — the search would have accepted this line.
                </div>
              )}

              <div className="anchors">
                A{' '}
                <a href={`geo:${selected.a.lat},${selected.a.lon}`}>
                  {selected.a.lat.toFixed(6)}, {selected.a.lon.toFixed(6)}
                </a>
                {'  —  B '}
                <a href={`geo:${selected.b.lat},${selected.b.lon}`}>
                  {selected.b.lat.toFixed(6)}, {selected.b.lon.toFixed(6)}
                </a>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
