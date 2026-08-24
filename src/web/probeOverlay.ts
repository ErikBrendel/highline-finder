import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl'
import { toWgs84 } from '../shared/geo.js'

/**
 * Shows every position the optimiser measured, as a spark that fades over a second.
 *
 * The walk is otherwise a pair of markers drifting for reasons only it can see. Drawing what it
 * actually looked at makes the search legible -- and specifically makes *reach* legible, which is
 * the one control with no other visible effect: at 1x the sparks are a tight cloud around each
 * anchor, and every doubling spreads them visibly wider over the same 36 points. That is what
 * spamming the button buys, and there is no way to say it in a label.
 *
 * Built like the elevation-window overlay next door: a GeoJSON source and requestAnimationFrame,
 * never React state, because a frame's worth of probes arrives ten times a second.
 *
 * The one difference is where the fade lives. That overlay has dozens of features and can afford a
 * per-feature opacity recomputed each frame; this one has thousands, so rewriting the source at
 * 60 Hz would be the most expensive thing on the page. Instead each spark stores its birth time and
 * the *layer* carries an opacity expression with the current clock baked into it -- one paint
 * property per frame for a smooth per-spark fade, and the source only rewritten when new probes
 * land.
 */

const SOURCE = 'optimizerProbes'
const LAYER = 'optimizerProbes'

/** How long a spark takes to fade out. */
const LIFE_MS = 1000
const PEAK_OPACITY = 0.85

/**
 * Most sparks kept alive at once. A frame at full tilt emits a few hundred, so a second of them is
 * a few thousand; this is a backstop against a pathological run, not a working limit.
 */
const MAX_LIVE = 6000

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

const listeners = new Set<(points: number[]) => void>()

/** Reports one frame's probes as flat EPSG:25833 pairs: `[e, n, e, n, ...]`. */
export function emitProbes(points: number[]): void {
  listeners.forEach((fn) => fn(points))
}

export function installProbeOverlay(m: MlMap): () => void {
  m.addSource(SOURCE, { type: 'geojson', data: EMPTY })
  m.addLayer({
    id: LAYER,
    type: 'circle',
    source: SOURCE,
    paint: {
      'circle-color': '#38bdf8',
      'circle-radius': 3,
      'circle-blur': 0.8,
      'circle-opacity': 0,
    },
  })

  let live: GeoJSON.Feature[] = []
  let newest = 0
  let raf = 0

  const setData = () => {
    ;(m.getSource(SOURCE) as GeoJSONSource | undefined)?.setData(
      live.length ? { type: 'FeatureCollection', features: live } : EMPTY,
    )
  }

  /** Opacity as a function of each spark's own age, with the clock baked in as a literal. */
  const fadeAt = (now: number) => [
    'max',
    0,
    ['*', PEAK_OPACITY, ['-', 1, ['/', ['-', now, ['get', 't']], LIFE_MS]]],
  ]

  /**
   * Expired sparks are left in the buffer rather than swept every frame: the expression already
   * clamps them to invisible, and filtering thousands of features at 60 Hz to remove what nobody
   * can see would cost more than drawing them. They go on the next arrival, or all at once when
   * the last of them has faded.
   */
  const frame = (now: number) => {
    raf = 0
    m.setPaintProperty(LAYER, 'circle-opacity', fadeAt(now))
    if (now - newest < LIFE_MS) {
      raf = requestAnimationFrame(frame)
      return
    }
    live = []
    setData()
  }

  const onProbes = (points: number[]) => {
    const t = performance.now()
    live = live.filter((f) => t - (f.properties!.t as number) < LIFE_MS)
    for (let i = 0; i + 1 < points.length; i += 2) {
      const { lat, lon } = toWgs84(points[i]!, points[i + 1]!)
      live.push({
        type: 'Feature',
        properties: { t },
        geometry: { type: 'Point', coordinates: [lon, lat] },
      })
    }
    if (live.length > MAX_LIVE) live = live.slice(live.length - MAX_LIVE)
    newest = t
    setData()
    if (!raf) raf = requestAnimationFrame(frame)
  }
  listeners.add(onProbes)

  return () => {
    listeners.delete(onProbes)
    if (raf) cancelAnimationFrame(raf)
    live = []
    if (m.getLayer(LAYER)) m.removeLayer(LAYER)
    if (m.getSource(SOURCE)) m.removeSource(SOURCE)
  }
}
