import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl'
import { toWgs84 } from '../shared/geo.js'
import { onWindowActivity, windowBounds } from './terrain.js'

/**
 * Shows where elevation data is being fetched, on the map, in place.
 *
 * The planner pulls a 256 m window at a time, and until now the only sign of that was the panel
 * filling in a moment later. Drawing each window as it loads makes the whole mechanism legible: you
 * can see the band being fetched along a line, which of it was already cached, and when it landed.
 *
 * Animated with requestAnimationFrame and a data-driven opacity rather than React state. A drag
 * touches windows several times a second and the fade needs per-frame values, so a re-render per
 * step would be both slower and less smooth. The loop only runs while something is on screen.
 */

const SOURCE = 'terrainWindows'
const FILL = 'terrainWindowFill'
const EDGE = 'terrainWindowEdge'

/** One pulse of a window still loading. */
const PULSE_MS = 1200
/** How long the arrival flash takes to fade out. */
const FLASH_MS = 700

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

interface Tracked {
  kind: 'loading' | 'loaded' | 'failed'
  since: number
  ring: [number, number][]
}

function ringOf(tx: number, ty: number): [number, number][] {
  const { e0, n0, size } = windowBounds(tx, ty)
  const corners: [number, number][] = [
    [e0, n0],
    [e0 + size, n0],
    [e0 + size, n0 + size],
    [e0, n0 + size],
    [e0, n0],
  ]
  return corners.map(([e, n]) => {
    const { lat, lon } = toWgs84(e, n)
    return [lon, lat]
  })
}

export function installLoadingOverlay(m: MlMap): () => void {
  m.addSource(SOURCE, { type: 'geojson', data: EMPTY })
  m.addLayer({
    id: FILL,
    type: 'fill',
    source: SOURCE,
    paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'o'] },
  })
  m.addLayer({
    id: EDGE,
    type: 'line',
    source: SOURCE,
    paint: {
      'line-color': ['get', 'color'],
      'line-opacity': ['get', 'o'],
      'line-width': 1,
    },
  })

  const tracked = new Map<string, Tracked>()
  let raf = 0

  const frame = (now: number) => {
    raf = 0
    const features: GeoJSON.Feature[] = []
    for (const [key, w] of tracked) {
      const age = now - w.since
      let o: number
      if (w.kind === 'loading') {
        o = 0.16 + 0.09 * Math.sin((age / PULSE_MS) * Math.PI * 2)
      } else {
        if (age > FLASH_MS) {
          tracked.delete(key)
          continue
        }
        o = 0.5 * (1 - age / FLASH_MS)
      }
      features.push({
        type: 'Feature',
        properties: { o, color: COLORS[w.kind] },
        geometry: { type: 'Polygon', coordinates: [w.ring] },
      })
    }
    const src = m.getSource(SOURCE) as GeoJSONSource | undefined
    src?.setData({ type: 'FeatureCollection', features })
    if (tracked.size) raf = requestAnimationFrame(frame)
  }

  const unsubscribe = onWindowActivity(({ tx, ty, state }) => {
    const key = `${tx}_${ty}`
    const ring = tracked.get(key)?.ring ?? ringOf(tx, ty)
    tracked.set(key, { kind: state, since: performance.now(), ring })
    if (!raf) raf = requestAnimationFrame(frame)
  })

  return () => {
    unsubscribe()
    if (raf) cancelAnimationFrame(raf)
    for (const id of [FILL, EDGE]) if (m.getLayer(id)) m.removeLayer(id)
    if (m.getSource(SOURCE)) m.removeSource(SOURCE)
  }
}

const COLORS: Record<Tracked['kind'], string> = {
  loading: '#d7dbe4',
  loaded: '#22c55e',
  failed: '#f43f5e',
}
