import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFlag, writeFlag } from './remembered.js'

/**
 * Whether the guide and the filter panel are open outlives the page, which makes remembering the
 * whole of both features.
 *
 * Both directions run through storage the browser is allowed to refuse, so the failure path is
 * tested rather than assumed: a reader who cannot be remembered gets the panel again, which is
 * annoying, where a thrown error would take the page down with it.
 */
const KEY = 'a-switch'
const withStorage = (store: Storage | undefined, fn: () => void) => {
  const held = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true })
  try {
    fn()
  } finally {
    if (held) Object.defineProperty(globalThis, 'localStorage', held)
    else delete (globalThis as { localStorage?: unknown }).localStorage
  }
}

const fake = (): Storage => {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  } as unknown as Storage
}

afterEach(() => vi.restoreAllMocks())

describe('readFlag', () => {
  it('starts at the fallback, and comes back however it was left', () => {
    withStorage(fake(), () => {
      expect(readFlag(KEY, true)).toBe(true)
      writeFlag(KEY, false)
      expect(readFlag(KEY, false)).toBe(false)
      // Remembered false is not the same as never written: the fallback must not overrule it.
      expect(readFlag(KEY, true)).toBe(false)
      writeFlag(KEY, true)
      expect(readFlag(KEY, false)).toBe(true)
    })
  })

  it('falls back rather than throwing when storage is refused', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const refuses = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    } as unknown as Storage
    withStorage(refuses, () => {
      expect(readFlag(KEY, true)).toBe(true)
      expect(readFlag(KEY, false)).toBe(false)
      expect(() => writeFlag(KEY, false)).not.toThrow()
    })
  })
})
