import { Grid } from '../shared/grid.js'
import { blitGeoTiff } from '../shared/geotiff.js'
import { latticeProjector, toUtm32, toWgs84, zoneOf } from '../shared/geo.js'
import { fetchCached, readCached, writeCached } from './tileCache.js'
import { reachable } from './hosts.js'
import { nearState } from './coverage.js'

/**
 * Where the elevation under a hand-planned line comes from.
 *
 * The pipeline is Berlin and Brandenburg and stays there. This is only about the planner: someone
 * who wants to know whether a gap near Leipzig would take a line should be able to place two points
 * and get a real measurement, without a hundred thousand candidate lines having been searched for
 * first.
 *
 * Every German state publishes a 1 m terrain model as open data, but there is no one service that
 * serves all of them -- the federal DGM1 coverage is licensed rather than open, and the state
 * services differ in protocol, in projection, in whether they wrap the answer in a MIME envelope,
 * and in whether they send CORS headers at all. So this is a list, tried in order: a survey's own
 * service wherever one can be reached from a browser, and a shared republisher for the rest.
 *
 * What a source may be short of is the *surface* model. Terrain is what the hard constraints are
 * measured against and every source has it; canopy is what tells a walkable line from one through
 * the treetops. A source without it is not refused -- a measurement with the clearance exact and
 * the canopy unknown is worth far more than no measurement, provided the app says which it is. See
 * `hasSurface` on a loaded window.
 */

export interface WindowGrids {
  ground: Grid
  surface: Grid
}

export interface Source {
  id: string
  /** Named wherever a figure measured from it is shown, as the licence requires. */
  attribution: string
  /** Whether it offers the surface model as well as the terrain. */
  hasSurface: boolean
  /** Whether it can be asked about this point at all, in EPSG:25833 metres. */
  covers(e: number, n: number): boolean
  /**
   * Fills what it has for one window. Throws {@link NoData} where it has nothing for this ground,
   * which is an answer rather than a failure: the next source is asked.
   */
  load(e0: number, n0: number, size: number, into: WindowGrids): Promise<void>
}

/** Thrown by a source that simply does not hold this ground, so the next one gets a turn. */
export class NoData extends Error {}

/* ------------------------------------------------------------------------------ survey services */

interface WcsSpec {
  id: string
  attribution: string
  /**
   * The state whose outline bounds this service, as named in outlines.json.
   *
   * A rough polygon rather than a box, because the boxes overlap badly: Brandenburg's takes in a
   * corner of Saxony-Anhalt, so a window over Halle was offered to Brandenburg first and declined
   * before the survey that holds it was asked. See coverage.ts.
   */
  state: string
  /** Full URL of each coverage, up to but not including the query string. */
  ground: { url: string; coverage: string }
  surface?: { url: string; coverage: string }
  /** The zone this service publishes in. 32 means every window has to be carried across. */
  zone: 32 | 33
}

/**
 * A WCS 2.0 coverage, asked one window at a time.
 *
 * The differences between services are all in the spec above, and there are only two that need
 * code. One is the projection: a service in zone 32 is asked for the box its own numbers put this
 * window in, and every cell of the window is then asked where in the answer it came from. The other
 * is the envelope -- some servers return the raster alone and some wrap it in a `multipart/related`
 * message beside a GML description of it -- which is why the reply is cut at the TIFF header rather
 * than trusted to be one.
 */
