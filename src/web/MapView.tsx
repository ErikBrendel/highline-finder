import { useEffect, useRef } from 'react'
import maplibregl, { type Map as MlMap } from 'maplibre-gl'
import type { Candidate, Dataset } from '../shared/types.js'

/**
 * Basemaps come straight from the LGB WMS endpoints, which serve EPSG:3857 -- so MapLibre's
 * {bbox-epsg-3857} raster template works without a reprojecting proxy. Attribution is not
 * decoration here: dl-de/by-2.0 requires naming GeoBasis-DE/LGB wherever the data is shown.
 */
const LGB_ATTR = '&copy; GeoBasis-DE/LGB (dl-de/by-2.0)'
const wms = (path: string, layer: string) =>
  `https://isk.geobasis-bb.de/mapproxy/${path}/service/wms?SERVICE=WMS&VERSION=1.3.0` +
  `&REQUEST=GetMap&LAYERS=${layer}&STYLES=&CRS=EPSG:3857&WIDTH=256&HEIGHT=256` +
  `&FORMAT=image/png&TRANSPARENT=false&BBOX={bbox-epsg-3857}`

export const BASEMAPS = {
  ortho: { label: 'Orthophoto', tiles: wms('dop20c', 'bebb_dop20c'), attribution: LGB_ATTR },
  hillshade: { label: 'Hillshade', tiles: wms('dgm', 'dgmshade'), attribution: LGB_ATTR },
  osm: {
    label: 'OSM',
    tiles: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
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

function toGeoJson(cs: Candidate[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: cs.map((c) => ({
      type: 'Feature',
      id: c.id,
      properties: { id: c.id, score: c.score, length: c.length },
      geometry: { type: 'LineString', coordinates: [[c.a.lon, c.a.lat], [c.b.lon, c.b.lat]] },
    })),
  }
}

function anchorGeoJson(c: Candidate | null): GeoJSON.FeatureCollection {
  if (!c) return { type: 'FeatureCollection', features: [] }
  return {
    type: 'FeatureCollection',
    features: [c.a, c.b].map((p, i) => ({
      type: 'Feature',
      properties: { label: i === 0 ? 'A' : 'B' },
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
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

      m.addSource('anchors', { type: 'geojson', data: anchorGeoJson(null) })
      m.addLayer({
        id: 'anchors',
        type: 'circle',
        source: 'anchors',
        paint: {
          'circle-radius': 6,
          'circle-color': '#f43f5e',
          'circle-stroke-width': 2,
          'circle-stroke-color': '#fff',
        },
      })
      m.addLayer({
        id: 'anchor-labels',
        type: 'symbol',
        source: 'anchors',
        layout: { 'text-field': ['get', 'label'], 'text-offset': [0, -1.4], 'text-size': 12 },
        paint: { 'text-color': '#fff', 'text-halo-color': '#000', 'text-halo-width': 1.5 },
      })

      m.on('click', 'lines-hit', (e) => {
        const f = e.features?.[0]
        if (f) onSelectRef.current(String(f.properties!.id))
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
    return () => { m.remove(); map.current = null; ready.current = false }
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
    if (selected) m.setFeatureState({ source: 'lines', id: selected.id }, { sel: true })
    const src = m.getSource('anchors') as maplibregl.GeoJSONSource | undefined
    src?.setData(anchorGeoJson(selected))
  }, [selected])

  useEffect(() => {
    const m = map.current
    if (!m || !ready.current) return
    const bm = BASEMAPS[basemap]
    const src = m.getSource('base') as maplibregl.RasterTileSource | undefined
    src?.setTiles([bm.tiles])
  }, [basemap])

  return <div id="map" ref={el} />
}
