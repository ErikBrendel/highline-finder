import type maplibregl from 'maplibre-gl'
import type { Region } from '../shared/types.js'
import { toUtm33, toWgs84 } from '../shared/geo.js'
import { cachedUrl } from './tileCache.js'
import { shadedUrl } from './shaded.js'
import { stackedUrl } from './stacked.js'
import { clipped, ORTHO } from './ortho.js'
import {
  BKG_ATTR, creditsFor, FEDERAL_SHADE, LGB_ATTR, ORTHO_SURVEYS, SENTINEL,
  SHADE_SURVEYS,
} from './surveys.js'
import { integration } from './integration.js'
import { CANOPY_MAP_ATTRIBUTION } from './canopyMap.js'

/**
 * Basemaps come straight from the LGB WMS endpoints, which serve EPSG:3857 -- so MapLibre's
 * {bbox-epsg-3857} raster template works without a reprojecting proxy. Attribution is not
 * decoration here: dl-de/by-2.0 requires naming GeoBasis-DE/LGB wherever the data is shown.
 */
const OSM_ATTR = '&copy; OpenStreetMap contributors (ODbL)'
/** Every survey whose imagery can appear in a stacked basemap, since any of them may be on screen. */
const BASEMAP_ATTR = creditsFor([SENTINEL, ...ORTHO_SURVEYS, FEDERAL_SHADE, ...SHADE_SURVEYS])

/**
 * Attribution for the data behind the measurements, shown whatever basemap is on.
 *
 * A source's attribution only appears while a layer using it is visible, so tying these to the
 * basemaps meant the OSM credit vanished on the ortho view and the LGB credit vanished on the OSM
 * view -- while both datasets were still deciding what every line was worth. Both licences require
 * naming the source wherever the data is shown, and a line's clearance figure is the data being
 * shown. The strings match the basemap ones exactly so they collapse into one when both apply.
 *
 * The BKG credit is here rather than only under the hillshade because the state borders are drawn
 * whatever the basemap is, and they are VG250 -- the survey's own boundary dataset. See
 * `npm run boundaries`.
 */
export const DATA_ATTRIBUTION = [LGB_ATTR, OSM_ATTR, BKG_ATTR, CANOPY_MAP_ATTRIBUTION]
/**
 * The relief, with the flat-ground grey underneath it.
 *
 * Painted rather than left transparent because the shaded composites divide by that grey: ground
 * no survey has shaded has to come out unchanged, not black. It is `SHADE_BASELINE` written as a
 * colour -- the two have to agree or unshaded ground is quietly tinted. Since the federal hillshade
 * arrived there is very little ground left that sees it, which makes it a backstop rather than what
 * most of the country is drawn on.
 *
 * Every product disagrees with every other about two separate things -- what grey flat ground is,
 * and how far from it a given hillside is drawn -- and each says so where it is described.
 */
const SHADE = stackedUrl('shade', {
  under: '#c3c3c3',
  layers: [FEDERAL_SHADE, ...SHADE_SURVEYS.map(clipped)],
})

const OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'

/**
 * The states a survey answers for with a surface model, which is what a solid border means.
 *
 * Derived, not listed: the same reading of `SOURCES` the coverage map in the guide colours from, so
 * a state that gains or loses a service changes both at once. See integration.ts.
 */
export const CANOPY_STATES = integration(null)
  .filter((f) => f.canopy)
  .map((f) => f.name)

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
  // Already stacked, so not run through `cachedUrl` again: the stack caches each survey's own tile
  // and composites what it has, which is the level the caching belongs at.
  { id: 'ortho', tiles: ORTHO, attribution: BASEMAP_ATTR },
  { id: 'orthoShaded', tiles: shadedUrl('ortho', { base: ORTHO, shade: SHADE }), attribution: BASEMAP_ATTR },
  { id: 'hillshade', tiles: SHADE, attribution: BASEMAP_ATTR },
  { id: 'osmShaded', tiles: shadedUrl('osm', { base: OSM, shade: SHADE }), attribution: `${OSM_ATTR} &middot; ${BASEMAP_ATTR}` },
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
  /** Region vintage, from just computed to long kept. */
  fresh: '#22c55e',
  aged: '#f59e0b',
} as const

/**
 * Vintage differences narrower than this are one batch of work, not a gradient.
 *
 * Regions of a single run are stamped as each finishes, so they are seconds or minutes apart. On a
 * scale fitted to the data those seconds would stretch to fill it, and the region that happened to
 * be searched first would be painted as the stale one.
 */
export const SAME_VINTAGE_MS = 60 * 60 * 1000

/**
 * Where each region sits between the newest and the oldest in the dataset, 0 to 1.
 *
 * Fitted to the data rather than to a fixed span of days, because "old" has no absolute meaning
 * here: a dataset computed entirely last night and one computed entirely last year are both
 * internally consistent, and what matters in each is which parts are lagging behind the rest. A
 * dataset of one vintage is therefore all green however old it is.
 */
export function vintageScale(regions: Region[]): (iso: string) => number {
  const times = regions.map((r) => Date.parse(r.generatedAt)).filter((t) => !Number.isNaN(t))
  if (!times.length) return () => 0
  const newest = Math.max(...times)
  const spread = newest - Math.min(...times)
  if (spread < SAME_VINTAGE_MS) return () => 0
  // An unreadable stamp is the worst case there is, not the best, so it sorts to the far end.
  return (iso) => {
    const at = Date.parse(iso)
    return Number.isNaN(at) ? 1 : (newest - at) / spread
  }
}

