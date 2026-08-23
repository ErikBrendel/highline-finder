import { useEffect, useMemo, useState } from 'react'
import type { Candidate, Dataset } from '../shared/types.js'
import { BASEMAPS, MapView, type BasemapKey } from './MapView.js'
import { ProfileChart } from './ProfileChart.js'

type SortKey = 'score' | 'length' | 'exposure' | 'offlevel'

function scoreColor(score: number): string {
  if (score >= 70) return '#22c55e'
  if (score >= 60) return '#a3e635'
  if (score >= 50) return '#f59e0b'
  return '#64748b'
}

function Slider({
  label, value, min, max, step, unit, onChange,
}: {
  label: string; value: number; min: number; max: number; step: number; unit: string
  onChange: (v: number) => void
}) {
  return (
    <div className="filter">
      <label>
        <span>{label}</span>
        <span>{value}{unit}</span>
      </label>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  )
}

export function App() {
  const [data, setData] = useState<Dataset | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [minLength, setMinLength] = useState(0)
  const [minExposure, setMinExposure] = useState(0)
  const [maxCanopy, setMaxCanopy] = useState(100)
  const [maxOffLevel, setMaxOffLevel] = useState(100)
  const [sort, setSort] = useState<SortKey>('score')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [basemap, setBasemap] = useState<BasemapKey>('ortho')

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}candidates.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setError(String(e)))
  }, [])

  const visible = useMemo(() => {
    if (!data) return []
    const out = data.candidates.filter(
      (c) =>
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
  }, [data, minLength, minExposure, maxCanopy, maxOffLevel, sort])

  const selected = useMemo(
    () => visible.find((c) => c.id === selectedId) ?? null,
    [visible, selectedId],
  )

  if (error) return <div className="loading">Failed to load candidates.json &mdash; {error}</div>
  if (!data) return <div className="loading">Loading&hellip;</div>

  const { stats, aoi } = data.meta
  const maxLen = Math.ceil(Math.max(...data.candidates.map((c) => c.length), 100))
  const maxExp = Math.ceil(Math.max(...data.candidates.map((c) => c.exposure), 10))
  // The pipeline already caps offlevel, so the slider only needs to reach that cap.
  const offLevelCap = Math.ceil(data.meta.params.maxOffLevelRatio * 100 * 10) / 10

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
            <h2>Filters</h2>
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
              {visible.length} of {data.candidates.length} shown
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
            {(Object.keys(BASEMAPS) as BasemapKey[]).map((k) => (
              <button key={k} data-active={basemap === k} onClick={() => setBasemap(k)}>
                {BASEMAPS[k].label}
              </button>
            ))}
          </div>

          <MapView
            data={data}
            visible={visible}
            selected={selected}
            basemap={basemap}
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
