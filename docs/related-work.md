# Related work — the tools people already use to find lines

Surveyed November 2026, from the community's own forums and pages rather than from search-engine
summaries; every URL here was opened. This is the *community* neighbourhood — spot databases and the
habits that stand in for them. For the *technical* neighbourhood — CalTopo, SEILAPLAN, PLS-CADD,
Skitourenguru and what their elevation data is — see `## Prior art, and what it would take to plug
into it` in [`ROADMAP.md`](../ROADMAP.md).

## The one direct competitor, and why it skipped Germany

**HighlineScout** — <https://highlinescout.com>, "The smarter way to scout your next line" — computes
candidate highline spots from terrain data, which is this project's premise. It is Spanish, built
because of access pressure: *"In Spain we are a bit in constant trouble with the law because of
highlining. And then we get kicked out A LOT."*

Two German commenters asked its author to add Germany. His answer, in full:

> I still work on it sometimes, germany tho it's an issue as the finest topographical data freely
> available is at 20m resolution, which is not great, i might try to add it, but I don't expect
> great results

(<https://www.reddit.com/r/Slackline/comments/1v12xoh/>)

That premise is wrong, and the correction is the whole reason this project exists: Brandenburg
publishes a 1 m bare-earth DGM and a 0.2 m surface model as open data, and twelve other states
publish comparable LiDAR. The competitor nearest to this one abandoned the country on a twenty-fold
misreading of what the surveys give away — and there is demonstrated German demand sitting unanswered
in that thread.

## Every spot database is crowd-sourced, and every one of them is starved

| Tool | What it is | What it lacks |
|---|---|---|
| **Slackmap (ISA)** <https://www.slacklineinternational.org/slackmap/> | The community's canonical world map of spots, with restriction levels, run by the ISA Nature and Access Commission | Only what someone entered. The page is itself a volunteer appeal — it asks for people to maintain the webapp and implement features. Measures nothing. |
| **SlackMap (iOS)** <https://apps.apple.com/it/app/slackmap/id6751760457> | Separate iPhone app: community spots, two picked anchor points, ratings, following | New, essentially unreviewed; its relationship to the ISA map is unclear |
| **Slackspot (Gibbon)** <https://slackspot.gibbon-slacklines.com/> | Manufacturer-run spot directory | Account required past browsing; no sign of current activity |
| **Deutscher Slacklineverband** <https://deutscherslacklineverband.org/> | The German national body | Its `Basics > Highlines` page reads, in full: *"Hier gibt es bald alle Infos zum Thema Highlines!"* Its one working highline tool is a Luftamt registration form, Bavaria only. No spot data of any kind. |
| **Facebook groups** (`slackchat` and the city groups) | The actual mechanism — people post when and where a line is going up | Nothing searchable, nothing persistent, an account and an introduction required |
| **Google Earth / Street View** | What people genuinely scout with today | No ground elevation under the span, no canopy or building height, no length without measuring by hand |

The adjacent sports show where crowd-sourcing ends up. Mountain Project (<https://mountainproject.com/about>)
has corrections stuck behind unreachable volunteer admins. A paragliding site closed years earlier
kept reappearing downstream in Windy after being deleted upstream, and pilots were still trying to
find ground that was off-limits
(<https://community.windy.com/topic/14987/paragliding-spots-that-have-been-deleted-in-paragliding-earth-still-appear-in-windy>).
A measured, regenerable dataset does not have that failure mode, and none of these incumbents
compete with it.

## Two gaps nobody is in

- **Nobody serves the person at the receiving end.** Every tool above is built for whoever is
  deciding where to rig. Not one has anything for the friend who was sent a location and has to
  decide whether to spend their Saturday on it — which is this product's main arrival.
- **Nobody measures.** Every spot resource in the sport is a list of places someone typed in. The
  numbers — length, clearance, exposure, what the ground does between the anchors — are not in any
  of them.

## The constituency that does not want a database at all

Worth recording because it cuts the other way: *"Legal is the biggest issue. Most spots are small and
not super legal so they are kept secret. I've had great spots get ruined once someone found it,
reported it to park rangers and had it removed."*
(<https://www.reddit.com/r/Slackline/comments/1pgrgrn/>)

A tool with no accounts, no submissions and no server-side record of what anyone looked at sits on
that person's side by construction — a line lives in a URL and goes to exactly the people it is sent
to. That is currently an accident of the architecture rather than something the product says.

## Where the urban half would land

The Leipzig club has spent years failing to get a city spot: *"Wir sind auf der Suche nach Spots,
waren schon in Verbindung mit der LWB und den Vermietern der Lofts in der Nonnenstraße. Bisher hatten
wir noch nicht so richtig Erfolg."* Their fallback ideas are concrete posts on roof structures and
wooden T-bars clamped into windows — neither of which an LoD1 roof height can express.
(<https://www.l-iz.de/sport/weitere/2020/08/Eine-Line-ziehen-macht-gluecklich-und-gesund-Slacklinen-in-Leipzig-342172>)
