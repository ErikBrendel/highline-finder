import { useEffect, useRef, useState } from 'react'
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

/**
 * Ordered bottom to top. All three are stacked as raster layers and cross-faded with
 * raster-opacity, rather than swapped: that lets the GPU blend them for free, where combining tile
 * images ourselves would mean decoding, blending and re-encoding every PNG.
 *
 * The blend steps in tenths rather than continuously, so a position is reproducible and the tile
 * cache sees a small fixed set of blends instead of a new one per pixel of slider travel.
 */
export const BASEMAPS = [
  { id: 'ortho', label: 'Ortho', tiles: wms('dop20c', 'bebb_dop20c'), attribution: LGB_ATTR },
  { id: 'hillshade', label: 'Hillshade', tiles: wms('dgm', 'dgmshade'), attribution: LGB_ATTR },
  {
    id: 'osm',
    label: 'OSM',
    tiles: cachedUrl('https://tile.openstreetmap.org/{z}/{x}/{y}.png'),
    attribution: '&copy; OpenStreetMap contributors',
  },
] as const

/** Highest mix value, one per gap between adjacent basemaps. */
export const MIX_MAX = BASEMAPS.length - 1

/**
 * Opacity of basemap `index` at mix position `mix`, where whole numbers are a pure basemap and
 * fractions cross-fade to the next one up. The bottom layer stays fully opaque so there is never
 * bare background showing through.
 */
export function basemapOpacity(index: number, mix: number): number {
  if (index === 0) return 1
  return Math.min(1, Math.max(0, mix - (index - 1)))
}

/**
 * Whether a layer needs to be rendered at all. A layer that is transparent, or completely hidden
 * behind an opaque layer above it, is switched off entirely -- MapLibre skips tile requests for a
 * hidden layer, so this is what stops all three basemaps downloading at once.
 */
export function basemapVisible(index: number, mix: number, count: number): boolean {
  if (basemapOpacity(index, mix) <= 0) return false
  for (let above = index + 1; above < count; above++) {
    if (basemapOpacity(above, mix) >= 1) return false
  }
  return true
}

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

const emptyCollection: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

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

/**
 * Open sectors of one anchor, drawn as wedges radiating from it.
 *
 * Contiguous open sectors are merged into a single wedge rather than drawn individually, so a
 * 20-sector arc reads as one lobe of openness instead of 20 slivers -- which is the thing worth
 * seeing, since openness is usually a couple of broad lobes with blocked ground between them.
 */
function sectorWedges(
  lat: number,
  lon: number,
  mask: string,
  sectorCount: number,
  metres: number,
): GeoJSON.FeatureCollection {
  const open = (s: number) =>
    ((parseInt(mask[((s % sectorCount) + sectorCount) % sectorCount >> 2] ?? '0', 16) >>
      (((s % sectorCount) + sectorCount) % sectorCount & 3)) &
      1) === 1

  // One degree of latitude is ~111.32 km; longitude shrinks with the cosine of latitude.
  const dLat = metres / 111320
  const dLon = metres / (111320 * Math.cos((lat * Math.PI) / 180))
  const edge = (bearingDeg: number): [number, number] => {
    const r = (bearingDeg * Math.PI) / 180
    return [lon + Math.sin(r) * dLon, lat + Math.cos(r) * dLat]
  }

  const runs: [number, number][] = []
  for (let s = 0; s < sectorCount; s++) {
    if (!open(s) || open(s - 1)) continue
    let end = s
    while (end - s < sectorCount && open(end + 1)) end++
    runs.push([s, end])
  }
  // Open in every direction: no run has a closed sector before it, so emit the full disc.
  if (!runs.length && open(0)) runs.push([0, sectorCount - 1])

  const width = 360 / sectorCount
  return {
    type: 'FeatureCollection',
    features: runs.map(([from, to]) => {
      const ring: [number, number][] = [[lon, lat]]
      for (let s = from; s <= to + 1; s++) ring.push(edge(s * width))
      ring.push([lon, lat])
      return {
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [ring] },
      }
    }),
  }
}

function anchorPointsGeoJson(dump: AnchorDump | null): GeoJSON.FeatureCollection {
  if (!dump) return { type: 'FeatureCollection', features: [] }
  return {
    type: 'FeatureCollection',
    features: dump.lat.map((lat, i) => ({
      type: 'Feature',
      properties: {
        ground: dump.ground[i]!,
        drop: dump.drop[i]!,
        open: dump.open[i]!,
        openCount: openBearings(dump.open[i]!, dump.sectorCount).length,
      },
      geometry: { type: 'Point', coordinates: [dump.lon[i]!, lat] },
    })),
  }
}

export interface CustomPoints {
  a: { lat: number; lon: number } | null
  b: { lat: number; lon: number } | null
}

