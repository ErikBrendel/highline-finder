import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { spanGeometry, type LatLon, type LineSpec } from './planPoints.js'
import {
  defaultLineName, nearbySpots, parseExport, spotHash, spotTitle, titleOf, type ExportFile, type Spot,
} from './spots.js'
import { ShareButton } from './ShareButton.js'
import type { Imported, MoveTarget, Spots } from './useSpots.js'
import { failureText } from './report.js'
import { useRemembered } from './remembered.js'

export interface Lit {
  spot: string
  line: number | null
}

const km = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`)

const centreOf = (s: Spot): LatLon => {
  const ends = s.lines.flatMap((l) => [l.a, l.b])
  return {
    lat: ends.reduce((sum, p) => sum + p.lat, 0) / ends.length,
    lon: ends.reduce((sum, p) => sum + p.lon, 0) / ends.length,
  }
}

/** Enter keeps, Shift+Enter starts a new line of notes. */
const enterTo = (done: () => void) => (e: KeyboardEvent) => {
  if (e.key !== 'Enter' || e.shiftKey) return
  e.preventDefault()
  done()
}

/** A text box as tall as what is in it, so a name with notes under it is all on screen. */
function Grow({ value, onChange, placeholder, onEnter, autoFocus }: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  onEnter?: () => void
  autoFocus?: boolean
}) {
  return (
    <textarea
      className="grow"
      rows={Math.max(1, value.split('\n').length)}
      value={value}
      placeholder={placeholder}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onEnter ? enterTo(onEnter) : undefined}
    />
  )
}

/** A button that asks once more before it does something that cannot be undone. */
function Confirm({ label, sure, onConfirm }: { label: string; sure: string; onConfirm: () => void }) {
  const [asking, setAsking] = useState(false)
  useEffect(() => {
    if (!asking) return
    const timer = setTimeout(() => setAsking(false), 3000)
    return () => clearTimeout(timer)
  }, [asking])
  return (
    <button
      className="danger"
      data-asking={asking || undefined}
      onClick={(e) => {
        e.stopPropagation()
        if (asking) onConfirm()
        setAsking(!asking)
      }}
      title={asking ? 'Click again to confirm' : label}
    >
      {asking ? sure : label}
    </button>
  )
}

/** Keeps the open draft or found line, on its own or in a spot nearby. */
function SaveSheet({ spots, line, onDone }: { spots: Spots; line: LineSpec & { a: LatLon; b: LatLon }; onDone: () => void }) {
  const nearby = nearbySpots(spots.lib.spots, [line.a, line.b])
  const named = spots.open.kind === 'found' ? spots.open.name : spots.lib.draft?.name
  const [name, setName] = useState(named ?? defaultLineName(line.a, line.b))
  const [into, setInto] = useState<string | null>(nearby.length === 1 ? nearby[0]!.spot.id : null)
  const target = nearby.find((n) => n.spot.id === into)?.spot
  const [secretChoice, setSecret] = useRemembered('highline-finder.save-secret', false)
  const canSecret = spots.secrets.shown
  const secret = secretChoice && canSecret

  const save = () => {
    spots.save({ into, name, secret }, line)
    onDone()
  }

  return (
    <div className="savesheet">
      <label>
        {target ? 'Name of the line' : 'Name of the spot'}
        <Grow value={name} onChange={setName} placeholder="Name, and notes under it" onEnter={save} autoFocus />
      </label>
      {nearby.length > 0 && (
        <div className="targets" role="radiogroup">
          {nearby.map(({ spot, metres }) => (
            <label key={spot.id}>
              <input type="radio" checked={into === spot.id} onChange={() => setInto(spot.id)} />
              Add to <b>{spotTitle(spot)}</b> {spot.secret && <SecretTag />}
              <span className="sub">{km(metres)} away</span>
            </label>
          ))}
          <label>
            <input type="radio" checked={into === null} onChange={() => setInto(null)} />
            On its own
          </label>
        </div>
      )}
      {!target && (
        <label className="check" title={canSecret ? undefined : 'Show secret spots first, from the top bar'}>
          <input type="checkbox" checked={secret} disabled={!canSecret} onChange={(e) => setSecret(e.target.checked)} />
          Secret spot{!canSecret && <span className="sub"> &mdash; show secret spots first</span>}
        </label>
      )}
      <div className="row">
        <button className="primary" onClick={save}>Save</button>
        <button onClick={onDone}>Cancel</button>
      </div>
    </div>
  )
}

/**
 * Where one line of a spot can go instead: the draft line, a spot of its own, or another spot,
 * nearest first. Picking one moves it straight away; moving it back is the undo.
 */
function MoveTo({ spots, from, index }: { spots: Spots; from: Spot; index: number }) {
  const moved = from.lines[index]!
  const others = spots.lib.spots
    .filter((s) => s.id !== from.id)
    .map((s) => ({ s, metres: spanGeometry(moved.a, centreOf(s)).length }))
    .sort((p, q) => p.metres - q.metres)
  const targets: Record<string, MoveTarget> = {
    draft: { kind: 'draft' },
    own: { kind: 'own' },
    ...Object.fromEntries(others.map(({ s }) => [s.id, { kind: 'spot', id: s.id }])),
  }
  return (
    <select
      className="move"
      value=""
      title="Move this line to the draft line, a spot of its own, or another spot"
      onChange={(e) => {
        const to = targets[e.target.value]
        if (to) spots.moveLine(from.id, index, to)
      }}
    >
      <option value="" disabled>move</option>
      <option value="draft" disabled={!!spots.lib.draft}>
        {spots.lib.draft ? 'to the draft line (save or discard yours first)' : 'to the draft line'}
      </option>
      {from.lines.length > 1 && <option value="own">to a spot of its own</option>}
      {others.map(({ s, metres }) => (
        <option key={s.id} value={s.id}>
          to {spotTitle(s)}{s.secret ? ' (secret)' : ''} · {km(metres)}
        </option>
      ))}
    </select>
  )
}

const SecretTag = () => <span className="secret">secret</span>

function download(text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `highlines-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
}

