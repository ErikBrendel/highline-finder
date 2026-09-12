import { reachable } from './hosts.js'

/**
 * Which survey draws which state, as a list rather than as a stack.
 *
 * Two things read this and they must not be able to disagree. MapView builds the basemap stacks
 * from it, clipping each layer to its state's outline; the coverage map in the guide colours a
 * state by what is in it. A hand-kept table beside the stacks would be a promise the map makes on
 * the layers' behalf, and the first time a layer name changed it would be a lie -- one nobody sees,
 * because a wrong claim in a legend looks exactly like a right one.
 *
 * Only the state-bounded layers are here. What covers the whole country -- Sentinel-2 under the
 * orthophotos, basemap.de under the reliefs -- is not a survey answering for its own ground and is
 * what a state having none of these falls back to.
 */

/**
 * A WMS anywhere, in the shape MapLibre's raster template needs. Transparent, so stacks work.
 *
 * `crs` because not every service admits to knowing Web Mercator by its current name. Saxony-Anhalt
 * advertises only `EPSG:900913`, the deprecated alias, and answers `InvalidCRS` to the modern one --
 * same projection, same bounding box numbers, different label.
 */
export const anyWms = (base: string, layer: string, crs = 'EPSG:3857') =>
  `${reachable(base)}${base.includes('?') ? '&' : '?'}SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap` +
  `&LAYERS=${layer}&STYLES=&CRS=${crs}&WIDTH=256&HEIGHT=256` +
  `&FORMAT=image/png&TRANSPARENT=true&BBOX={bbox-epsg-3857}`

export interface SurveyLayer {
  /** As named in states.json. More than one where a survey answers for more than one state. */
  states: string[]
  url: string
  /** Grey this product renders flat ground at, where it is not the common one. See shadeMath. */
  baseline?: number
  /** How far its relief is scaled to match Brandenburg's. See shadeMath. */
  contrast?: number
  opaque?: boolean
}

const bbWms = (path: string, layer: string) =>
  anyWms(`https://isk.geobasis-bb.de/mapproxy/${path}/service/wms`, layer)

/**
 * Every state orthophoto a browser can reach, at twenty centimetres or better.
 *
 * Thirteen of sixteen. Hamburg and Hessen publish theirs but not anywhere a browser was able to
 * find; Mecklenburg-Vorpommern's is reachable and unusable -- it burns "© GeoBasis-DE/M-V" into
 * the corner of every image it renders, which on 256 px tiles is the credit repeated across the
 * whole map rather than once under it. Those three show Sentinel-2, as every state used to.
 *
 * Order is not significant: no two of these overlap, and none is a fallback for another. A state
 * without one falls all the way to the ten-metre imagery rather than borrowing a neighbour's.
 */
export const ORTHO_SURVEYS: SurveyLayer[] = [
  { states: ['Brandenburg', 'Berlin'], url: bbWms('dop20c', 'bebb_dop20c') },
  {
    states: ['Sachsen'],
    url: anyWms('https://geodienste.sachsen.de/wms_geosn_dop-rgb/guest', 'sn_dop_020'),
  },
  {
    states: ['Sachsen-Anhalt'],
    url: anyWms(
      'https://geodatenportal.sachsen-anhalt.de/wss/service/ST_LVermGeo_DOP_WMS_OpenData/guest',
      'lsa_lvermgeo_dop20_2',
    ),
  },
  {
    states: ['Nordrhein-Westfalen'],
    url: anyWms('https://www.wms.nrw.de/geobasis/wms_nw_dop', 'nw_dop_rgb'),
  },
  {
    states: ['Bayern'],
    url: anyWms('https://geoservices.bayern.de/od/wms/dop/v1/dop20', 'by_dop20c'),
  },
  {
    states: ['Baden-Württemberg'],
    url: anyWms(
      'https://owsproxy.lgl-bw.de/owsproxy/ows/WMS_INSP_BW_Orthofoto_DOP20',
      'OI.OrthoimageCoverage',
    ),
  },
  {
    states: ['Niedersachsen'],
    url: anyWms('https://opendata.lgln.niedersachsen.de/doorman/noauth/dop_wms', 'ni_dop20'),
  },
  {
    states: ['Thüringen'],
    url: anyWms('https://www.geoproxy.geoportal-th.de/geoproxy/services/DOP', 'th_dop'),
  },
  {
    states: ['Rheinland-Pfalz'],
    url: anyWms('https://geo4.service24.rlp.de/wms/rp_dop20.fcgi', 'rp_dop20'),
  },
  {
    states: ['Schleswig-Holstein'],
    url: anyWms('https://dienste.gdi-sh.de/WMS_SH_DOP20col_OpenGBD', 'sh_dop20_rgb'),
  },
  {
    states: ['Saarland'],
    url: anyWms('https://geoportal.saarland.de/freewms/dop2019', 'sl_dop2019'),
  },
  {
    states: ['Bremen'],
    url: anyWms('https://geodienste.bremen.de/wms_dop_lb', 'dop10_2025_HB'),
  },
]

