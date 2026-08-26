import { useEffect, useRef, useState } from 'react'
import maplibregl, { type Map as MlMap } from 'maplibre-gl'
import type {
  AnchorDump,
  Candidate,
  Dataset,
  HotspotArrays,
  MaskCells,
  Params,
  TileUsage,
} from '../shared/types.js'
import { cachedUrl } from './tileCache.js'
import { report } from './report.js'
import { shadedUrl } from './shaded.js'
import { PLANNED_ID } from '../shared/plan.js'
import type { CustomPoints, LatLon } from './planPoints.js'
import { installLoadingOverlay } from './loadingOverlay.js'
import { installProbeOverlay } from './probeOverlay.js'
import { installHoverMarker } from './hoverMarker.js'
import { toUtm33, toWgs84 } from '../shared/geo.js'
import { sideHalfWidthAt } from '../shared/profile.js'

/**
 * Basemaps come straight from the LGB WMS endpoints, which serve EPSG:3857 -- so MapLibre's
 * {bbox-epsg-3857} raster template works without a reprojecting proxy. Attribution is not
 * decoration here: dl-de/by-2.0 requires naming GeoBasis-DE/LGB wherever the data is shown.
 */
const LGB_ATTR = '&copy; GeoBasis-DE/LGB (dl-de/by-2.0)'
const OSM_ATTR = '&copy; OpenStreetMap contributors (ODbL)'

/**
 * Attribution for the data behind the measurements, shown whatever basemap is on.
 *
 * A source's attribution only appears while a layer using it is visible, so tying these to the
 * basemaps meant the OSM credit vanished on the ortho view and the LGB credit vanished on the OSM
 * view -- while both datasets were still deciding what every line was worth. Both licences require
 * naming the source wherever the data is shown, and a line's clearance figure is the data being
 * shown. The strings match the basemap ones exactly so they collapse into one when both apply.
 */
const DATA_ATTRIBUTION = [LGB_ATTR, OSM_ATTR]
const wms = (path: string, layer: string) =>
  `https://isk.geobasis-bb.de/mapproxy/${path}/service/wms?SERVICE=WMS&VERSION=1.3.0` +
  `&REQUEST=GetMap&LAYERS=${layer}&STYLES=&CRS=EPSG:3857&WIDTH=256&HEIGHT=256` +
  `&FORMAT=image/png&TRANSPARENT=false&BBOX={bbox-epsg-3857}`

const ORTHO = wms('dop20c', 'bebb_dop20c')
const SHADE = wms('dgm', 'dgmshade')
const OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'

/** The three maps the slider is labelled with, and which its whole numbers land on. */
export const BASEMAPS = [
  { id: 'ortho', label: 'Ortho' },
  { id: 'hillshade', label: 'Hillshade' },
  { id: 'osm', label: 'OSM' },
] as const

/** Highest mix value, one per gap between adjacent basemaps. */
export const MIX_MAX = BASEMAPS.length - 1

/**
 * What is actually stacked, bottom to top: the three maps with a shaded composite between each
 * neighbouring pair.
 *
 * The composites exist because cross-fading a hillshade onto a map drags its colours toward grey,
 * and grey is the one thing a relief map should not turn everything into. Halfway along the slider
 * you now get the map re-shaded by the terrain instead -- full saturation, brightness varying with
 * the hillside. See shaded.ts. Between those five fixed points a plain opacity cross-fade is
 * exactly right, since both ends of every gap are already the picture you want.
 *
 * Two stops per gap, so `map=1` in an old link is still pure hillshade and `map=0.5` is now the
 * composite rather than a half-washed lerp. The slider keeps its 0-2 range; only what sits under
 * the halfway marks changed.
 */
export const BLEND_STOPS = [
  { id: 'ortho', tiles: cachedUrl(ORTHO), attribution: LGB_ATTR },
  { id: 'orthoShaded', tiles: shadedUrl('ortho', { base: ORTHO, shade: SHADE }), attribution: LGB_ATTR },
  { id: 'hillshade', tiles: cachedUrl(SHADE), attribution: LGB_ATTR },
  { id: 'osmShaded', tiles: shadedUrl('osm', { base: OSM, shade: SHADE }), attribution: `${OSM_ATTR} &middot; ${LGB_ATTR}` },
  { id: 'osm', tiles: cachedUrl(OSM), attribution: OSM_ATTR },
] as const

