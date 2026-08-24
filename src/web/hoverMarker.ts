import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl'

/**
 * Puts a dot on the map wherever the pointer is over the profile chart.
 *
 * The chart is the only place a line's features are legible -- the notch it threads, the stand of
 * trees it clips -- and until now there was no way to find any of them on the ground. Reading a
 * distance off the axis and estimating along the line by eye is exactly the kind of thing a
 * computer should do.
 *
 * Driven by a module-level callback rather than React state, like the two overlays next door. A
 * pointer crossing the chart fires sixty times a second and the map is a large component; routing
 * that through a re-render would cost far more than moving one point.
 */

const SOURCE = 'profileHover'
const HALO = 'profileHoverHalo'
const DOT = 'profileHoverDot'

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

let show: ((lat: number, lon: number) => void) | null = null
let hide: (() => void) | null = null

/** Null when the pointer leaves the chart. */
export function emitHoverPoint(at: { lat: number; lon: number } | null): void {
  if (at) show?.(at.lat, at.lon)
  else hide?.()
}

export function installHoverMarker(m: MlMap): () => void {
  m.addSource(SOURCE, { type: 'geojson', data: EMPTY })
  m.addLayer({
    id: HALO,
    type: 'circle',
    source: SOURCE,
    paint: { 'circle-color': '#38bdf8', 'circle-radius': 12, 'circle-blur': 0.9, 'circle-opacity': 0.8 },
  })
  m.addLayer({
    id: DOT,
    type: 'circle',
    source: SOURCE,
    paint: {
      'circle-color': '#e6e8ec',
      'circle-radius': 5,
      'circle-stroke-width': 2,
      'circle-stroke-color': '#0f1115',
    },
  })

  const src = () => m.getSource(SOURCE) as GeoJSONSource | undefined
  show = (lat, lon) =>
    src()?.setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [lon, lat] } }],
    })
  hide = () => src()?.setData(EMPTY)

  return () => {
    show = null
    hide = null
    for (const id of [DOT, HALO]) if (m.getLayer(id)) m.removeLayer(id)
    if (m.getSource(SOURCE)) m.removeSource(SOURCE)
  }
}