/**
 * The federal hillshade, under all of them and bounded by nothing.
 *
 * basemap.de's, from the DGM5, and the reason a line can now be planned in the Eifel against
 * something other than blank grey. Five metres a pixel against the states' one, so it is softer --
 * and a great deal better than nothing, which is what twelve states had before.
 *
 * It needs no rebasing at all: measured over five stretches of Brandenburg, from the Spreewald to
 * the Märkische Schweiz, it renders flat ground at exactly the same 195 and draws 1.16x the relief
 * for the same hillside. So it is the one layer here whose flat grey was nobody's decision, and
 * `contrast` is the whole of its correction.
 *
 * Chosen over `combshade`, which mixes slope shading in: that one sits at 253 and is a different
 * kind of picture, far too pale to read against any of the state products.
 */
export const FEDERAL_SHADE = {
  url: anyWms(
    'https://sgx.geodatenzentrum.de/wms_basemapde_schummerung',
    'de_basemapde_web_raster_hillshade',
  ),
  contrast: 0.86,
}

/**
 * The state reliefs that are sharper than the federal one, with what each has to be corrected by.
 *
 * Three, all at a metre. Saxony renders flat ground at 221 and about 1.9x Brandenburg's relief;
 * Saxony-Anhalt at 179 and about a third of it, from a DGM5 rather than a DGM1 and visibly coarser
 * at the border. Both are scaled back onto Brandenburg's, which is the survey the dataset is in.
 *
 * North Rhine-Westphalia's is deliberately absent despite being reachable, clean and sharper than
 * the federal layer. It renders flat ground at 128 with the full range either side of it, which the
 * rebase here cannot carry onto 195 without squashing one half and stretching the other: fitted, its
 * shadows land right and its highlights come out at half strength. Matching it properly needs a
 * contrast per half, which is a change to how every layer is described for the sake of one.
 * Mecklenburg-Vorpommern's is watermarked like its orthophoto.
 */
export const SHADE_SURVEYS: SurveyLayer[] = [
  { states: ['Brandenburg', 'Berlin'], url: bbWms('dgm', 'dgmshade') },
  {
    states: ['Sachsen'],
    url: anyWms('https://geodienste.sachsen.de/wms_geosn_hoehe/guest', 'relief'),
    baseline: 0xdd,
    contrast: 0.52,
  },
  {
    states: ['Sachsen-Anhalt'],
    url: anyWms(
      'https://geodatenportal.sachsen-anhalt.de/wss/service/ST_LVermGeo_DGM5_Relief_OpenData/guest',
      'lvermgeo_dgm5_schummerung',
      'EPSG:900913',
    ),
    baseline: 0xb3,
    // The one factor that is resolution-dependent, since this is a DGM5 product against two DGM1
    // ones: measured 2.7 from ten metres a pixel out, rising as far as 6.6 at two, where it has
    // no detail left to show and the relief hardly matters. Fitted where relief is read.
    contrast: 3.05,
    opaque: true,
  },
]

/** The states any of these layers answers for. */
export const statesCovered = (layers: SurveyLayer[]): Set<string> =>
  new Set(layers.flatMap((l) => l.states))
