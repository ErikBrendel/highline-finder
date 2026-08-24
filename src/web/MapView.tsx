import { useEffect, useRef, useState } from 'react'
import maplibregl, { type Map as MlMap } from 'maplibre-gl'
import type { AnchorDump, Candidate, Dataset, Hotspots } from '../shared/types.js'
import { cachedUrl } from './tileCache.js'
import { PLANNED_ID } from '../shared/plan.js'
import type { CustomPoints, LatLon } from './planPoints.js'
import { installLoadingOverlay } from './loadingOverlay.js'

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
 *
 * Emitted worst-first, because MapLibre draws later features over earlier ones, so the best line in
 * a bundle of overlapping ones is the one you see and can click. Sorted here rather than relying on
 * the order the caller passes -- and after the index is assigned, so ids still line up with the
 * array the selection effect searches.
 */
function toGeoJson(cs: Candidate[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: cs
      .map((c, i) => ({
        type: 'Feature' as const,
        id: i,
        properties: { cid: c.id, score: c.score, length: c.length },
        geometry: {
          type: 'LineString' as const,
          coordinates: [[c.a.lon, c.a.lat], [c.b.lon, c.b.lat]],
        },
      }))
      .sort((x, y) => x.properties.score - y.properties.score),
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

/**
 * Hotspots as a heatmap rather than circles: the question at this zoom is "where is there
 * anything", and overlapping soft blobs answer it where hundreds of discrete dots would just read
 * as noise. Weighted by how many feasible line endpoints collapsed into each spot, so a place with
 * four hundred workable spans burns brighter than one with a single line.
 */
function hotspotsGeoJson(h: Hotspots | null): GeoJSON.FeatureCollection {
  if (!h) return { type: 'FeatureCollection', features: [] }
  return {
    type: 'FeatureCollection',
    features: h.lat.map((lat, i) => ({
      type: 'Feature',
      properties: { count: h.count[i]!, score: h.score[i]! },
      geometry: { type: 'Point', coordinates: [h.lon[i]!, lat] },
    })),
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

function lineFeature(a: LatLon, b: LatLon): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: [[a.lon, a.lat], [b.lon, b.lat]] },
      },
    ],
  }
}

interface Props {
  data: Dataset
  visible: Candidate[]
  selected: Candidate | null
  basemapMix: number
  anchorDump: AnchorDump | null
  hotspots: Hotspots | null
  /** south, west, north, east from the URL; falls back to fitting every AOI. */
  initialBbox: [number, number, number, number] | null
  custom: CustomPoints
  showLines: boolean
  onSelect: (id: string | null) => void
  onSetCustom: (which: 'a' | 'b', at: LatLon | null) => void
  onClearCustom: () => void
  onMoveAnchor: (which: 'a' | 'b', at: LatLon) => void
  onViewport: (bbox: [number, number, number, number]) => void
}

