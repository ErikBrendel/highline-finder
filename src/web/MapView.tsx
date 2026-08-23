import { useEffect, useRef } from 'react'
import maplibregl, { type Map as MlMap } from 'maplibre-gl'
import type { Candidate, Dataset } from '../shared/types.js'
import { cachedUrl } from './tileCache.js'

/**
 * Basemaps come straight from the LGB WMS endpoints, which serve EPSG:3857 -- so MapLibre's
 * {bbox-epsg-3857} raster template works without a reprojecting proxy. Attribution is not
 * decoration here: dl-de/by-2.0 requires naming GeoBasis-DE/LGB wherever the data is shown.
 */
const LGB_ATTR = '&copy; GeoBasis-DE/LGB (dl-de/by-2.0)'
const wms = (path: string, layer: string) =>
  cachedUrl(
    `https://isk.geobasis-bb.de/mapproxy/${path}/service/wms?SERVICE=WMS&VERSION=1.3.0` +
      `&REQUEST=GetMap&LAYERS=${layer}&STYLES=&CRS=EPSG:3857&WIDTH=256&HEIGHT=256` +
      `&FORMAT=image/png&TRANSPARENT=false&BBOX={bbox-epsg-3857}`,
  )

export const BASEMAPS = {
  ortho: { label: 'Orthophoto', tiles: wms('dop20c', 'bebb_dop20c'), attribution: LGB_ATTR },
  hillshade: { label: 'Hillshade', tiles: wms('dgm', 'dgmshade'), attribution: LGB_ATTR },
  osm: {
    label: 'OSM',
    tiles: cachedUrl('https://tile.openstreetmap.org/{z}/{x}/{y}.png'),
    attribution: '&copy; OpenStreetMap contributors',
  },
} as const

export type BasemapKey = keyof typeof BASEMAPS

const SCORE_COLOR: maplibregl.ExpressionSpecification = [
  'interpolate', ['linear'], ['get', 'score'],
  35, '#64748b',
  50, '#f59e0b',
  60, '#a3e635',
  70, '#22c55e',
]

/**
 * Feature ids must be numeric: MapLibre cannot use a non-numeric string id with feature-state, and
 * a paint expression that reads feature-state on such a source silently fails to render. So the id
 * is the array index and the candidate's own id travels in `properties.cid`.
 */
function toGeoJson(cs: Candidate[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: cs.map((c, i) => ({
      type: 'Feature',
      id: i,
      properties: { cid: c.id, score: c.score, length: c.length },
      geometry: { type: 'LineString', coordinates: [[c.a.lon, c.a.lat], [c.b.lon, c.b.lat]] },
    })),
  }
}

interface Props {
  data: Dataset
  visible: Candidate[]
  selected: Candidate | null
  basemap: BasemapKey
  onSelect: (id: string | null) => void
}

export function MapView({ data, visible, selected, basemap, onSelect }: Props) {
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<MlMap | null>(null)
  const markers = useRef<maplibregl.Marker[]>([])
  const ready = useRef(false)
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect

  useEffect(() => {
    if (!el.current || map.current) return
    const { aoi } = data.meta
    const bm = BASEMAPS[basemap]
    const m = new maplibregl.Map({
      container: el.current,
      style: {
        version: 8,
        sources: {
          base: { type: 'raster', tiles: [bm.tiles], tileSize: 256, attribution: bm.attribution },
        },
        layers: [
          { id: 'bg', type: 'background', paint: { 'background-color': '#0f1115' } },
          { id: 'base', type: 'raster', source: 'base' },
        ],
      },
      bounds: [[aoi.west, aoi.south], [aoi.east, aoi.north]],
      fitBoundsOptions: { padding: 40 },
    })
    map.current = m
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left')
    m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left')

    m.on('load', () => {
      m.addSource('aoi', {
        type: 'geojson',
        data: {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'LineString',
            coordinates: [
              [aoi.west, aoi.south], [aoi.east, aoi.south],
              [aoi.east, aoi.north], [aoi.west, aoi.north], [aoi.west, aoi.south],
            ],
          },
        },
      })
      m.addLayer({
        id: 'aoi',
        type: 'line',
        source: 'aoi',
        paint: { 'line-color': '#38bdf8', 'line-width': 1, 'line-dasharray': [3, 3], 'line-opacity': 0.5 },
      })

      m.addSource('lines', { type: 'geojson', data: toGeoJson(visible) })
      m.addLayer({
        id: 'lines-hit',
        type: 'line',
        source: 'lines',
        paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 14 },
      })
      m.addLayer({
        id: 'lines',
        type: 'line',
        source: 'lines',
        paint: {
          'line-color': SCORE_COLOR,
          'line-width': ['case', ['boolean', ['feature-state', 'sel'], false], 4, 1.8],
          'line-opacity': ['case', ['boolean', ['feature-state', 'sel'], false], 1, 0.7],
        },
      })

      // Anchors are DOM markers rather than a symbol layer: labelled text would need a `glyphs`
      // source in the style, and there is no reason to fetch a font for two letters.
      m.on('click', 'lines-hit', (e) => {
        const f = e.features?.[0]
        if (f) onSelectRef.current(String(f.properties!.cid))
      })
      m.on('click', (e) => {
        if (!m.queryRenderedFeatures(e.point, { layers: ['lines-hit'] }).length) {
          onSelectRef.current(null)
        }
      })
      m.on('mouseenter', 'lines-hit', () => { m.getCanvas().style.cursor = 'pointer' })
      m.on('mouseleave', 'lines-hit', () => { m.getCanvas().style.cursor = '' })

      ready.current = true
    })
    return () => {
      markers.current.forEach((mk) => mk.remove())
      markers.current = []
      m.remove()
      map.current = null
      ready.current = false
    }
  }, [data])

  useEffect(() => {
    const m = map.current
    if (!m || !ready.current) return
    const src = m.getSource('lines') as maplibregl.GeoJSONSource | undefined
    src?.setData(toGeoJson(visible))
  }, [visible])

  useEffect(() => {
    const m = map.current
    if (!m || !ready.current) return

    m.removeFeatureState({ source: 'lines' })
    const index = selected ? visible.findIndex((c) => c.id === selected.id) : -1
    if (index >= 0) m.setFeatureState({ source: 'lines', id: index }, { sel: true })

    markers.current.forEach((mk) => mk.remove())
    markers.current = selected
      ? ([['A', selected.a], ['B', selected.b]] as const).map(([label, pt]) => {
          const node = document.createElement('div')
          node.className = 'anchor-marker'
          node.textContent = label
          return new maplibregl.Marker({ element: node }).setLngLat([pt.lon, pt.lat]).addTo(m)
        })
      : []
  }, [selected, visible])

  useEffect(() => {
    const m = map.current
    if (!m || !ready.current) return
    const bm = BASEMAPS[basemap]
    const src = m.getSource('base') as maplibregl.RasterTileSource | undefined
    src?.setTiles([bm.tiles])
  }, [basemap])

  return <div id="map" ref={el} />
}