/** Where a slider position sits among {@link BLEND_STOPS}. */
export const stopAt = (mix: number) => mix * (BLEND_STOPS.length - 1) / MIX_MAX

/**
 * Opacity of stop `index` at stop position `at`, where whole numbers are one stop exactly and
 * fractions cross-fade to the next one up. The bottom layer stays fully opaque so there is never
 * bare background showing through.
 */
export function basemapOpacity(index: number, at: number): number {
  if (index === 0) return 1
  return Math.min(1, Math.max(0, at - (index - 1)))
}

/**
 * Whether a layer needs to be rendered at all. A layer that is transparent, or completely hidden
 * behind an opaque layer above it, is switched off entirely -- MapLibre skips tile requests for a
 * hidden layer, so this is what stops all three basemaps downloading at once.
 */
export function basemapVisible(index: number, at: number, count: number): boolean {
  if (basemapOpacity(index, at) <= 0) return false
  for (let above = index + 1; above < count; above++) {
    if (basemapOpacity(above, at) >= 1) return false
  }
  return true
}

/** Shared with the legend, so the swatches cannot drift from what the map draws. */
export const DEBUG_COLORS = {
  skipped: '#0b1220',
  barren: '#f59e0b',
  productive: '#22c55e',
  maskBelow: '#0b1220',
  maskAbove: '#38bdf8',
  /** Roofs on ground the search looked at, and roofs on ground it never loaded. */
  roofs: '#9aa4b8',
  roofsMissed: '#f43f5e',
  /** Lines killed by a road crossing, palest where one died and hottest where hundreds did. */
  killsFew: '#3f2d1a',
  killsMany: '#f97316',
} as const

const SCORE_COLOR: maplibregl.ExpressionSpecification = [
  'interpolate', ['linear'], ['get', 'score'],
  35, '#64748b',
  50, '#f59e0b',
  60, '#a3e635',
  70, '#22c55e',
]

const SELECTED: maplibregl.ExpressionSpecification = ['boolean', ['feature-state', 'sel'], false]

/** How long the lines take to swell and settle back. Long enough to read as motion, not a jump. */
export const EMPHASIS_MS = 220

/**
 * How wide the found lines are drawn, and how much wider while the lines button is hovered.
 *
 * Filtering down to a handful is the case this exists for: six lines somewhere in 265 km2 are
 * genuinely hard to spot, and the control that says "6 lines" is the natural thing to be pointing
 * at when you are looking for them.
 *
 * The emphasis is scaled by zoom because the problem is. At z15 a 400 m line already crosses the
 * screen and needs no help; at z9 it is a few pixels of hairline and doubling it is the difference
 * between finding it and not. Selection still reads through it -- the selected line stays the
 * widest thing on the map at every zoom.
 */
export function lineWidth(emphasised: boolean): maplibregl.DataDrivenPropertyValueSpecification<number> {
  if (!emphasised) return ['case', SELECTED, 4, 1.8]
  return [
    'interpolate', ['linear'], ['zoom'],
    9, ['case', SELECTED, 11, 8],
    15, ['case', SELECTED, 6, 3.6],
  ]
}

export const lineOpacity = (
  emphasised: boolean,
): maplibregl.DataDrivenPropertyValueSpecification<number> =>
  emphasised ? 1 : ['case', SELECTED, 1, 0.7]

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
function hotspotsGeoJson(h: HotspotArrays | null): GeoJSON.FeatureCollection {
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

/**
 * The coarse pre-pass as squares, so the ground skipped before any full-resolution fetch is visible.
 *
 * Cells carry a centre and the run's cell size rather than corners; the square is built here because
 * one number per cell is a great deal less to ship than four coordinate pairs.
 */
function maskGeoJson(m: MaskCells | null): GeoJSON.FeatureCollection {
  if (!m) return { type: 'FeatureCollection', features: [] }
  return {
    type: 'FeatureCollection',
    features: m.lat.map((lat, i) => {
      const dLat = m.res / 111320 / 2
      const dLon = m.res / (111320 * Math.cos((lat * Math.PI) / 180)) / 2
      const lon = m.lon[i]!
      return {
        type: 'Feature',
        properties: { drop: m.drop[i]! },
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [lon - dLon, lat - dLat],
            [lon + dLon, lat - dLat],
            [lon + dLon, lat + dLat],
            [lon - dLon, lat + dLat],
            [lon - dLon, lat - dLat],
          ]],
        },
      }
    }),
  }
}