function wcsSource(spec: WcsSpec): Source {
  const query = (coverage: string, box: [number, number, number, number]) =>
    `?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage&COVERAGEID=${coverage}&FORMAT=image/tiff` +
    `&SUBSET=x(${box[0].toFixed(0)},${box[2].toFixed(0)})` +
    `&SUBSET=y(${box[1].toFixed(0)},${box[3].toFixed(0)})`

  return {
    id: spec.id,
    attribution: spec.attribution,
    hasSurface: !!spec.surface,
    covers(e, n) {
      const { lat, lon } = toWgs84(e, n)
      return nearState(spec.state, lon, lat)
    },
    async load(e0, n0, size, into) {
      const project = spec.zone === 33 ? undefined : toZone32(e0, n0, size)
      const box = project ? boxIn32(e0, n0, size) : ([e0, n0, e0 + size, n0 + size] as const)
      const layers = [
        [spec.ground, into.ground],
        ...(spec.surface ? [[spec.surface, into.surface] as const] : []),
      ] as const
      await Promise.all(
        layers.map(async ([layer, dest]) => {
          const url = reachable(
            `${layer.url}${query(layer.coverage, [box[0], box[1], box[2], box[3]])}`,
          )
          // A box is a hint about where a service answers; the service is the authority. Asked
          // about ground just outside its state it says so -- as a 404, or as an exception report
          // where a raster should be -- and that is this source declining rather than failing.
          const bytes = await fetchCached(url).catch((e: unknown) => {
            throw /\b40[0-9]\b/.test(String(e)) ? new NoData(String(e)) : e
          })
          // A reply that survives `tiffIn` but will not decode is the same kind of no: a coverage
          // server handed back something that is not the raster it promised, and the next source
          // is a better answer than an error about DataView offsets.
          await blitGeoTiff(tiffIn(bytes), dest, project).catch((e: unknown) => {
            throw new NoData(`unreadable coverage from ${spec.id}: ${String(e).slice(0, 80)}`)
          })
        }),
      )
    },
  }
}

/**
 * The raster inside whatever the server wrapped it in.
 *
 * A bare `image/tiff` body starts with the header and this finds it at nought. A
 * `multipart/related` one carries a GML part first, and cutting at the header is both simpler and
 * more robust than parsing MIME for a boundary the server chose.
 */
function tiffIn(bytes: ArrayBuffer): ArrayBuffer {
  const view = new Uint8Array(bytes)
  // An exception report is a service saying no in XML. Recognised before anything is decoded,
  // because what follows would otherwise run off the end of a reply that holds no raster and raise
  // a decoding error, which reads as this app being broken rather than as that answer.
  const head = new TextDecoder().decode(view.subarray(0, 2048))
  if (/ExceptionReport|ServiceException/.test(head)) {
    throw new NoData(/<[^>]*Exception[^>]*>([^<]{0,160})/.exec(head)?.[1]?.trim() || 'declined')
  }
  for (let i = 0; i + 3 < Math.min(view.length, 1 << 16); i++) {
    const le = view[i] === 0x49 && view[i + 1] === 0x49 && view[i + 2] === 0x2a && view[i + 3] === 0
    const be = view[i] === 0x4d && view[i + 1] === 0x4d && view[i + 2] === 0 && view[i + 3] === 0x2a
    if (le || be) return i === 0 ? bytes : bytes.slice(i)
  }
  // An OGC exception report where a raster should be: the service was asked about ground it does
  // not hold, which is a "no" and not a fault.
  throw new NoData('no raster in the coverage reply')
}

/** Where each point of a window falls in zone 32, sampled coarsely -- see `latticeProjector`. */
const toZone32 = (e0: number, n0: number, size: number) =>
  latticeProjector(
    (e, n) => {
      const w = toWgs84(e, n)
      return toUtm32(w.lat, w.lon)
    },
    e0,
    n0,
    size,
  )

/**
 * The zone 32 box to ask for, to be sure of covering the window once it is carried back.
 *
 * A square in one zone is a slightly turned quadrilateral in the next, so its corners are not the
 * corners of the box that holds it. All four are projected and padded, and the padding is generous
 * because asking for a few metres too much costs nothing and asking for too little leaves a strip
 * of the window unmeasured.
 */
function boxIn32(e0: number, n0: number, size: number): [number, number, number, number] {
  const to = toZone32(e0, n0, size)
  const xs: number[] = []
  const ys: number[] = []
  for (const e of [e0, e0 + size]) {
    for (const n of [n0, n0 + size]) {
      const [x, y] = to(e, n)
      xs.push(x)
      ys.push(y)
    }
  }
  const pad = 8
  return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad]
}

/** Brandenburg and Berlin: the ground the pipeline searched, and the only one with a city model. */
export const brandenburg = wcsSource({
  id: 'bb',
  attribution: 'GeoBasis-DE/LGB, dl-de/by-2.0',
  // Berlin is a hole in Brandenburg and the same survey answers for both, so either outline will do
  // and only one of them has to be tested first.
  state: 'Brandenburg',
  ground: { url: 'https://isk.geobasis-bb.de/ows/dgm_wcs', coverage: 'bb_dgm' },
  surface: { url: 'https://isk.geobasis-bb.de/ows/bdom_wcs', coverage: 'bb_bdom' },
  zone: 33,
})