export const ageInDays = (iso: string, now: number): number =>
  Math.max(0, (now - Date.parse(iso)) / 86_400_000)

/** How long ago, at whatever unit makes the number readable. */
export function ageText(iso: string, now: number): string {
  const days = ageInDays(iso, now)
  if (days >= 1) return `${Math.round(days)}d ago`
  const hours = days * 24
  if (hours >= 1) return `${Math.round(hours)}h ago`
  return `${Math.max(1, Math.round(hours * 60))}m ago`
}

export const SCORE_COLOR: maplibregl.ExpressionSpecification = [
  'interpolate', ['linear'], ['get', 'score'],
  35, '#64748b',
  50, '#f59e0b',
  60, '#a3e635',
  70, '#22c55e',
]

/**
 * Round ends and corners for anything that draws a highline.
 *
 * A line is a span between two anchors, and at 8 px of hover emphasis a butt cap ends it in a flat
 * chisel edge whose orientation depends on the bearing -- which reads as a line that has been cut
 * off rather than one that stops at a point. Rounding also matters where a casing sits under a
 * line: two rectangles at different widths leave a step at the ends unless both are capped the
 * same way.
 */
export const SPAN_CAPS = { 'line-cap': 'round', 'line-join': 'round' } as const

/** How long the lines take to swell and settle back. Long enough to read as motion, not a jump. */
export const EMPHASIS_MS = 220

/**
 * How wide the found lines are drawn, at `emphasis` 0 (resting) to 1 (fully swollen).
 *
 * Filtering down to a handful is the case this exists for: six lines somewhere in 265 km2 are
 * genuinely hard to spot, and the control that says "6 lines" is the natural thing to be pointing
 * at while looking for them.
 *
 * The swell is scaled by zoom because the problem is. At z15 a 400 m line already crosses the
 * screen and needs no help; at z9 it is a few pixels of hairline, and four times the width is the
 * difference between seeing it and not.
 *
 * A continuous parameter rather than a flag because MapView animates this itself, a frame at a
 * time. Handing MapLibre a `line-width-transition` and two endpoints would be less code, and it is
 * how the first attempt did it -- but whether MapLibre eases a *data-driven* width, as opposed to a
 * plain one, is not something the style spec promises, and a silent no leaves a jump.
 */
export function lineWidth(
  emphasis: number,
): maplibregl.DataDrivenPropertyValueSpecification<number> {
  if (emphasis <= 0) return 1.8
  const mix = (from: number, to: number) => from + (to - from) * emphasis
  return ['interpolate', ['linear'], ['zoom'], 9, mix(1.8, 8), 15, mix(1.8, 3.6)]
}

/** The lines stop being dimmed as they swell, so faint ones come forward too. */
export const lineOpacity = (emphasis: number): number =>
  0.7 + 0.3 * Math.min(1, Math.max(0, emphasis))


/**
 * Zoom from which individual lines are drawn.
 *
 * Below it they are not lines. A 400 m span is about a pixel at z9 and five at z11, so a whole
 * state's worth is a red smear that says only "there are lines here" -- which is the question the
 * heatmap answers properly. The floor is set where a line first reads as a mark on the map rather
 * than where it reads as a line: arriving at your own district and finding the map bare is worse
 * than a little smear, and the two layers overlapping for a few zooms costs nothing.
 *
 * It is also most of the work a phone does with this map: twenty-five thousand two-point features
 * rasterised every frame to produce that smear.
 *
 * The hit layer carries the same floor. A line nobody can see is not one anybody meant to click.
 */
export const LINES_FROM = 9

/**
 * A square of `size` metres centred on a point, as a ring of its four true corners.
 *
 * Every square this file draws -- coarse mask cells, source tiles -- is a square in EPSG:25833, and
 * a square in EPSG:25833 is not a rectangle in latitude and longitude. UTM grid convergence rotates
 * it away from north by up to 2.9 degrees at Brandenburg's western edge, so building the shape from
 * a centre and a half-width in degrees puts the corners 20 m out on a 1 km tile at 13 E and 35 m out
 * at 11.5 E. That is what made neighbouring squares overlap on one side and leave a gap on the
 * other: each was drawn as its own axis-aligned box, so their edges never met.
 *
 * Converting the corners instead makes adjacent squares share their corner coordinates exactly, so
 * they tile. The centre is round-tripped through the projection to recover it, which costs the 0.1 m
 * the exported coordinates were rounded to -- three orders below what was wrong before.
 */
export function squareRing(lat: number, lon: number, size: number): [number, number][] {
  const [e, n] = toUtm33(lat, lon)
  const h = size / 2
  return boxRing({ minE: e - h, minN: n - h, maxE: e + h, maxN: n + h })
}

/** A projected box as a ring of its four true corners. The only correct way to draw one. */
export function boxRing(b: Box25833): [number, number][] {
  return (
    [
      [b.minE, b.minN], [b.maxE, b.minN], [b.maxE, b.maxN], [b.minE, b.maxN], [b.minE, b.minN],
    ] as const
  ).map(([e, n]) => {
    const corner = toWgs84(e, n)
    return [corner.lon, corner.lat] as [number, number]
  })
}

type Box25833 = { minE: number; minN: number; maxE: number; maxN: number }