/**
 * Source tiles as squares, carrying what was fetched for each and what it yielded.
 *
 * The honest counterpart to the coarse mask: the mask shows what the pre-pass concluded at 16 m,
 * this shows what could actually be acted on, since the data arrives in 1 km tiles.
 */
/** Which per-tile question the squares are answering. */
export type TileLayer = 'terrain' | 'surface' | 'buildings' | 'roads'

function tilesGeoJson(t: TileUsage | null, layer: TileLayer): GeoJSON.FeatureCollection {
  if (!t) return { type: 'FeatureCollection', features: [] }
  return {
    type: 'FeatureCollection',
    features: t.lat.map((lat, i) => {
      const dLat = t.size / 111320 / 2
      const dLon = t.size / (111320 * Math.cos((lat * Math.PI) / 180)) / 2
      const lon = t.lon[i]!
      return {
        type: 'Feature',
        properties: {
          fetched: (layer === 'surface' ? t.surface[i] : t.terrain[i]) ? 1 : 0,
          anchors: t.anchors[i]!,
          roofCells: t.roofCells?.[i] ?? 0,
          roadKills: t.roadKills?.[i] ?? 0,
          layer,
        },
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [lon - dLon, lat - dLat],
            [lon + dLon, lat - dLat],
            [lon + dLon, lat + dLat],
            [lon - dLon, lat + dLat],
            [lon - dLon, lat - dLat],
          ]],
        },
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

/**
 * The lens the line's clearance is actually measured across, as a polygon.
 *
 * Zero half-width at each anchor, widest at midspan -- see shared/profile.ts. Drawn because the
 * band is otherwise invisible: a line rejected for what stands three metres to its side looks, on
 * the map, like a line over open ground. Twenty-four points a side is smooth at any zoom the
 * planner is usable at, and the shape is built in projected metres and converted once per point so
 * the two edges stay parallel to the span rather than to the meridian.
 */
function bandFeature(a: LatLon, b: LatLon, p: Params): GeoJSON.FeatureCollection {
  const [ae, an] = toUtm33(a.lat, a.lon)
  const [be, bn] = toUtm33(b.lat, b.lon)
  const length = Math.hypot(be - ae, bn - an)
  if (!(length > 0) || !(sideHalfWidthAt(0.5, length, p) > 0)) return emptyCollection

  const pe = -(bn - an) / length
  const pn = (be - ae) / length
  const STEPS = 24
  const edge = (sign: number) =>
    Array.from({ length: STEPS + 1 }, (_, i) => {
      const t = i / STEPS
      const half = sideHalfWidthAt(t, length, p) * sign
      const w = toWgs84(ae + (be - ae) * t + pe * half, an + (bn - an) * t + pn * half)
      return [w.lon, w.lat] as [number, number]
    })
  const ring = [...edge(1), ...edge(-1).reverse()]
  return {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } },
    ],
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
  /** Swell the found lines, while the control that counts them is under the pointer. */
  emphasiseLines: boolean
  selected: Candidate | null
  basemapMix: number
  anchorDump: AnchorDump | null
  hotspots: HotspotArrays | null
  mask: MaskCells | null
  tiles: TileUsage | null
  tileLayer: TileLayer
  /** south, west, north, east from the URL; falls back to fitting every AOI. */
  initialBbox: [number, number, number, number] | null
  custom: CustomPoints
  showLines: boolean
  onSelect: (id: string | null) => void
  onSetCustom: (which: 'a' | 'b', at: LatLon | null) => void
  onClearCustom: () => void
  onMoveAnchor: (which: 'a' | 'b', at: LatLon) => void
  onViewport: (bbox: [number, number, number, number], zoom: number) => void
}