/**
 * Saxony-Anhalt, which publishes both models and publishes them in zone 32.
 *
 * Halle sits at 11.97 degrees east, a few kilometres the wrong side of the zone line, so this is
 * the case the reprojection above exists for. Its INSPIRE services are the only ones in the state
 * a browser can reach: the download portal has no CORS headers at all.
 */
export const sachsenAnhalt = wcsSource({
  id: 'st',
  attribution: 'GeoBasis-DE/LVermGeo ST, dl-de/by-2.0',
  state: 'Sachsen-Anhalt',
  ground: {
    url: 'https://geodatenportal.sachsen-anhalt.de/ows_INSPIRE_LVermGeo_ATKIS_EL_DGM_WCS',
    coverage: 'Coverage1',
  },
  surface: {
    url: 'https://geodatenportal.sachsen-anhalt.de/ows_INSPIRE_LVermGeo_ATKIS_EL_DOM_WCS',
    coverage: 'Coverage1',
  },
  zone: 32,
})

/* ------------------------------------------------------------------------------ the republisher */

const HD_API = 'https://api.hoehendaten.de:14444/v1/rawtif'

/**
 * How far from zone 33 this project's own coordinates stay honest.
 *
 * Everything computed here is EPSG:25833, because Brandenburg is. A UTM easting a few degrees
 * outside its own zone is still good to centimetres; far outside it the scale error stops being a
 * rounding error and a line's length would be wrong. Saxony (12.1-15.1 E) is well inside it.
 */
const USABLE_FROM = 9.5
const USABLE_TO = 19

/**
 * Höhendaten für Deutschland, which republishes the state surveys' own 1 m tiles.
 *
 * Last in the list and used where nothing better answers, which today is Saxony: GeoSN publishes
 * DGM1 and DOM1 as open data, but only through a WMS that draws pictures of them and a file share
 * with no CORS headers, so nothing a browser holds can read a height out of either. What comes back
 * from here is the state's own GeoTIFF, unaltered, with that state's attribution attached -- so a
 * figure measured from it is as good as one measured from the source, and is credited to it.
 *
 * Terrain only, whatever the state publishes: the surface model is not republished. It is also a
 * third party rather than a survey office, on a non-standard port and with a rate limit of twelve
 * hundred tiles an hour, which is the other reason it is asked last.
 */
export const hoehendaten: Source = {
  id: 'hoehendaten',
  attribution: 'the state survey offices, via hoehendaten.de',
  hasSurface: false,
  covers(e, n) {
    const { lat, lon } = toWgs84(e, n)
    // Two limits, and they are different things. Germany is where the republisher can hold
    // anything at all, taken from the polygon the German extracts are cut with; the longitude range
    // is where this project's own projection is still honest. Outside either, asking would produce
    // an error a few seconds later rather than an answer.
    return lon >= USABLE_FROM && lon <= USABLE_TO && nearState('Germany', lon, lat)
  },
  /**
   * Every source tile the window reaches, not the one its middle happens to sit in.
   *
   * A window is 256 m and a source tile a kilometre, on lattices that do not line up -- so a window
   * straddles a tile boundary more often than not, and taking the tile under its centre left the
   * rest of it empty. Reprojected it is worse and stranger to look at: a square in zone 33 is a
   * turned square in zone 32, so what went missing was a wedge rather than a strip.
   *
   * Each tile fills the cells it holds and the others fall outside it, to be filled by the next.
   * Two to four tiles for a window at a boundary, cached after the first window wants them, and one
   * everywhere else.
   */
  async load(e0, n0, size, into) {
    const { lon } = toWgs84(e0 + size / 2, n0 + size / 2)
    const zone = zoneOf(lon)
    // In its own zone the window's own box; in the other, the box that box turns into.
    const box = zone === 33 ? ([e0, n0, e0 + size, n0 + size] as const) : boxIn32(e0, n0, size)
    const project = zone === 33 ? undefined : toZone32(e0, n0, size)
    let held = false
    for (let x = Math.floor(box[0] / 1000); x <= Math.floor(box[2] / 1000); x++) {
      for (let y = Math.floor(box[1] / 1000); y <= Math.floor(box[3] / 1000); y++) {
        // A tile the republisher does not hold is a hole in the survey rather than a failure of the
        // window: its neighbours still have their share of it to give.
        const tile = await kmTile(zone, x * 1000 + 500, y * 1000 + 500).catch((e: unknown) => {
          if (e instanceof NoData) return null
          throw e
        })
        if (!tile) continue
        await blitGeoTiff(tile, into.ground, project)
        held = true
      }
    }
    if (!held) throw new NoData('no tile covers this window')
  },
}

