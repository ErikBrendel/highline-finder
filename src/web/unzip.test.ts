import { describe, expect, it } from 'vitest'
import { unzipOne } from './unzip.js'

/** a.tfw ("side", stored) then a.tif ("tile-bytes" fifty times, deflated). */
const ZIP =
  'UEsDBAoAAgAAAM1zd121G4EjBAAAAAQAAAAFABwAYS50ZndVVAkAA/I/BGvyPwRrdXgLAAEE9gEAAAQAAAAAc2lkZVBLAwQUAAIACADPc3ddPGjupREAAAD0AQAABQAcAGEudGlmVVQJAAP1PwRr8j8Ea3V4CwABBPYBAAAEAAAAACvJzEnVTaosSS0uGWWNEBYAUEsBAh4DCgACAAAAzXN3XbUbgSMEAAAABAAAAAUAGAAAAAAAAQAAAKSBAAAAAGEudGZ3VVQFAAPyPwRrdXgLAAEE9gEAAAQAAAAAUEsBAh4DFAACAAgAz3N3XTxo7qURAAAA9AEAAAUAGAAAAAAAAQAAAKSBQwAAAGEudGlmVVQFAAPyPwRrdXgLAAEE9gEAAAQAAAAAUEsFBgAAAAACAAIAlgAAAJMAAAAAAA=='

describe('unzipOne', () => {
  it('inflates the entry whose name ends as asked', async () => {
    const zip = Uint8Array.from(atob(ZIP), (c) => c.charCodeAt(0)).buffer
    const text = (b: ArrayBuffer) => new TextDecoder().decode(b)
    expect(text(await unzipOne(zip, '.tif'))).toBe('tile-bytes'.repeat(50))
    expect(text(await unzipOne(zip, '.tfw'))).toBe('side')
  })
})