/** A password field with its button, for every place that asks for one. */
function PasswordForm({ label, action, onSubmit, repeat, children }: {
  label: string
  action: string
  /** Resolves to an error to show, or null when done. */
  onSubmit: (password: string) => Promise<string | null>
  /** Asks twice, for a new password. */
  repeat?: boolean
  children?: ReactNode
}) {
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (!password) return setError('enter a password')
    if (repeat && password !== again) return setError('the two do not match')
    setBusy(true)
    setError(await onSubmit(password))
    setBusy(false)
  }
  return (
    <form className="pwform" onSubmit={(e) => { e.preventDefault(); void submit() }}>
      <label>
        {label}
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
      </label>
      {repeat && (
        <label>
          Again
          <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} />
        </label>
      )}
      <div className="row">
        <button className="primary" type="submit" disabled={busy}>{busy ? '…' : action}</button>
        {children}
      </div>
      {error && <span className="sub bad">{error}</span>}
    </form>
  )
}

const importNote = (r: Exclude<Imported, 'password' | 'wrong password'>) =>
  [
    r.added ? `${r.added} spot${r.added === 1 ? '' : 's'} added` : 'nothing new in that file',
    r.skipped ? `${r.skipped} secret skipped: show secret spots and import again` : '',
  ].filter(Boolean).join('; ')

const linkTo = (s: Spot) => `${location.origin}${location.pathname}#${spotHash(s)}`

