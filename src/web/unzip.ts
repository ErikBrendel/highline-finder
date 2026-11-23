/**
 * One file out of a zip, by the end of its name.
 *
 * Saxony ships each tile as a zip of the GeoTIFF and three sidecars, and a library for that would
 * be more code than this: the central directory says where the entry is and how big, and the
 * browser's own DecompressionStream inflates it. Read from the central directory rather than the
 * local headers, because those may defer their sizes to a descriptor after the data.
 */
export async function unzipOne(zip: ArrayBuffer, suffix: string): Promise<ArrayBuffer> {
  const view = new DataView(zip)
  let end = zip.byteLength - 22
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--
  if (end < 0) throw new Error('not a zip')
  const count = view.getUint16(end + 10, true)
  let at = view.getUint32(end + 16, true)
  for (let i = 0; i < count; i++) {
    const method = view.getUint16(at + 10, true)
    const size = view.getUint32(at + 20, true)
    const nameLength = view.getUint16(at + 28, true)
    const skip = nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true)
    const name = new TextDecoder().decode(new Uint8Array(zip, at + 46, nameLength))
    if (name.endsWith(suffix)) {
      const local = view.getUint32(at + 42, true)
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
      const data = new Uint8Array(zip, start, size)
      if (method === 0) return data.slice().buffer
      if (method !== 8) throw new Error(`zip method ${method} is not deflate`)
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
      return new Response(stream).arrayBuffer()
    }
    at += 46 + skip
  }
  throw new Error(`no *${suffix} in the zip`)
}
