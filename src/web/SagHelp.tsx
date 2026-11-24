const WALKER_KN = (80 * 9.81) / 1000

/** Balance Community's point-load relation S = W·L/(4·T), solved for tension at a sag fraction. */
const tensionAt = (pct: number) => WALKER_KN / (4 * (pct / 100))

const RIGS: { pct: number; what: string }[] = [
  { pct: 5, what: 'tight short line, polyester or Dyneema cranked hard' },
  { pct: 6.5, what: 'typical highline' },
  { pct: 8, what: 'relaxed tension, the usual on longer lines' },
  { pct: 10, what: 'loose, or stretchy nylon that loses tension under load' },
]

export function SagHelp({ pct }: { pct: number }) {
  return (
    <>
      <p>
        How far below the straight anchor-to-anchor line the webbing hangs at midspan with a walker
        standing there. Every clearance is measured from that sagged line. Yours, {pct.toFixed(1)} %,
        means about <b>{tensionAt(pct).toFixed(1)} kN</b> of tension under an 80 kg walker.
      </p>
      <table>
        <tbody>
          {RIGS.map((r) => (
            <tr key={r.pct}>
              <td>{r.pct} %</td>
              <td>{tensionAt(r.pct).toFixed(1)} kN</td>
              <td>{r.what}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul>
        <li>
          At a given tension the sag does not depend on line length or webbing, only on walker
          weight: a heavier walker sags proportionally more.
        </li>
        <li>
          Webbing matters in motion. A leash fall bounces the line deeper than this for a moment,
          a little on polyester or Dyneema and a lot on nylon, and you hang about 2 m below it. The
          3 m of clearance the search demands is meant for that.
        </li>
        <li>
          On lines past about 300 m the webbing's own weight adds sag on top, roughly a percent at
          500 m.
        </li>
        <li>
          A backup fall, the mainline failing, drops far deeper and is not modelled here. Check it
          with the ISA simulator:{' '}
          <a href="https://data.slacklineinternational.org/publications/highline/backup-fall/" target="_blank" rel="noreferrer">
            backup fall
          </a>
          .
        </li>
      </ul>
    </>
  )
}
