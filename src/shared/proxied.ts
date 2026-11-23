/**
 * The files this app reads through its own proxy, because their hosts send no CORS headers.
 *
 * GeoSN said so in writing: the GeoCloud cannot carry the header and they suggested a proxy of our
 * own. The canopy height map sits in an S3 bucket whose CORS configuration is not ours to change.
 * Both are open data, so the proxy adds nothing but the header -- and it forwards only paths that
 * match these patterns, so it cannot be used to fetch anything else.
 *
 * Shared by the Cloudflare worker that does this in production (proxy/worker.ts) and by the dev
 * server, which does the same from Node. See web/hosts.ts for how a URL is routed to either.
 */
export const PROXIED = {
  sn: {
    origin: 'https://geocloud.landesvermessung.sachsen.de',
    path: /^\/public\.php\/dav\/files\/(?:(?:JCcXyifaNdLDnxZ\/dgm1|S6wwnFwX7882sZm\/dom1)_33\d{3}_\d{4}_2_sn_tiff|f6p5WLkLtJFef9b\/lod1_33\d{3}_\d{4}_2_sn_citygml)\.zip$/,
  },
  chm: {
    origin: 'https://dataforgood-fb-data.s3.amazonaws.com',
    path: /^\/forests\/v2\/global\/dinov3_global_chm_v2_ml3\/chm\/[0-3]{10}\.tif$/,
  },
} as const

export type ProxiedHost = keyof typeof PROXIED

/** The upstream URL for a proxy path such as `/sn/public.php/...`, or null for anything else. */
export function upstream(path: string): string | null {
  const m = /^\/([a-z]+)(\/.*)$/.exec(path)
  if (!m || !Object.hasOwn(PROXIED, m[1]!)) return null
  const host = PROXIED[m[1] as ProxiedHost]
  return host.path.test(m[2]!) ? host.origin + m[2] : null
}