export function MapView({
  data,
  visible,
  emphasiseLines,
  selected,
  basemapMix,
  anchorDump,
  hotspots,
  mask,
  tiles,
  tileLayer,
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
  // Read when the layer is first added, which can happen after the pointer is already on the button.
  const emphasiseLinesRef = useRef(emphasiseLines)
  emphasiseLinesRef.current = emphasiseLines
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
      attributionControl: { customAttribution: DATA_ATTRIBUTION },
      style: {
        version: 8,
        sources: Object.fromEntries(
          BLEND_STOPS.map((b, i) => [
            `base${i}`,
            { type: 'raster', tiles: [b.tiles], tileSize: 256, attribution: b.attribution },
          ]),
        ),
        layers: [
          { id: 'bg', type: 'background', paint: { 'background-color': '#0f1115' } },
          ...BLEND_STOPS.map((_, i) => ({
            id: `base${i}`,
            type: 'raster' as const,
            source: `base${i}`,
            layout: { visibility: basemapVisible(i, stopAt(basemapMix), BLEND_STOPS.length) ? 'visible' as const : 'none' as const },
            paint: {
              'raster-opacity': basemapOpacity(i, stopAt(basemapMix)),
              /**
               * Both fades off, or the dark background shows through the stack.
               *
               * Visibility is not animated but opacity is, and by default over 300 ms -- so a step
               * that hides the covered layer and takes the covering one to full opacity does the
               * first instantly and the second gradually, leaving a third of a second of
               * half-transparent map over the background. Coming back the other way, a layer being
               * shown again fades its tiles in from nothing and does it again.
               *
               * There is nothing to ease anyway: the slider is direct manipulation, and a
               * transition on it only makes the map lag the thumb.
               */
              'raster-opacity-transition': { duration: 0, delay: 0 },
              'raster-fade-duration': 0,
            },
          })),
        ],
      },
      bounds,
      // No padding when the view came from a link: the rectangle is the view, not a thing in it.
      fitBoundsOptions: { padding: initialBbox ? 0 : 40 },
    })
    map.current = m
    /**
     * MapLibre swallows nothing but announces everything here: a tile that 404s, a source that
     * fails to load, a custom protocol handler that throws. Without a listener it writes to the
     * console and no further, so a basemap that is quietly serving nothing looks like a basemap
     * with nothing on it.
     */
    m.on('error', (e) => report('drawing the map', e.error ?? e))
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left')
    m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left')

    m.on('load', () => {
      // First, so every other overlay draws above it.
      const overlays = [installLoadingOverlay(m), installProbeOverlay(m), installHoverMarker(m)]
      removeOverlay.current = () => overlays.forEach((off) => off())

      m.addSource('tiles', { type: 'geojson', data: tilesGeoJson(null, 'terrain') })
      m.addLayer({
        id: 'tiles',
        type: 'fill',
        source: 'tiles',
        paint: {
          /**
           * One expression for all four views, because the squares and their geometry are the same
           * question asked four ways and a second source would only drift from the first.
           *
           *   terrain / surface -- green where the fetch paid off, amber where it bought nothing
           *     (the filter too loose), dark where it was skipped (dark beside green: too tight)
           *   buildings -- grey where roofs stand on ground the search loaded, red where they
           *     stand on ground it never looked at, which is the pre-pass judging on bare earth
           *   roads -- heat by how many lines died to a crossing here
           */
          'fill-color': [
            'case',
            ['==', ['get', 'layer'], 'buildings'], [
              'case',
              ['==', ['get', 'roofCells'], 0], DEBUG_COLORS.skipped,
              ['==', ['get', 'fetched'], 0], DEBUG_COLORS.roofsMissed,
              DEBUG_COLORS.roofs,
            ],
            ['==', ['get', 'layer'], 'roads'], [
              'case',
              ['==', ['get', 'roadKills'], 0], DEBUG_COLORS.skipped,
              ['interpolate', ['linear'], ['get', 'roadKills'],
                1, DEBUG_COLORS.killsFew,
                500, DEBUG_COLORS.killsMany,
              ],
            ],
            ['==', ['get', 'fetched'], 0], DEBUG_COLORS.skipped,
            ['==', ['get', 'anchors'], 0], DEBUG_COLORS.barren,
            DEBUG_COLORS.productive,
          ],
          'fill-opacity': [
            'case',
            ['==', ['get', 'layer'], 'buildings'], ['case', ['==', ['get', 'roofCells'], 0], 0.35, 0.5],
            ['==', ['get', 'layer'], 'roads'], ['case', ['==', ['get', 'roadKills'], 0], 0.35, 0.65],
            ['==', ['get', 'fetched'], 0], 0.55,
            0.22,
          ],
        },
      })
      m.addLayer({
        id: 'tilesEdge',
        type: 'line',
        source: 'tiles',
        paint: { 'line-color': '#8b93a3', 'line-width': 0.6, 'line-opacity': 0 },
      })

      m.addSource('mask', { type: 'geojson', data: maskGeoJson(null) })
      m.addLayer({
        id: 'mask',
        type: 'fill',
        source: 'mask',
        paint: {
          // Excluded ground is greyed out; ground that passed but only just keeps a faint tint, so
          // it is obvious how much slack the threshold actually has where it matters.
          'fill-color': ['case', ['<', ['get', 'drop'], ['literal', 0]], '#0b1220', '#38bdf8'],
          'fill-opacity': 0,
        },
      })
      m.addLayer({
        id: 'maskEdge',
        type: 'line',
        source: 'mask',
        paint: { 'line-color': '#0b1220', 'line-width': 0.4, 'line-opacity': 0 },
      })

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
        paint: {
          'line-color': '#38bdf8',
          'line-width': 2.5,
          'line-dasharray': [3, 2],
          'line-opacity': 0.9,
        },
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

      // Under the lines, over everything else: it is context for the selected line, not a feature.
      m.addSource('band', { type: 'geojson', data: emptyCollection })
      m.addLayer({
        id: 'band',
        type: 'fill',
        source: 'band',
        paint: { 'fill-color': '#38bdf8', 'fill-opacity': 0.12 },
      })
      m.addLayer({
        id: 'bandEdge',
        type: 'line',
        source: 'band',
        paint: { 'line-color': '#38bdf8', 'line-width': 1, 'line-opacity': 0.5, 'line-dasharray': [3, 2] },
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
          'line-width': lineWidth(emphasiseLinesRef.current),
          'line-opacity': lineOpacity(emphasiseLinesRef.current),
        },
      })
      // Set once rather than per change, so both directions ease: MapLibre animates a paint
      // property towards its new value whenever a transition is configured for it. The style spec's
      // types do not carry `-transition` keys inside a layer's paint block, so it is set here.
      m.setPaintProperty('lines', 'line-width-transition', { duration: EMPHASIS_MS, delay: 0 })
      m.setPaintProperty('lines', 'line-opacity-transition', { duration: EMPHASIS_MS, delay: 0 })

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
        onViewportRef.current([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()], m.getZoom())
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
      onViewportRef.current([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()], m.getZoom())
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
    const src = m.getSource('tiles') as maplibregl.GeoJSONSource | undefined
    src?.setData(tilesGeoJson(tiles, tileLayer))
    m.setPaintProperty('tilesEdge', 'line-opacity', tiles ? 0.4 : 0)
  }, [tiles, tileLayer, ready])

  useEffect(() => {
    const m = map.current
    if (!m || !ready) return
    const src = m.getSource('mask') as maplibregl.GeoJSONSource | undefined
    src?.setData(maskGeoJson(mask))
    const t = mask?.minDrop ?? 0
    m.setPaintProperty('mask', 'fill-color', [
      'case', ['<', ['get', 'drop'], t], DEBUG_COLORS.maskBelow, DEBUG_COLORS.maskAbove,
    ])
    m.setPaintProperty('mask', 'fill-opacity', mask
      ? ['case',
          ['<', ['get', 'drop'], t], 0.62,
          ['interpolate', ['linear'], ['get', 'drop'], t, 0.16, t * 4, 0]]
      : 0)
    m.setPaintProperty('maskEdge', 'line-opacity', mask ? 0.35 : 0)
  }, [mask, ready])

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

  /** The band, for whichever line is open -- found or planned, both measured across the same lens. */
  useEffect(() => {
    const m = map.current
    if (!m || !ready) return
    const src = m.getSource('band') as maplibregl.GeoJSONSource | undefined
    const ends = selected
      ? { a: { lat: selected.a.lat, lon: selected.a.lon }, b: { lat: selected.b.lat, lon: selected.b.lon } }
      : custom.a && custom.b
        ? { a: custom.a, b: custom.b }
        : null
    src?.setData(ends ? bandFeature(ends.a, ends.b, data.meta.params) : emptyCollection)
  }, [selected, custom, data, ready])

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
    const at = stopAt(basemapMix)
    BLEND_STOPS.forEach((_, i) => {
      const id = `base${i}`
      const visible = basemapVisible(i, at, BLEND_STOPS.length)
      m.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none')
      if (visible) m.setPaintProperty(id, 'raster-opacity', basemapOpacity(i, at))
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
