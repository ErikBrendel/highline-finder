import { report } from './report.js'

/**
 * The password that locks secret spots, and the encryption under it.
 *
 * Only what is needed to check a password is stored: a salt, and a known text sealed with the key
 * the password makes. The key itself lives in memory while the secret spots are shown and is
 * dropped when they are hidden; there is no way back to the spots without the password.
 *
 * Each secret spot is sealed on its own, under its own storage key, with its id bound into the
 * seal so one spot's ciphertext cannot be passed off as another's. The library itself then only
 * holds a placeholder for it, which keeps writing the library synchronous: sealing is not.
 */

export interface Vault {
  salt: string
  check: string
}

const VAULT_KEY = 'highline-finder.vault'
const SEALED_PREFIX = 'highline-finder.sealed.'
/** OWASP's figure for PBKDF2-SHA256: about half a second in a browser, once per unlock. */
const ITERATIONS = 600_000
const CHECK = 'highline-finder'

const toB64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''))
const fromB64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
const utf8 = (text: string) => new TextEncoder().encode(text)

async function deriveKey(password: string, salt: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', utf8(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: fromB64(salt), iterations: ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/** `text` encrypted under `key`, bound to `label`: the iv and the ciphertext, in base64. */
export async function seal(key: CryptoKey, text: string, label: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(label) }, key, utf8(text)),
  )
  const out = new Uint8Array(iv.length + data.length)
  out.set(iv)
  out.set(data, iv.length)
  return toB64(out)
}

/** Throws when the key or the label is not the one it was sealed with. */
export async function unseal(key: CryptoKey, sealed: string, label: string): Promise<string> {
  const bytes = fromB64(sealed)
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: utf8(label) },
    key,
    bytes.slice(12),
  )
  return new TextDecoder().decode(plain)
}

export async function newVault(password: string): Promise<{ vault: Vault; key: CryptoKey }> {
  const salt = toB64(crypto.getRandomValues(new Uint8Array(16)))
  const key = await deriveKey(password, salt)
  return { vault: { salt, check: await seal(key, CHECK, CHECK) }, key }
}

/** The key, or null for a wrong password. */
export async function openVault(vault: Vault, password: string): Promise<CryptoKey | null> {
  const key = await deriveKey(password, vault.salt)
  try {
    return (await unseal(key, vault.check, CHECK)) === CHECK ? key : null
  } catch {
    return null
  }
}

const isVault = (v: unknown): v is Vault =>
  !!v && typeof (v as Vault).salt === 'string' && typeof (v as Vault).check === 'string'

export function parseVault(raw: unknown): Vault | null {
  return isVault(raw) ? { salt: raw.salt, check: raw.check } : null
}

export function loadVault(): Vault | null {
  try {
    return parseVault(JSON.parse(localStorage.getItem(VAULT_KEY) ?? 'null'))
  } catch (e) {
    report('reading the password settings', e)
    return null
  }
}

/** Writes or removes the vault, and every other tab hears of it. */
export function storeVault(vault: Vault | null): void {
  try {
    if (vault) localStorage.setItem(VAULT_KEY, JSON.stringify(vault))
    else localStorage.removeItem(VAULT_KEY)
  } catch (e) {
    report('storing the password settings', e)
  }
}

export const loadSealed = (id: string) => localStorage.getItem(SEALED_PREFIX + id)

export function storeSealed(id: string, sealed: string | null): void {
  try {
    if (sealed) localStorage.setItem(SEALED_PREFIX + id, sealed)
    else localStorage.removeItem(SEALED_PREFIX + id)
  } catch (e) {
    report('storing a secret spot', e)
  }
}

/** Calls back when another tab changes the vault, or seals a spot. */
export function watchVault(vaultChanged: () => void, sealedChanged: (id: string) => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === VAULT_KEY || e.key === null) vaultChanged()
    else if (e.key.startsWith(SEALED_PREFIX)) sealedChanged(e.key.slice(SEALED_PREFIX.length))
  }
  addEventListener('storage', onStorage)
  return () => removeEventListener('storage', onStorage)
}
