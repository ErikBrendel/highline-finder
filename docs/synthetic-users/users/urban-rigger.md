# Urban rigger — club member who has spent years failing to get a city line

Rigs with a city club and has been hunting a usable urban span for years: approaching a housing
company and the owners of a set of lofts, and getting nowhere. Knows the fallback tricks — concrete
posts on a roof structure, industrial slings to whatever is anchored, wooden T-bars clamped into a
window frame — none of which is a roof surface. Arrives at this tool to find out whether it knows
anything about the buildings they have been staring at, and whether it produces anything they could
put in front of an owner.

- **Why this persona:** the only one who touches the urban half — the outlined rectangles, the roof
  anchors, and the hole where Berlin's building model should be. Everyone else tests the natural
  dataset. Also the only producer among the five who arrives with a specific building in mind.
- **Merged from:** urban rooftop hunter (Leipzig club), event / record rigger (the Weser lines from a
  malt silo and an admin building), permit and airspace filer, the landowner-facing half of "one page
  that says where, how long, how high"
- **Device:** laptop, at home, in the evening, with time. Emulate as `desktop`.
- **Tech comfort:** medium to high — used to arguing with maps and to reading a plan.
- **Sources:** https://www.l-iz.de/sport/weitere/2020/08/Eine-Line-ziehen-macht-gluecklich-und-gesund-Slacklinen-in-Leipzig-342172 , https://www.weser-kurier.de/bremen/bremen-slackliner-wollen-deutschland-rekord-aufstellen-doc7vfrezbdfecv5hhhhxl , https://deutscherslacklineverband.org/highlines-anmelden/

## Context
In a city club, not in Brandenburg. Has a specific building in mind and has already been turned down
on it: the club "waren schon in Verbindung mit der LWB und den Vermietern der Lofts in der
Nonnenstraße. Bisher hatten wir noch nicht so richtig Erfolg." The blocker is permission, not
geometry — but every conversation with an owner starts with a plan, and the plan is what they do not
have.

## How they do it today
Google Earth and Street View to pick roofs, a tape measure or a rangefinder on the day, and whoever
in the club has stood on the roof before. For the owner conversation: a screenshot, a hand-drawn
span and a verbal height. It works badly and it is the only thing there is, which makes this the one
place where a tool can beat the status quo outright.

## Goals and frustrations
- Find out whether this thing knows anything about buildings at all, and where.
- Get a number for a span they already have in mind, rather than discovering a new one.
- Come away with something that can be put in front of a housing company without embarrassment.
- Not be told about a roof the model has guessed flat when it has a plant room on it.

## User stories
### S1 — Does it do cities?
- **Arrives:** the bare tool, on a laptop in the evening. `http://localhost:5173/highline-finder/`
- **Device:** desktop
- **Wants:** "I rig in a city. Is any of this about buildings, or is it all forest?"
- **Done when:** they have found urban lines on the screen and understood that the urban half covers
  only the outlined rectangles, not the whole state.
- **Gives up when:** nothing distinguishes an urban line from a natural one and they conclude the
  tool is a forest tool.
- **Without the tool:** Google Earth, which at least shows every city.

### S2 — My own city
- **Arrives:** continuing from S1, panning to the city they actually rig in — outside Brandenburg.
- **Device:** desktop
- **Wants:** "Measure the span I have been staring at for two years."
- **Done when:** they have placed two anchors by hand on their building and read back a length and a
  height — or understood why they cannot.
- **Gives up when:** the measurement fails silently. Saxony's survey serves no CORS header, so a
  hand-placed anchor there cannot be measured at all: this is a real product limitation, and what it
  looks like to the person it happens to is the finding.
- **Without the tool:** the rangefinder, on the day, after getting on the roof — which needs the
  permission this plan was supposed to help get.

### S3 — What the roof end actually is
- **Arrives:** opening the best urban line in the one covered area.
  `?line=418347.5_5856059.5__418262.5_5856107.5&full=1`
- **Device:** desktop
- **Wants:** "Which building is this, how high is the end it hangs from, and is that a real height or
  a model's guess?"
- **Done when:** they can say what the roof anchor is standing on and how confident the height is.
- **Gives up when:** the roof end is just a number with no building behind it. A block height from
  the LoD1 model cannot say whether there is a parapet, a plant room or anything to sling to, and a
  rigger who has clamped T-bars into window frames knows that is the whole question.
- **Without the tool:** Street View, and a look from the pavement.

### S4 — The hole where Berlin should be
- **Arrives:** panning to Berlin, the obvious place to look for a city line.
- **Device:** desktop
- **Wants:** "The biggest city in the region. Show me its roofs."
- **Done when:** they understand that there are no buildings in Berlin's data and that this is a gap
  in the source, not an absence of lines.
- **Gives up when:** the map is simply empty and they read that as "no city lines exist".
- **Without the tool:** everyone in Berlin already does this by eye.

### S5 — Something to put in front of an owner
- **Arrives:** at the end of the sitting, with a line open.
- **Device:** desktop
- **Wants:** one page that says where, how long, how high, and over what — to attach to the next
  email to a housing company.
- **Done when:** they have got a link, an image or a printable view that would survive being
  forwarded to someone who has never heard of highlining.
- **Gives up when:** the only way out is a screenshot of a developer's map, which is what they are
  already doing badly.
- **Without the tool:** the screenshot, a drawn line and a verbal height. The weakest status quo of
  any story in this run.
