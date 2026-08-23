import { useEffect, useMemo, useState } from 'react'
import type { AnchorDump, Candidate, Dataset } from '../shared/types.js'
import { rescoreAtSag } from '../shared/scoring.js'
import { BASEMAPS, MIX_MAX, MapView } from './MapView.js'
import { ProfileChart } from './ProfileChart.js'
import { cacheStats, clearTileCache } from './tileCache.js'

type SortKey = 'score' | 'length' | 'exposure' | 'offlevel'

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
  const [sort, setSort] = useState<SortKey>('score')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [basemapMix, setBasemapMix] = useState(0)
  const [anchorDump, setAnchorDump] = useState<AnchorDump | null>(null)
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
    const out = rescored.filter(
      (c) =>
        c.score >= minScore &&
        c.length >= minLength &&
        c.exposure >= minExposure &&
        c.canopyBlockedFraction * 100 <= maxCanopy &&
        c.offLevelRatio * 100 <= maxOffLevel,
    )
    const key: Record<SortKey, (c: Candidate) => number> = {
      score: (c) => c.score,
      length: (c) => c.length,
      exposure: (c) => c.exposure,
      // Lower is better, so negate to keep the shared descending sort.
      offlevel: (c) => -c.offLevelRatio,
    }
    return out.sort((a, b) => key[sort](b) - key[sort](a))
  }, [data, rescored, minScore, minLength, minExposure, maxCanopy, maxOffLevel, sort])

  const selected = useMemo(
    () => visible.find((c) => c.id === selectedId) ?? null,
    [visible, selectedId],
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
        <aside>
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
              {sagPct.toFixed(1)} %. Cannot go below {sagFloor.toFixed(1)} % &mdash; the dataset was
              generated there, so looser lines were never evaluated.
            </div>

            <h2 style={{ marginTop: 16 }}>Filters</h2>
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
            <h2 style={{ marginTop: 16 }}>Sort by</h2>
            <div className="sortrow">
              {(['score', 'length', 'exposure', 'offlevel'] as SortKey[]).map((k) => (
                <button key={k} data-active={sort === k} onClick={() => setSort(k)}>
                  {k}
                </button>
              ))}
            </div>
          </div>

          <div className="warn">
            Terrain clearance is enforced; canopy is only scored. A line with a high
            &ldquo;blocked&rdquo; figure runs through the trees and is not walkable as-is.
          </div>

          <div className="listing">
            <div className="count">
              {visible.length} of {rescored.length} shown
            </div>
            {visible.map((c) => (
              <div
                key={c.id}
                className="card"
                data-sel={c.id === selectedId}
                style={{ ['--sc' as string]: scoreColor(c.score) }}
                onClick={() => setSelectedId(c.id === selectedId ? null : c.id)}
              >
                <div className="top">
                  <span className="score" style={{ color: scoreColor(c.score) }}>
                    {c.score.toFixed(0)}
                  </span>
                  <span className="len">{c.length.toFixed(0)} m &middot; {c.bearing.toFixed(0)}&deg;</span>
                </div>
                <div className="bar">
                  <span><b>{c.exposure.toFixed(0)} m</b> air</span>
                  <span><b>{c.offLevel.toFixed(1)} m</b> offlevel</span>
                  <span><b>{(c.canopyBlockedFraction * 100).toFixed(0)}%</b> blocked</span>
                </div>
              </div>
            ))}
            {!visible.length && <div className="count">Nothing matches these filters.</div>}
          </div>
        </aside>

        <div className="mapwrap">
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

          <CacheBadge />

          {import.meta.env.DEV && (
            <div className="debugbar">
              <button data-active={!!anchorDump} onClick={toggleAnchors}>
                {anchorDump ? 'hide' : 'show'} anchors
              </button>
              {anchorDump && <span>{anchorDump.lat.length.toLocaleString()} points</span>}
              {anchorError && <span className="err">{anchorError}</span>}
            </div>
          )}

          <MapView
            data={data}
            visible={visible}
            selected={selected}
            basemapMix={basemapMix}
            anchorDump={anchorDump}
            onSelect={setSelectedId}
          />

          {selected && (
            <div className="details">
              <div className="head">
                <strong style={{ color: scoreColor(selected.score) }}>
                  Score {selected.score.toFixed(1)}
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
