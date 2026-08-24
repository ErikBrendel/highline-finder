import { describe, expect, it } from 'vitest'
import { deflateSync } from 'node:zlib'
import { alphaOf } from './buildings.js'

/**
 * Encodes an RGBA image with one filter type per row, straight from the PNG spec.
 *
 * The point of writing an encoder here is that it is the inverse of the thing under test rather
 * than a copy of it, so a shared misreading of the spec would still show up as a mismatch. The CRCs
 * are left as zeros: the decoder does not check them, and pretending otherwise would only test the
 * checksum.
 */
function encode(pixels: Uint8Array, w: number, h: number, filters: number[]): Buffer {
  const stride = w * 4
  const raw = Buffer.alloc(h * (stride + 1))
  for (let y = 0; y < h; y++) {
    const f = filters[y % filters.length]!
    raw[y * (stride + 1)] = f
    for (let x = 0; x < stride; x++) {
      const cur = pixels[y * stride + x]!
      const a = x >= 4 ? pixels[y * stride + x - 4]! : 0
      const b = y > 0 ? pixels[(y - 1) * stride + x]! : 0
      const c = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4]! : 0
      let sub = 0
      if (f === 1) sub = a
      else if (f === 2) sub = b
      else if (f === 3) sub = (a + b) >> 1
      else if (f === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        sub = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      raw[y * (stride + 1) + 1 + x] = (cur - sub) & 255
    }
  }

  const chunk = (type: string, body: Buffer) => {
    const out = Buffer.alloc(12 + body.length)
    out.writeUInt32BE(body.length, 0)
    out.write(type, 4, 'ascii')
    body.copy(out, 8)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr.writeUInt8(8, 8)
  ihdr.writeUInt8(6, 9)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

describe('alphaOf', () => {
  const w = 6
  const h = 5
  const pixels = new Uint8Array(w * h * 4)
  let seed = 11
  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = (seed = (seed * 1103515245 + 12345) % 2147483648) % 256
  }
  const alpha = Uint8Array.from({ length: w * h }, (_, i) => pixels[i * 4 + 3]!)

  it('recovers the alpha channel through every filter type', () => {
    expect(alphaOf(encode(pixels, w, h, [0, 1, 2, 3, 4]))).toEqual(alpha)
  })

  it('reads rows north to south, matching the tile grid', () => {
    const flat = new Uint8Array(w * h * 4)
    // Opaque on the top row only, which is the tile's north edge.
    for (let x = 0; x < w; x++) flat[x * 4 + 3] = 255
    const out = alphaOf(encode(flat, w, h, [0]))
    expect([...out.slice(0, w)]).toEqual(Array(w).fill(255))
    expect([...out.slice(w)]).toEqual(Array(w * (h - 1)).fill(0))
  })

  it('refuses an encoding the service does not actually send', () => {
    const png = encode(pixels, w, h, [0])
    // Colour type 3, palette. Byte 9 of the IHDR body, which starts at offset 16.
    png.writeUInt8(3, 25)
    expect(() => alphaOf(png)).toThrow(/type 3/)
  })
})
