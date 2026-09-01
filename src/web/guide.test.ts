import { afterEach, describe, expect, it, vi } from 'vitest'
import { guideSeen, rememberGuide } from './Guide.js'

/**
 * The guide opens by itself exactly once, which makes remembering the whole of the feature.
 *
 * Both directions run through storage the browser is allowed to refuse, so the failure path is
 * tested rather than assumed: a reader who cannot be remembered has to see the guide again, which
 * is annoying, where a thrown error would take the header down with it.
 */
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

describe('guideSeen', () => {
  it('is false until the guide has been closed, and true after', () => {
    withStorage(fake(), () => {
      expect(guideSeen()).toBe(false)
      rememberGuide()
      expect(guideSeen()).toBe(true)
    })
  })

  it('shows the guide rather than throwing when storage is refused', () => {
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
      expect(guideSeen()).toBe(false)
      expect(() => rememberGuide()).not.toThrow()
    })
  })
})