interface Props {
  data: Dataset
  visible: Candidate[]
  selected: Candidate | null
  basemapMix: number
  anchorDump: AnchorDump | null
  custom: CustomPoints
  showLines: boolean
  onSelect: (id: string | null) => void
  onSetCustom: (which: 'a' | 'b', at: { lat: number; lon: number } | null) => void
}

export function MapView({
  data,
  visible,
  selected,
  basemapMix,
  anchorDump,
  custom,
  showLines,
  onSelect,
  onSetCustom,
}: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number; lat: number; lon: number } | null>(null)
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<MlMap | null>(null)
  const markers = useRef<maplibregl.Marker[]>([])
  const popup = useRef<maplibregl.Popup | null>(null)
  // Read inside map event handlers, which are registered once and outlive any single render.
  const sectorCount = useRef(64)
  const anchorRange = useRef<[number, number]>([0, 1.5])
  // How far the hover wedges reach; the scan's own near-field probe distance.
  const wedgeMetres = useRef(40)
  const dropRadius = useRef(25)
  const customMarkers = useRef<Partial<Record<'a' | 'b', maplibregl.Marker>>>({})
  const dragging = useRef<'a' | 'b' | null>(null)
  const onSetCustomRef = useRef(onSetCustom)
  onSetCustomRef.current = onSetCustom
  const ready = useRef(false)
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect

  useEffect(() => {
    if (!el.current || map.current) return
    const { aoi } = data.meta
    const m = new maplibregl.Map({
      container: el.current,
      style: {
        version: 8,
        sources: Object.fromEntries(
          BASEMAPS.map((b, i) => [
            `base${i}`,
            { type: 'raster', tiles: [b.tiles], tileSize: 256, attribution: b.attribution },
          ]),
        ),
        layers: [
          { id: 'bg', type: 'background', paint: { 'background-color': '#0f1115' } },
          ...BASEMAPS.map((_, i) => ({
            id: `base${i}`,
            type: 'raster' as const,
            source: `base${i}`,
            layout: { visibility: basemapVisible(i, basemapMix, BASEMAPS.length) ? 'visible' as const : 'none' as const },
            paint: { 'raster-opacity': basemapOpacity(i, basemapMix) },
          })),
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

      m.addSource('anchorWedge', { type: 'geojson', data: emptyCollection })
      m.addLayer({
        id: 'anchorWedgeFill',
        type: 'fill',
        source: 'anchorWedge',
        paint: { 'fill-color': '#38bdf8', 'fill-opacity': 0.22 },
      })
      m.addLayer({
        id: 'anchorWedgeEdge',
        type: 'line',
        source: 'anchorWedge',
        paint: { 'line-color': '#38bdf8', 'line-width': 1, 'line-opacity': 0.8 },
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

      // The planned line sits above the found ones: it is never filtered out, so it must never be
      // hidden behind them either.
      m.addSource('custom', { type: 'geojson', data: emptyCollection })
      m.addLayer({
        id: 'customCasing',
        type: 'line',
        source: 'custom',
        paint: { 'line-color': '#052e16', 'line-width': 8, 'line-opacity': 0.75 },
      })
      m.addLayer({
        id: 'custom',
        type: 'line',
        source: 'custom',
        paint: { 'line-color': '#22c55e', 'line-width': 3.5 },
      })
      m.on('click', 'custom', () => onSelectRef.current('custom'))
      m.on('mouseenter', 'custom', () => { m.getCanvas().style.cursor = 'pointer' })
      m.on('mouseleave', 'custom', () => { m.getCanvas().style.cursor = '' })

      // Anchor labels are DOM markers rather than a symbol layer: labelled text would need a
      // `glyphs` source in the style, and there is no reason to fetch a font for two letters.
      m.on('click', 'lines-hit', (e) => {
        const f = e.features?.[0]
        if (f) onSelectRef.current(String(f.properties!.cid))
      })
      m.on('click', (e) => {
        if (!m.queryRenderedFeatures(e.point, { layers: ['lines-hit'] }).length) {
          onSelectRef.current(null)
        }
      })
      m.on('contextmenu', (e) => {
        setMenu({ x: e.point.x, y: e.point.y, lat: e.lngLat.lat, lon: e.lngLat.lng })
      })
      m.on('movestart', () => setMenu(null))
      m.on('click', () => setMenu(null))

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
        const wedgeSrc = m.getSource('anchorWedge') as maplibregl.GeoJSONSource | undefined
        const { ground, drop, open, openCount } = f.properties as {
          ground: number; drop: number; open: string; openCount: number
        }
        const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates as [number, number]
        popup.current
          .setLngLat(e.lngLat)
          .setHTML(
            `<b>anchor</b><br>${lat.toFixed(6)}, ${lon.toFixed(6)}<br>` +
              `ground ${ground.toFixed(1)} m<br>` +
              `rig ${(ground + anchorRange.current[0]).toFixed(1)}–${(ground + anchorRange.current[1]).toFixed(1)} m<br>` +
              `drops <b>${drop.toFixed(1)} m</b> within ${dropRadius.current} m<br>` +
              `${openCount}/${sectorCount.current} sectors open<br>` +
              `<span class="dirs">${bearingRanges(openBearings(open, sectorCount.current), sectorCount.current)}</span>`,
          )
          .addTo(m)
        wedgeSrc?.setData(sectorWedges(lat, lon, open, sectorCount.current, wedgeMetres.current))
      })
      m.on('mouseleave', 'anchorDump', () => {
        popup.current?.remove()
        const wedgeSrc = m.getSource('anchorWedge') as maplibregl.GeoJSONSource | undefined
        wedgeSrc?.setData(emptyCollection)
      })

      ready.current = true
    })
    return () => {
      popup.current?.remove()
      Object.values(customMarkers.current).forEach((mk) => mk?.remove())
      customMarkers.current = {}
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
    const v = showLines ? 'visible' : 'none'
    for (const id of ['lines', 'lines-hit']) m.setLayoutProperty(id, 'visibility', v)
  }, [showLines])

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
      wedgeMetres.current = anchorDump.nearProbeLength
      dropRadius.current = anchorDump.dropSearchRadius
    } else {
      popup.current?.remove()
      const wedgeSrc = m.getSource('anchorWedge') as maplibregl.GeoJSONSource | undefined
      wedgeSrc?.setData(emptyCollection)
    }
    const src = m.getSource('anchorDump') as maplibregl.GeoJSONSource | undefined
    src?.setData(anchorPointsGeoJson(anchorDump))
  }, [anchorDump])

  useEffect(() => {
    const m = map.current
    if (!m || !ready.current) return

    const src = m.getSource('custom') as maplibregl.GeoJSONSource | undefined
    src?.setData(
      custom.a && custom.b
        ? {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                properties: {},
                geometry: {
                  type: 'LineString',
                  coordinates: [
                    [custom.a.lon, custom.a.lat],
                    [custom.b.lon, custom.b.lat],
                  ],
                },
              },
            ],
          }
        : emptyCollection,
    )

    // Markers are created once and then only repositioned. Recreating them on every state change
    // destroys the DOM element the browser is tracking the gesture on, which turns a smooth drag
    // into a series of jumps -- and the drag handler updates state on every pointer move, so it was
    // tearing down the very element being dragged.
    for (const which of ['a', 'b'] as const) {
      const at = custom[which]
      const existing = customMarkers.current[which]

      if (!at) {
        existing?.remove()
        delete customMarkers.current[which]
        continue
      }
      if (existing) {
        // Never fight the pointer: while this end is being dragged the marker is authoritative.
        if (dragging.current !== which) existing.setLngLat([at.lon, at.lat])
        continue
      }

      const node = document.createElement('div')
      node.className = 'custom-marker'
      node.textContent = which.toUpperCase()
      const marker = new maplibregl.Marker({ element: node, draggable: true })
        .setLngLat([at.lon, at.lat])
        .addTo(m)
      marker.on('dragstart', () => {
        dragging.current = which
      })
      marker.on('drag', () => {
        const { lat, lng } = marker.getLngLat()
        onSetCustomRef.current(which, { lat, lon: lng })
      })
      marker.on('dragend', () => {
        dragging.current = null
        const { lat, lng } = marker.getLngLat()
        onSetCustomRef.current(which, { lat, lon: lng })
      })
      customMarkers.current[which] = marker
    }
  }, [custom])

  useEffect(() => {
    const m = map.current
    if (!m || !ready.current) return
    BASEMAPS.forEach((_, i) => {
      const id = `base${i}`
      const visible = basemapVisible(i, basemapMix, BASEMAPS.length)
      m.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none')
      if (visible) m.setPaintProperty(id, 'raster-opacity', basemapOpacity(i, basemapMix))
    })
  }, [basemapMix])

  return (
    <>
      <div id="map" ref={el} />
      {menu && (
        <div className="mapmenu" style={{ left: menu.x, top: menu.y }}>
          <button
            onClick={() => {
              onSetCustom('a', { lat: menu.lat, lon: menu.lon })
              setMenu(null)
            }}
          >
            Set custom point A
          </button>
          <button
            onClick={() => {
              onSetCustom('b', { lat: menu.lat, lon: menu.lon })
              setMenu(null)
            }}
          >
            Set custom point B
          </button>
          {(custom.a || custom.b) && (
            <button
              onClick={() => {
                onSetCustom('a', null)
                onSetCustom('b', null)
                setMenu(null)
              }}
            >
              Clear custom line
            </button>
          )}
          <div className="coord">
            {menu.lat.toFixed(6)}, {menu.lon.toFixed(6)}
          </div>
        </div>
      )}
    </>
  )
}
