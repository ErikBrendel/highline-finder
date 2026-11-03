# Product ideas from synthetic user testing

Dated, with the phase and persona that produced them. Nothing here is agreed — these are directions
the research suggests, for the roadmap to accept or reject.

## 2026-11-02 — phase 1b, interview with Erik (from reading)

### Tool helps
- **The shared link should arrive as the line, not as the tool.** Every recipient in the interview
  arrives through a link to one specific line; the first screen is currently the generic guide over
  a full-screen panel of sliders. — rigging-partner, newcomer
- **Say how plausible the line is, as a verdict rather than as a figure.** "Concrete or wish-line" is
  carried in the chat message today; the score and clearance are what the recipient would read it
  from. — rigging-partner S3
- **Account for the numbers where they are shown.** The sceptical reader wants the provenance at the
  line, not in a guide they have to open. — dsv-highliner S1
- **Say what happens at the Brandenburg border, on the map, where it happens.** Recipients are mostly
  elsewhere in Germany; an empty map with no explanation is a closed tab. — dsv-highliner S2
- **Hand-placed anchors have to be findable without instructions** — it is the only thing the tool
  offers the majority of its recipients. — dsv-highliner S3
- **The bare link is a second first screen, and nobody designed that one either.** A tool shared
  without a line opens on a default view plus the guide, and the recipient has to decide for
  themselves where on a map of Germany to look. This is the one arrival where the goal *is* for them
  to find their own lines. — dsv-highliner S5
- **A way out of the shared line into the map, and back.** Cheap, and the only thing between the one
  line and the rest of the tool. — newcomer S3

### Status quo wins
- **Planning a project.** Scouting in person, land owners, access and orga all happen outside and
  will keep happening outside: "the tool is just a first nice impression and search-help." Do not
  build a planning tool.
- **Finding spots at all, for the experienced.** The people Erik shares with "have worked well
  without such a tool before". The tool's edge is reach and overview on ground nobody has walked —
  not replacing the judgement of someone who has.
- **Deciding whether a line is safe.** Taught by people standing next to you. The product's job is to
  keep saying it does not answer this, not to answer it better. — newcomer S2
- **Telling a wish-line from a plan.** Carried by the chat message around the link, and that is
  enough: "Nothing — I say it in the chat message."

## 2026-11-02 — phase 1a, web research (from reading)

### Tool helps
- **The nearest competitor skipped Germany on a false premise.** HighlineScout's author believes the
  finest freely available German topographic data is 20 m; it is 1 m terrain and 0.2 m surface in
  Brandenburg, and two German highliners asked him for it in that same thread. That is an audience
  already asking for this product, and a sentence the project should be able to say about itself.
- **Nobody in the sport measures anything.** Every spot resource — Slackmap, Slackspot, the DSV, the
  Facebook groups — is a list of places someone typed in. "Measured rather than entered" is the
  distinction to lead with, not "automatic".
- **No accounts and no submissions is a feature for the people who most distrust spot databases.**
  A constituency actively avoids them because a published spot gets reported and removed. A line that
  lives in a URL and goes to exactly who it is sent to serves them by construction — currently an
  accident of the architecture rather than anything the product says.
- **The urban half has a waiting user and the wrong model.** A club has spent years failing to get a
  city line; their realistic anchors are concrete posts on roof structures and T-bars clamped in
  windows, none of which an LoD1 roof height can express. This is the roadmap's existing "anchoring
  to the side of a building" entry with a user attached. — urban-rigger
- **Something to put in front of a building owner or the Luftamt.** Where, how long, how high,
  how long for. Both of those conversations already happen and both need the same four numbers the
  product already has. — urban-rigger

### Status quo wins
- **The group chat.** One commenter argues a spot database is unnecessary precisely because the chats
  work. They do: posting "line going up Saturday" to a city group reaches the people who would come.
  The tool should ride the chat — a link that reads well pasted into one — not compete with it.
- **Being adopted by locals.** A traveller's answer is always "join the group and find the local
  one". No map replaces that.

### Contradicted by the interview
- **The friend with no vocabulary.** The research found this type everywhere; Erik's recipients are
  all highliners who know the sport but not the tool. Dropped as a persona.

### The constraint over all of it
"I fear it is too complex already and we should keep it more simple somehow." Every finding in this
run should be read against that: a fix that adds a control is probably the wrong fix.

## 2026-11-03 — phase 2, stories for the two research personas (from reading)

### Tool helps
- **A shared line link should say it is a shared line link.** The full view opens with no sign that
  someone sent it: no sender, no "this is one candidate out of 22,000", no one-line account of what
  was measured. The guide covers that ground but it is a separate page of prose on top. (every
  persona's arrival story)
- **The full view's order is backwards for a first look.** Header, sag slider, profile, stats, rig
  sliders, and only then the three-dimensional view. On a phone the picture of the place — the one
  thing that needs no explanation — is several screens below two sets of controls nobody asked for
  yet. (rigging-partner S1, newcomer S1, first-highline S4)
- **Nothing copies the link.** The address bar is the only share path. The sender is usually on a
  phone, and the urban rigger wants something to attach to an email to a housing company.
  (urban-rigger S5, rigging-partner S1)
- **A missing tile reads as a failure.** The toast says "1 background failure" when an LoD1 building
  tile 404s over rural ground where no building model exists. First impression, first screen.
  (every arrival story)
- **The score is one number standing in for five, and is read as a verdict.** Weights are exposure
  0.30, canopy 0.35, length 0.15, level 0.15, margin 0.05. Length is span over the 500 m maximum, so
  a 100 m line gives up about twelve points for being short — which says nothing about whether it is
  safe to rig, and a reader with no feel for the scale cannot tell that deduction from the canopy
  one, which says a great deal. (first-highline S3, newcomer S2)
- **The urban half does not announce itself.** Covering one rectangle of Brandenburg and no part of
  Berlin, with roof heights from a block model that cannot know about a parapet or a plant room.
  (urban-rigger S1, S3, S4)
- **Outside Brandenburg, a roof measures as ground.** Heights still come back — four state surveys,
  then the hoehendaten republisher for the rest of Germany — but only Brandenburg has a building
  model, and the republisher has no surface model either, so anything standing is invisible. The
  coverage map in the guide says this in three tiers; the measurement itself does not. (urban-rigger
  S2, dsv-highliner S3)

### Status quo wins
- **Finding spots the usual way.** Years of rigging, a memory full of places and the people who know
  them already work. Said in the interview: they "have worked well without such a tool before". The
  tool has to beat that on ground nobody has walked, not on ground they have.
- **Judging whether a first highline is safe.** That is a person standing next to you, not a number.
  The product's job here is to stop its own number from being read as that judgement.
- **The owner conversation.** Permission, access and liability are human work. The only part a tool
  can take is the plan that opens the conversation — which is exactly the part that is missing.

## 2026-11-03 — corrections from Erik, before any test was run

- **Contradicted: "a first highline wants little air".** It does not. A first highline can be a
  kilometre up; nobody picks a lower gap to be safer. The only hard constraint is span, because
  webbing that is too short cannot be stretched. The exposure-upper-bound idea is withdrawn, and the
  `first-highline` persona was rewritten around gear length and anchor quality instead.
- **Consequence for the score finding:** it is weaker than it was written. A short line loses only
  the length term, about twelve points, not the thirty the earlier note implied. What survives is
  that one number hides which of five things it is reporting.
