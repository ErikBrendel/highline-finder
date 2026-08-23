import { useEffect, useRef } from 'react'
import maplibregl, { type Map as MlMap } from 'maplibre-gl'
import type { AnchorDump, Candidate, Dataset } from '../shared/types.js'
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

/** Sectors open in this anchor's mask, as compass bearings in degrees. */
function openBearings(mask: string, sectorCount: number): number[] {
  const out: number[] = []
  for (let s = 0; s < sectorCount; s++) {
    const nibble = parseInt(mask[s >> 2] ?? '0', 16)
    if (nibble & (1 << (s & 3))) out.push(((s + 0.5) / sectorCount) * 360)
  }
  return out
}

/** Collapses a list of open bearings into compass ranges, wrapping past north. */
function bearingRanges(bearings: number[], sectorCount: number): string {
  if (!bearings.length) return 'none'
  if (bearings.length === sectorCount) return 'all round'
  const width = 360 / sectorCount
  const groups: [number, number][] = []
  for (const b of bearings) {
    const last = groups[groups.length - 1]
    if (last && Math.abs(b - last[1]) < width * 1.5) last[1] = b
    else groups.push([b, b])
  }
  // A run touching both ends of the circle is one range through north.
  if (groups.length > 1) {
    const first = groups[0]!
    const last = groups[groups.length - 1]!
    if (first[0] < width && last[1] > 360 - width * 1.5) {
      groups.pop()
      first[0] = last[0]
      groups[0] = [last[0], first[1]]
    }
  }
  return groups.map(([a, b]) => `${a.toFixed(0)}–${b.toFixed(0)}°`).join(', ')
}

function anchorPointsGeoJson(dump: AnchorDump | null): GeoJSON.FeatureCollection {
  if (!dump) return { type: 'FeatureCollection', features: [] }
  return {
    type: 'FeatureCollection',
    features: dump.lat.map((lat, i) => ({
      type: 'Feature',
      properties: {
        ground: dump.ground[i]!,
        open: dump.open[i]!,
        openCount: openBearings(dump.open[i]!, dump.sectorCount).length,
      },
      geometry: { type: 'Point', coordinates: [dump.lon[i]!, lat] },
    })),
  }
}

interface Props {
  data: Dataset
  visible: Candidate[]
  selected: Candidate | null
  basemap: BasemapKey
  anchorDump: AnchorDump | null
  onSelect: (id: string | null) => void
}

export function MapView({ data, visible, selected, basemap, anchorDump, onSelect }: Props) {
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<MlMap | null>(null)
  const markers = useRef<maplibregl.Marker[]>([])
  const popup = useRef<maplibregl.Popup | null>(null)
  // Read inside map event handlers, which are registered once and outlive any single render.
  const sectorCount = useRef(64)
  const anchorRange = useRef<[number, number]>([0, 1.5])
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

      m.addSource('anchorDump', { type: 'geojson', data: anchorPointsGeoJson(null) })
      m.addLayer({
        id: 'anchorDump',
        type: 'circle',
        source: 'anchorDump',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 1.5, 16, 2.5, 19, 5],
          // How many directions a line could actually leave in: the whole point of the scan.
          'circle-color': [
            'interpolate', ['linear'], ['get', 'openCount'],
            1, '#7c3aed',
            16, '#2563eb',
            32, '#0891b2',
            48, '#10b981',
          ],
          'circle-opacity': 0.75,
        },
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

      popup.current = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        className: 'anchor-popup',
        offset: 8,
      })
      m.on('mousemove', 'anchorDump', (e) => {
        const f = e.features?.[0]
        if (!f || !popup.current) return
        const { ground, open, openCount } = f.properties as {
          ground: number; open: string; openCount: number
        }
        const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates as [number, number]
        popup.current
          .setLngLat(e.lngLat)
          .setHTML(
            `<b>anchor</b><br>${lat.toFixed(6)}, ${lon.toFixed(6)}<br>` +
              `ground ${ground.toFixed(1)} m<br>` +
              `rig ${(ground + anchorRange.current[0]).toFixed(1)}–${(ground + anchorRange.current[1]).toFixed(1)} m<br>` +
              `${openCount}/${sectorCount.current} sectors open<br>` +
              `<span class="dirs">${bearingRanges(openBearings(open, sectorCount.current), sectorCount.current)}</span>`,
          )
          .addTo(m)
      })
      m.on('mouseleave', 'anchorDump', () => popup.current?.remove())

      ready.current = true
    })
    return () => {
      popup.current?.remove()
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
    if (anchorDump) {
      sectorCount.current = anchorDump.sectorCount
      anchorRange.current = [anchorDump.aFrameMin, anchorDump.aFrameMax]
    } else {
      popup.current?.remove()
    }
    const src = m.getSource('anchorDump') as maplibregl.GeoJSONSource | undefined
    src?.setData(anchorPointsGeoJson(anchorDump))
  }, [anchorDump])

  useEffect(() => {
    const m = map.current
    if (!m || !ready.current) return
    const bm = BASEMAPS[basemap]
    const src = m.getSource('base') as maplibregl.RasterTileSource | undefined
    src?.setTiles([bm.tiles])
  }, [basemap])

  return <div id="map" ref={el} />
}
