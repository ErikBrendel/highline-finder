import { describe, expect, it } from 'vitest'
import { tileAt } from './canopyMap.js'

describe('tileAt', () => {
  it('names the zoom-10 file a Web Mercator point is in', () => {
    // 52.83 N, 13.82 E, north-east of Berlin: the file fetched and checked by hand.
    expect(tileAt(1538434, 6950524)).toBe('1202102331')
  })
})