/**
 * One square kilometre of terrain, fetched once and kept for good.
 *
 * The service hands out its source tiles whole -- a thousand by a thousand metres, two to four
 * megabytes of them -- where every other fetch in this app is a 256 m window. So the tile is the
 * unit that is cached and sixteen windows are cut from each one, which is also what keeps the
 * request count inside a rate limit of twelve hundred tiles an hour.
 *
 * Kept in the same browser database as every other tile, which the state services' windows have
 * always used. This is the source that most deserves it: a window from a WCS is a quarter of a
 * megabyte and this is ten times that, it is a shared service with a rate limit rather than a
 * survey office, and a survey epoch does not change between page loads. The in-memory map stays in
 * front of it so two windows cut from one tile share a single request.
 */
const tiles = new Map<string, Promise<ArrayBuffer>>()

const CACHE_PREFIX = 'hoehendaten:v1:'

function kmTile(zone: 32 | 33, e: number, n: number): Promise<ArrayBuffer> {
  const key = `${zone}_${Math.floor(e / 1000)}_${Math.floor(n / 1000)}`
  let job = tiles.get(key)
  if (job) return job
  job = (async () => {
    const kept = await readCached(CACHE_PREFIX + key)
    if (kept) return kept
    const res = await fetch(HD_API, {
      method: 'POST',
      // Both required: the service refuses a request that does not say it wants JSON back.
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        Type: 'RawTIFRequest',
        ID: key,
        Attributes: { Zone: zone, Easting: e, Northing: n },
      }),
    })
    if (!res.ok) throw new Error(`${res.status} from hoehendaten.de`)
    const body = (await res.json()) as HoehendatenReply
    const first = body.Attributes?.RawTIFs?.[0]
    // A tile it does not hold reads as an error in its own vocabulary; here it is a "no".
    if (!first) throw new NoData(body.Attributes?.Error?.Detail ?? 'no tile there')
    const bytes = decodeBase64(first.Data)
    writeCached(CACHE_PREFIX + key, bytes)
    return bytes
  })()
  // A failure is not remembered: a rate limit or an outage should not turn into a permanent hole.
  job.catch(() => tiles.delete(key))
  tiles.set(key, job)
  return job
}

interface HoehendatenReply {
  Attributes?: {
    RawTIFs?: { Data: string; Attribution?: string; Actuality?: string }[] | null
    Error?: { Detail?: string }
  }
}

function decodeBase64(text: string): ArrayBuffer {
  const raw = atob(text)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out.buffer
}

/**
 * Survey services first, then the republisher.
 *
 * Their boxes overlap -- Brandenburg's bounding box takes in a corner of Saxony-Anhalt, and no
 * rectangle can separate two states that interlock -- so which one answers is settled by asking.
 * The one that holds the ground returns a raster and the others decline, which costs a wasted
 * request at a border and nothing at all after {@link answeredHere} has watched one succeed.
 */
export const SOURCES: Source[] = [brandenburg, sachsenAnhalt, hoehendaten]

/**
 * Which source last answered for a square kilometre, so a second window there starts with it.
 *
 * Planning happens in one place at a time: a drag crosses a dozen windows inside the same few
 * square kilometres, and without this every one of them would re-ask the services that declined
 * the first.
 */
const answeredHere = new Map<string, string>()

const areaKey = (e: number, n: number) => `${Math.floor(e / 1000)}_${Math.floor(n / 1000)}`

/** The sources to try for a point, best guess first. */
export function sourcesFor(e: number, n: number): Source[] {
  const able = SOURCES.filter((s) => s.covers(e, n))
  const known = answeredHere.get(areaKey(e, n))
  const first = able.find((s) => s.id === known)
  return first ? [first, ...able.filter((s) => s !== first)] : able
}

/** Remembers what worked, for the windows either side of this one. */
export const noteAnswered = (e: number, n: number, source: Source): void => {
  answeredHere.set(areaKey(e, n), source.id)
}

/** The first source that will answer for a point, or null where the planner has nothing to offer. */
export const sourceFor = (e: number, n: number): Source | null =>
  SOURCES.find((s) => s.covers(e, n)) ?? null