export function SpotsPanel({ spots, line, lineUrl, centre, saving, onSaving, onLit, onFocus, onClose }: {
  spots: Spots
  /** A link to the open line, which the address bar does not carry while it is a secret one. */
  lineUrl: () => string
  /** The planner's line, which is what gets saved. */
  line: LineSpec
  /** Where the map is looking, to sort the list by. */
  centre: LatLon | null
  saving: boolean
  onSaving: (on: boolean) => void
  onLit: (lit: Lit | null) => void
  onFocus: (spot: Spot) => void
  onClose: () => void
}) {
  const [browsing, setBrowsing] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  /** What the foot of the list is asking about, if anything. */
  const [pane, setPane] = useState<null | 'export' | 'password' | { file: ExportFile }>(null)
  const [withSecret, setWithSecret] = useState(false)
  const [encrypted, setEncrypted] = useState(true)
  const { secrets } = spots
  useEffect(() => {
    if (!secrets.shown) setPane((p) => (p === 'password' || p === 'export' ? null : p))
  }, [secrets.shown])
  const file = useRef<HTMLInputElement>(null)
  const { lib, spot, open, holding } = spots
  const spotKey = spot?.id ?? null
  useEffect(() => setBrowsing(false), [spotKey])
  useEffect(() => () => onLit(null), [onLit])

  const sorted = centre
    ? lib.spots
        .map((s) => ({ s, metres: spanGeometry(centre, centreOf(s)).length }))
        .sort((p, q) => p.metres - q.metres)
    : lib.spots.map((s) => ({ s, metres: null })).sort((p, q) => q.s.edited - p.s.edited)

  const exportNow = async (secret: boolean) => {
    download(await spots.exportFile({ secret, encrypted }))
    setPane(null)
  }
  /** Imports, or asks for the file's password first; the error to show, if any. */
  const take = async (file: ExportFile, password: string | 'skip' | null): Promise<string | null> => {
    const r = await spots.importFile(file, password)
    if (r === 'password') {
      setPane({ file })
      return null
    }
    if (r === 'wrong password') return 'wrong password'
    setPane(null)
    setNote(importNote(r))
    return null
  }
  const upload = async (f: File) => {
    try {
      await take(parseExport(await f.text()), null)
    } catch (e: unknown) {
      setNote(`could not import: ${failureText(e)}`)
    }
  }

  const head = (title: string, back?: () => void, tag?: string) => (
    <div className="spotshead">
      {back && <button className="back" onClick={back} disabled={holding} aria-label="All spots">&larr;</button>}
      <strong>{title}</strong>
      {tag && <span className="unsaved">{tag}</span>}
      <button className="close" onClick={onClose} aria-label="Close">&times;</button>
    </div>
  )

  if (saving && line.a && line.b && (open.kind === 'draft' || open.kind === 'found')) {
    return (
      <aside className="spots">
        {head('Save line')}
        <SaveSheet spots={spots} line={{ ...line, a: line.a, b: line.b }} onDone={() => onSaving(false)} />
      </aside>
    )
  }

  if (!spot || browsing) {
    const row = (key: string, title: string, sub: ReactNode, active: boolean, onOpen: () => void, lit: Lit, secret = false) => (
      <li key={key}>
        <button
          data-active={active || undefined}
          data-secret={secret || undefined}
          onClick={active ? spots.leaveSpot : onOpen}
          title={active ? 'Click again to close' : undefined}
          onMouseEnter={() => onLit(lit)}
          onMouseLeave={() => onLit(null)}
        >
          <span className="title">{title}</span>
          <span className="sub">{sub}</span>
        </button>
      </li>
    )
    return (
      <aside className="spots">
        {head('My lines')}
        <ul className="spotlist">
          {spots.shared && row('shared', spotTitle(spots.shared), <><span className="unsaved">shared</span> · {spots.shared.lines.length} lines</>,
            open.kind === 'shared', () => { spots.openShared(null); setBrowsing(false); onFocus(spots.shared!) }, { spot: 'shared', line: null })}
          {lib.draft && row('draft', titleOf(lib.draft.name) || 'Untitled', <span className="draft">draft</span>,
            open.kind === 'draft', spots.openDraft, { spot: 'draft', line: null })}
          {sorted.map(({ s, metres }) => row(
            s.id,
            spotTitle(s),
            <>
              {s.secret && <><SecretTag /> · </>}
              {s.lines.length > 1 ? `${s.lines.length} lines` : `${Math.round(spanGeometry(s.lines[0]!.a, s.lines[0]!.b).length)} m`}
              {metres !== null && ` · ${km(metres)} away`}
            </>,
            s.id === spot?.id,
            () => { spots.openSpot(s.id); setBrowsing(false); onFocus(s) },
            { spot: s.id, line: null },
            s.secret,
          ))}
        </ul>
        {!lib.spots.length && !lib.draft && (
          <p className="note">Nothing kept yet. Pick or plan a line, then save it from its panel.</p>
        )}
        {pane === 'export' && (
          <div className="pane">
            <label className="check">
              <input type="checkbox" checked={withSecret} onChange={(e) => setWithSecret(e.target.checked)} />
              Include secret spots
            </label>
            {withSecret && secrets.locked && (
              <label className="check">
                <input type="checkbox" checked={encrypted} onChange={(e) => setEncrypted(e.target.checked)} />
                Encrypted with your password
              </label>
            )}
            {withSecret && !(secrets.locked && encrypted) && (
              <p className="note bad">Anyone who gets this file can read the secret spots in it.</p>
            )}
            <div className="row">
              <button className="primary" onClick={() => void exportNow(withSecret)}>Download</button>
              <button onClick={() => setPane(null)}>Cancel</button>
            </div>
          </div>
        )}
        {pane === 'password' && (secrets.locked ? (
          <div className="pane">
            <p className="note">Secret spots are encrypted on this device. Removing the password stores them readable again.</p>
            <PasswordForm
              label="Password"
              action="Remove password"
              onSubmit={async (p) => ((await secrets.removePassword(p)) ? (setPane(null), null) : 'wrong password')}
            >
              <button type="button" onClick={() => setPane(null)}>Cancel</button>
            </PasswordForm>
          </div>
        ) : (
          <div className="pane">
            <p className="note">
              Encrypts the secret spots on this device, and asks for the password every time they are shown.
              <b> A forgotten password cannot be recovered, and the secret spots are then lost.</b>
            </p>
            <PasswordForm
              label="New password"
              action="Set password"
              repeat
              onSubmit={async (p) => (await secrets.setPassword(p), setPane(null), null)}
            >
              <button type="button" onClick={() => setPane(null)}>Cancel</button>
            </PasswordForm>
          </div>
        ))}
        {pane !== null && typeof pane === 'object' && pane.file.sealed && (
          <div className="pane">
            <p className="note">
              This file holds {pane.file.sealed.spots.length} encrypted secret spot{pane.file.sealed.spots.length === 1 ? '' : 's'},
              under the password of the device it was exported from.
            </p>
            <PasswordForm label="Its password" action="Import" onSubmit={(p) => take(pane.file, p)}>
              <button type="button" onClick={() => void take(pane.file, 'skip')}>Without them</button>
            </PasswordForm>
          </div>
        )}
        <div className="spotsfoot">
          <button
            onClick={() => (secrets.any ? setPane(pane === 'export' ? null : 'export') : void exportNow(false))}
            disabled={!lib.spots.length}
            title="Download the saved spots as a file"
          >
            Export
          </button>
          <button onClick={() => file.current?.click()} title="Add the spots from an exported file; nothing here is overwritten">Import</button>
          {secrets.shown && (
            <button onClick={() => setPane(pane === 'password' ? null : 'password')} title="Encrypt the secret spots on this device">
              {secrets.locked ? 'Password…' : 'Set password…'}
            </button>
          )}
          <input
            ref={file}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) void upload(f)
            }}
          />
          {note && <span className="sub">{note}</span>}
        </div>
      </aside>
    )
  }

  const isShared = open.kind === 'shared'
  const at = open.kind === 'spot' || open.kind === 'shared' ? open.line : null
  const active = spots.active
  return (
    <aside className="spots">
      {head(spotTitle(spot), () => setBrowsing(true), isShared ? 'shared, not saved' : undefined)}
      {!isShared && (
        <label className="spotname">
          Spot
          <Grow value={spot.name} onChange={(v) => spots.renameSpot(spot.id, v)} placeholder="Name of this spot" />
        </label>
      )}
      <ul className="spotlist lines">
        {spot.lines.map((l, i) => (
          <li key={l.id}>
            <button
              data-active={i === at || undefined}
              disabled={holding && i !== at}
              onClick={() => (i === at ? spots.close() : isShared ? spots.openShared(i) : spots.openLine(spot.id, i))}
              title={i === at ? 'Click again to close this line' : undefined}
              onMouseEnter={() => onLit({ spot: isShared ? 'shared' : spot.id, line: i })}
              onMouseLeave={() => onLit(null)}
            >
              <span className="title">{titleOf(l.name) || 'Untitled'}</span>
              <span className="sub">{Math.round(spanGeometry(l.a, l.b).length)} m</span>
            </button>
            {!isShared && !holding && <MoveTo spots={spots} from={spot} index={i} />}
            {!isShared && !holding && <Confirm label="&times;" sure="delete" onConfirm={() => spots.removeLine(spot.id, i)} />}
          </li>
        ))}
      </ul>
      {!isShared && (
        <label className="check" title={secrets.shown ? undefined : 'Show secret spots first, from the top bar'}>
          <input
            type="checkbox"
            checked={spot.secret}
            disabled={!secrets.shown}
            onChange={(e) => spots.setSecret(spot.id, e.target.checked)}
          />
          Secret spot <span className="sub">&mdash; hidden unless secret spots are shown</span>
        </label>
      )}
      {active && !isShared && spot.lines.length > 1 && (
        <label className="linename">
          Line
          <Grow value={active.name} onChange={spots.renameActive} placeholder="Name, and notes under it" />
        </label>
      )}
      {isShared ? (
        <div className="row">
          <button className="primary" onClick={spots.saveShared}>Save spot</button>
          <button onClick={spots.dismissShared}>Dismiss</button>
        </div>
      ) : (
        <>
          <div className="row">
            <button onClick={spots.undo} disabled={!spots.canUndo} title="Undo (Ctrl+Z)">undo</button>
            <button onClick={spots.redo} disabled={!spots.canRedo} title="Redo (Ctrl+Shift+Z)">redo</button>
          </div>
          <div className="row">
            {active && (
              <ShareButton label="share line" title="Send a link to this line, with its name and notes" url={lineUrl} secret={spot.secret} />
            )}
            {spot.lines.length > 1 && (
              <ShareButton label="share spot" title="Send a link to all lines of this spot" url={() => linkTo(spot)} secret={spot.secret} />
            )}
          </div>
          <div className="row">
            <button onClick={spots.leaveSpot} disabled={holding} title="Leave this spot; it stays saved">Close spot</button>
            <Confirm label="Delete spot" sure="delete for good" onConfirm={() => spots.removeSpot(spot.id)} />
          </div>
        </>
      )}
    </aside>
  )
}
