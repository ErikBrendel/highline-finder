import { describe, expect, it } from 'vitest'
import { upstream } from './proxied.js'

describe('upstream', () => {
  it('forwards the files it names and nothing else', () => {
    expect(upstream('/sn/public.php/dav/files/S6wwnFwX7882sZm/dom1_33408_5652_2_sn_tiff.zip')).toBe(
      'https://geocloud.landesvermessung.sachsen.de/public.php/dav/files/S6wwnFwX7882sZm/dom1_33408_5652_2_sn_tiff.zip',
    )
    expect(upstream('/sn/public.php/dav/files/f6p5WLkLtJFef9b/lod1_33410_5656_2_sn_citygml.zip')).toBe(
      'https://geocloud.landesvermessung.sachsen.de/public.php/dav/files/f6p5WLkLtJFef9b/lod1_33410_5656_2_sn_citygml.zip',
    )
    expect(upstream('/chm/forests/v2/global/dinov3_global_chm_v2_ml3/chm/1202102331.tif')).toBe(
      'https://dataforgood-fb-data.s3.amazonaws.com/forests/v2/global/dinov3_global_chm_v2_ml3/chm/1202102331.tif',
    )
    expect(upstream('/sn/public.php/dav/files/S6wwnFwX7882sZm/dgm1_33408_5652_2_sn_tiff.zip')).toBeNull()
    expect(upstream('/chm/forests/v2/../../secret')).toBeNull()
    expect(upstream('/constructor/x')).toBeNull()
  })
})