export function MapView({
  data,
  visible,
  selected,
  basemapMix,
  anchorDump,
  hotspots,
  initialBbox,
  custom,
  showLines,
  onSelect,
  onSetCustom,
  onClearCustom,
  onMoveAnchor,
  onViewport,
}: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number; lat: number; lon: number } | null>(null)
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<MlMap | null>(null)
  const popup = useRef<maplibregl.Popup | null>(null)
  // Read inside map event handlers, which are registered once and outlive any single render.
  const sectorCount = useRef(64)
  const anchorRange = useRef<[number, number]>([0, 1.5])
  // How far the hover wedges reach; the scan's own near-field probe distance.
  const wedgeMetres = useRef(40)
  const dropRadius = useRef(25)
  const anchorMarkers = useRef<Partial<Record<'a' | 'b', maplibregl.Marker>>>({})
  const dragging = useRef<'a' | 'b' | null>(null)
  const onMoveAnchorRef = useRef(onMoveAnchor)
  onMoveAnchorRef.current = onMoveAnchor
  /**
   * Whether the style has finished loading, as state rather than a ref.
   *
   * Every effect below both guards on this and lists it, so anything that arrived before the map
   * was ready gets applied the moment it is. A ref cannot do that -- flipping it re-runs nothing,
   * so state set once at mount and never touched again (a view restored from the URL, say) would
   * be dropped silently.
   */
  const [ready, setReady] = useState(false)
  const removeOverlay = useRef<(() => void) | null>(null)
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const onViewportRef = useRef(onViewport)
  onViewportRef.current = onViewport

  useEffect(() => {
    if (!el.current || map.current) return
    const aois = data.meta.regions.flatMap((r) => r.aois)
    const bounds = new maplibregl.LngLatBounds()
    if (initialBbox) {
      const [south, west, north, east] = initialBbox
      bounds.extend([west, south]).extend([east, north])
    } else {
      for (const a of aois) bounds.extend([a.west, a.south]).extend([a.east, a.north])
    }
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
      bounds,
      // No padding when the view came from a link: the rectangle is the view, not a thing in it.
      fitBoundsOptions: { padding: initialBbox ? 0 : 40 },
    })
    map.current = m
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left')
    m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left')

    m.on('load', () => {
      // First, so every other overlay draws above it.
      removeOverlay.current = installLoadingOverlay(m)

      m.addSource('hotspots', { type: 'geojson', data: hotspotsGeoJson(null) })
      m.addLayer({
        id: 'hotspots',
        type: 'heatmap',
        source: 'hotspots',
        paint: {
          // Log-scaled: counts run from 1 to several hundred, and a linear ramp would leave
          // everything but the single busiest spot invisible.
          'heatmap-weight': [
            'interpolate', ['linear'], ['log10', ['max', ['get', 'count'], 1]],
            0, 0.15,
            1, 0.5,
            2.5, 1,
          ],
          'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 6, 0.6, 11, 1.2, 16, 2.5],
          'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 6, 5, 11, 16, 16, 60],
          // Faded out by the time individual lines are legible: past here the candidates
          // themselves are the better answer, and a red wash over them only obscures them. Zoom
          // rather than a scale in metres, so the exact hand-over shifts a little with window size.
          'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 14, 1, 16, 0],
          'heatmap-color': [
            'interpolate', ['linear'], ['heatmap-density'],
            0, 'rgba(0,0,0,0)',
            0.1, 'rgba(120,20,20,0.30)',
            0.35, 'rgba(185,28,28,0.48)',
            0.65, 'rgba(239,68,68,0.62)',
            1, 'rgba(254,215,170,0.75)',
          ],
        },
      })

      m.addSource('aoi', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: aois.map((a) => ({
            type: 'Feature',
            properties: {},
            geometry: {
              type: 'LineString',
              coordinates: [
                [a.west, a.south], [a.east, a.south],
                [a.east, a.north], [a.west, a.north], [a.west, a.south],
              ],
            },
          })),
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
      for (const id of ['custom', 'customCasing']) {
        m.on('click', id, () => onSelectRef.current(PLANNED_ID))
        m.on('mouseenter', id, () => { m.getCanvas().style.cursor = 'pointer' })
        m.on('mouseleave', id, () => { m.getCanvas().style.cursor = '' })
      }

      // Anchor labels are DOM markers rather than a symbol layer: labelled text would need a
      // `glyphs` source in the style, and there is no reason to fetch a font for two letters.
      m.on('click', 'lines-hit', (e) => {
        const f = e.features?.[0]
        if (f) onSelectRef.current(String(f.properties!.cid))
      })
      m.on('click', (e) => {
        // Must include every selectable layer, or clicking one of them selects and then this
        // immediately deselects it again -- both handlers fire, and this one runs last.
        const hit = m.queryRenderedFeatures(e.point, {
          layers: ['lines-hit', 'custom', 'customCasing'].filter((id) => m.getLayer(id)),
        })
        if (!hit.length) onSelectRef.current(null)
      })
      m.on('contextmenu', (e) => {
        setMenu({ x: e.point.x, y: e.point.y, lat: e.lngLat.lat, lon: e.lngLat.lng })
      })
      m.on('moveend', () => {
        const b = m.getBounds()
        onViewportRef.current([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()])
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

      setReady(true)
      // Publish the opening view, so the URL is shareable before the user touches anything.
      const b = m.getBounds()
      onViewportRef.current([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()])
    })
    return () => {
      removeOverlay.current?.()
      removeOverlay.current = null
      popup.current?.remove()
      Object.values(anchorMarkers.current).forEach((mk) => mk?.remove())
      anchorMarkers.current = {}
      m.remove()
      map.current = null
      setReady(false)
    }
  }, [data])

  useEffect(() => {
    const m = map.current
    if (!m || !ready) return
    const src = m.getSource('lines') as maplibregl.GeoJSONSource | undefined
    src?.setData(toGeoJson(visible))
  }, [visible, ready])

  useEffect(() => {
    const m = map.current
    if (!m || !ready) return
    const v = showLines ? 'visible' : 'none'
    for (const id of ['lines', 'lines-hit']) m.setLayoutProperty(id, 'visibility', v)
  }, [showLines, ready])

  useEffect(() => {
    const m = map.current
    if (!m || !ready) return

    m.removeFeatureState({ source: 'lines' })
    const index = selected ? visible.findIndex((c) => c.id === selected.id) : -1
    if (index >= 0) m.setFeatureState({ source: 'lines', id: index }, { sel: true })
  }, [selected, visible, ready])

  useEffect(() => {
    const m = map.current
    if (!m || !ready) return
    const src = m.getSource('hotspots') as maplibregl.GeoJSONSource | undefined
    src?.setData(hotspotsGeoJson(hotspots))
  }, [hotspots, ready])

  useEffect(() => {
    const m = map.current
    if (!m || !ready) return
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
  }, [anchorDump, ready])

  useEffect(() => {
    const m = map.current
    if (!m || !ready) return
    const src = m.getSource('custom') as maplibregl.GeoJSONSource | undefined
    src?.setData(custom.a && custom.b ? lineFeature(custom.a, custom.b) : emptyCollection)
  }, [custom, ready])

  /**
   * The two anchor handles, for whichever line is being looked at.
   *
   * One set, not one per kind of line. Dragging a found line's anchor forks it into the planned
   * line, which means the selection changes mid-gesture -- so the same DOM elements have to serve
   * both, and are created once and thereafter only repositioned and restyled. Recreating them would
   * destroy the element the browser is tracking the gesture on, which is what previously turned a
   * drag into a series of jumps.
   *
   * Positions follow the selection when there is one, and fall back to the placed custom points so
   * a single point placed on its own is still visible and movable.
   */
  useEffect(() => {
    const m = map.current
    if (!m || !ready) return

    const planning = !selected || selected.id === PLANNED_ID
    const at: Record<'a' | 'b', LatLon | null> = selected
      ? { a: { lat: selected.a.lat, lon: selected.a.lon }, b: { lat: selected.b.lat, lon: selected.b.lon } }
      : custom

    for (const which of ['a', 'b'] as const) {
      const pt = at[which]
      const existing = anchorMarkers.current[which]

      if (!pt) {
        existing?.remove()
        delete anchorMarkers.current[which]
        continue
      }
      if (existing) {
        // classList, not className: MapLibre positions markers through its own `maplibregl-marker`
        // class (position: absolute, origin at the container's top left), so overwriting className
        // drops the element back into static flow and its transform lands dozens of pixels off.
        existing.getElement().classList.toggle('custom-marker', planning)
        existing.getElement().classList.toggle('anchor-marker', !planning)
        // Never fight the pointer: while this end is being dragged the marker is authoritative.
        if (dragging.current !== which) existing.setLngLat([pt.lon, pt.lat])
        continue
      }

      const node = document.createElement('div')
      node.className = planning ? 'custom-marker' : 'anchor-marker'
      node.textContent = which.toUpperCase()
      const marker = new maplibregl.Marker({ element: node, draggable: true })
        .setLngLat([pt.lon, pt.lat])
        .addTo(m)
      const report = () => {
        const { lat, lng } = marker.getLngLat()
        onMoveAnchorRef.current(which, { lat, lon: lng })
      }
      marker.on('dragstart', () => {
        dragging.current = which
      })
      marker.on('drag', report)
      marker.on('dragend', () => {
        dragging.current = null
        report()
      })
      anchorMarkers.current[which] = marker
    }
  }, [selected, custom, ready])

  useEffect(() => {
    const m = map.current
    if (!m || !ready) return
    BASEMAPS.forEach((_, i) => {
      const id = `base${i}`
      const visible = basemapVisible(i, basemapMix, BASEMAPS.length)
      m.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none')
      if (visible) m.setPaintProperty(id, 'raster-opacity', basemapOpacity(i, basemapMix))
    })
  }, [basemapMix, ready])

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
                onClearCustom()
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
