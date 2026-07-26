# Narrative World State Tracker
### A SillyTavern Extension

> **Status: In Development** — This extension is currently being built. This README reflects the planned feature set and design. Not yet available for installation.

---

## What's New — Event Lifecycle Maintenance

The event system now maintains itself across its whole lifecycle instead of only creating events:

- **Events move forward through time on their own.** During day advancement, any event with a parseable date ("Day 12", "Day 10-14", or a literal calendar date) is rolled structurally with zero API calls: it's pulled into the *week* tier when it's within seven days, into *immediate* when it's due today or tomorrow, and marked *missed* if its window passed while it sat in a later tier. Immediate events scheduled for the new day are protected from being marked missed on their own day.
- **Undated events are placed by the Planning LLM.** The existing day-advance review call (same single API call as before) now also suggests time tiers for events that have no parseable date, based on narrative urgency. Tier placement is applied directly — it's freely reversible in the Events tab.
- **The recurring scan now keeps events truthful to the story.** The per-N-messages scan can mark an active event *resolved* when its moment clearly happened on-screen, *missed* when its window clearly passed, and correct tiers for undated events — conservatively, with instructions that most scans should leave events untouched. This fixes the case where an event that actually happened in the roleplay would later be mislabeled "missed" by day advancement because nothing had recorded that it occurred.
- **Concluded events holding concealed knowledge queue for secret promotion.** The day-advance review (same call again) assesses resolved/missed events for concealed knowledge — information some characters hold that others don't. Candidates appear as review cards in the Events tab with Promote / Don't-promote buttons. Either choice removes the concluded event from the list and preserves a summary in the Notebook's Past Events; promoting first creates the secret with LLM-inferred whoKnows/whoDoesNotKnow. Events awaiting your decision are protected from compaction and from the structural roll.
- **Silent auto-promotion has been removed.** Previously, a default-on setting instantly promoted any resolved/missed event with participants to a secret — no review, no queue. That path is gone; its settings toggle now gates the queued planner assessment described above instead. Manual promotion from event cards is unchanged.
- **"This Week" is calendar-anchored.** The week runs from weekday #1 to weekday #N of your Calendar Config's weekday list (N is the list length — not hardcoded to 7), with a `startWeekday` config value (default 1) recording which weekday story Day 1 fell on. Dated events place by pure arithmetic: past their window → missed; today/tomorrow → immediate (distance-based on purpose, so a "tomorrow" event never hides behind a week boundary); before the current weekday cycle ends → week; beyond → month. Expect a one-time reshuffle of dated events at your first day advancement — it's the new boundaries taking effect, and it's snapshot-undoable.
- **Undated events now age.** Events stamp the story day they enter a tier (`tierSetDay`), and the day-advance review sees "in this tier for N story days" per undated event, with a staleness rule: undated week events sitting past ~7 story days or month events past ~30 must be re-tiered or reported for your Keep/Mark-missed decision. Existing events gain their stamp on their next tier change; until then they read as age-unknown.
- **Roll-missed events now compact.** Events marked missed by the structural roll never received a resolve day, so Event Horizon Compaction skipped them forever. They're stamped now and age out into the Notebook's Past Events like everything else.
- **The Undetermined tier is protected.** Undetermined events are deliberately timeless, so no automated pipeline (structural roll, day-advance review, recurring scan, or timeskip) will ever move events into or out of that tier. They can still conclude — the scan may mark one resolved when it clearly happens on-screen or missed when its premise dies, and a *dated* undetermined event whose window objectively passes goes missed — but re-tiering them is yours alone, and the staleness rule ignores them entirely.
- **Undetermined events can find their timing — with your approval.** When the story explicitly fixes when a timeless event will occur (a stated date, a countdown, a scheduled confrontation), the day-advance review proposes a placement as a "⏰ Timing proposal" card in the Events tab: proposed tier, a "Day N" date when computable, and the reason. Accept moves the event out of undetermined onto the calendar (stamping its age); Keep timeless dismisses it, and that event won't be re-proposed for ~7 story days. This is the only door out of the undetermined tier besides your own edits, and it only opens on your click. Same single review API call as before.
- **Special Days on the calendar.** The Calendar Config now has a Special Days editor — saved days collapse into cards grouped into sections by category, and tapping a card opens it for editing with its own Save button, Events-style. Name a recurring day, pick its month and day (month dropdowns use your custom month names), optionally give it a range ("through" a second month/day for spans like a festival), and pick a category — Birthday, Anniversary, Holiday, Festival, Feast Day, Memorial, Ritual Day, Ceremony, Religious Observance, Wedding, Market Day, Tournament, Performance, Deadline, Appointment, Payment Due, Election, Founding Day, Harvest, Astronomical, Pilgrimage, School/Exams, or Custom with your own text — plus an optional lore description (what the day means, how it's observed, who cares) that is carried into the materialized event each year so the roleplay LLM can actually use it. When a day's occurrence enters the current calendar month (or sooner for last-minute additions — within the week or tomorrow), it materializes as a real dated event with a category chip on its card, starting under "This month" and walked forward by the anchored calendar like any dated event, recurring annually with one event per occurrence (resolving or deleting one won't resurrect it until next year). Saving the calendar config surfaces near-term days immediately; everything is structural with zero API calls. Ranges display as "Day 206-215" with the month-name form in the description so the LLM can phrase either.
- **Timeskips can re-tier surviving events.** The timeskip prompt always asked the LLM to correct event tiers, but the response schema had no field for it and the answer was silently dropped. The schema and applier now support tier changes, and re-tiered events are protected from the timeskip's auto-resolve pass.

---

## What Is This?

Narrative World State Tracker (NWST) is a SillyTavern extension that maintains a **living world state** for ongoing roleplays. Instead of manually tracking what day it is, what the weather looks like, what events are coming up, or what political tensions are simmering in the background, NWST handles all of it automatically — and injects the relevant context into your main prompt so your AI always knows what world it's writing in.

It runs quietly in the background on a configurable message cadence, updating as your story evolves. Everything it generates is editable. Nothing is permanent until you say so.

---

## Features

### 🗓 Day & Date Tracking
- Tracks the current in-game date with a rich display (supports real-world and fantasy calendar formats)
- Optional **East Asian lunisolar calendar engine** for historical, fantasy, and other non-Gregorian settings — keep 12 configurable base month names while NWST automatically supplies year-specific 29/30-day month lengths and inserts an intercalary month when needed. Special Days remain attached to their base month rather than shifting when a leap month appears. This is a reusable compatibility calendar, not a claim of exact reconstruction for every historical regional calendar.
- Optional **Nager.Date real-world holidays** for Gregorian-compatible chats — including custom calendars that only rename months/weekdays while keeping the standard 12-month day structure; choose a country, optional subdivision, and holiday types; nationwide/regional holidays stay separate from Special Days and Events, are cached locally once per country/year, can appear beneath the Home date, and can enter prompt context beginning 7 days before their scheduled date by default (the window is adjustable). Failed fetches do not block NWST and retry on the next story-day advance until a cache is obtained.
- Prev/Next Day navigation with full state snapshots — going back to a previous day restores exactly what was there, no data loss
- **Time Skip** — enter a natural language description ("Three weeks later, end of harvest season") and the extension performs a full narrative overhaul across all components automatically
- Manual date editing for typo corrections — does not trigger API calls
- **Separate calendar position and story duration** — the annual `dayCount` now wraps with the configured calendar while `elapsedStoryDays` tracks how much canonical story time has actually passed. Event aging, compaction, cooldowns, and other duration logic no longer break at New Year.
- **Starting Date catch-up** — adding a Starting Date to an existing chat can parse the current configured-calendar date, calculate the elapsed distance, and rebase duration markers without resetting your world state.
- Custom month names, configured weekday cycles, leap years, year rollover, and cross-year Special Day ranges are handled by the calendar engine rather than assuming a fixed 365-day/7-day calendar.

### 🌤 Weather & Moon Phases
- 7-day forecast with weather icons, descriptions, hi/lo temperatures in both °F and °C, and precipitation chance
- 7-day moon phase strip alongside the forecast
- **Per-chat moon configuration** — each roleplay can keep its own moon count, moon names, cycle lengths, and phenomenon settings instead of sharing one global lunar setup.
- **Expanded moon phenomena** — calendar-detected Blue Moons, solar/lunar eclipse subtypes, Earthshine, Moonbows, lunar halos/coronas, Moondogs, Moon Pillars, occultations, and other rare orbital/atmospheric effects.
- **Manual phenomenon overrides** — assign a phenomenon or custom anomaly to a specific calendar date/range without altering the underlying mathematical moon cycle.
- Regenerate the forecast at any time without rerolling severe weather
- **Saved Setting Context profiles (per chat).** Keep multiple foundational world/arc contexts and switch them manually. A profile switch never rewrites stored state automatically: NWST offers an optional, granular refresh for the Current Day environment/7-day forecast, World Conditions, and active LLM-generated world events. Notebook, Secrets, Communities, NPC events, detected/story-grounded events, Special Days, calendar/date state, and resolved event history are preserved. The same refresh dialog can be opened later from **Refresh Setting State…**, which is useful when the Weather Profile also needs to be switched first. Legacy single-context chats migrate transparently into a Default Setting profile.
- **Saved Weather Profiles (per chat).** Climate, terrain, local characteristics, frequency, overrides, active severe-weather state, and recent history are stored per region/profile and selected manually. Setting Context and Weather Profile remain intentionally independent; changing Setting Context only reminds you to review the Weather Profile.
- **Context/Profile snapshot history.** Manual Setting Context and Weather Profile changes get their own labeled undo snapshots in Debug, completely separate from Previous Day/day-boundary rewind history. Profile switches save lightweight pre-change profile state; an approved Setting Context regeneration saves a richer pre-refresh snapshot containing only the environment/forecast, World Conditions, and/or generated-event state selected for regeneration. Restore, delete, and clear controls are available without affecting chronological story snapshots.
- **Experimental Severe Weather generator.** On legitimate story-day advancement, deterministic RNG first decides whether a severe system forms, then weights eligible systems by current season + active profile climate/terrain/characteristics. The v1 pool includes Severe Thunderstorms, Torrential Rain, Prolonged Heavy Rain, Windstorms, Tropical Cyclones/Typhoons, Heavy Snow, Blizzards, Snow Squalls, Ice Storms/Freezing Rain, Cold Waves, Heat Waves, Dust/Sandstorms, and Dense/Hazardous Fog. Incompatible systems are strongly suppressed or impossible (e.g. summer blizzards and deep-winter typhoons), while transitional-season events remain possible where appropriate.
- Severe systems store **severity, start timing, active duration, recovery/aftermath, and derived hazards**. Major systems can be scheduled several days ahead so the forecast LLM foreshadows their arrival; short events can begin morning/afternoon/evening/overnight. The forecast LLM receives the result as a hard constraint — it describes the weather but does not choose or reroll it.
- **Profile-specific Weather Overrides** can deliberately force an event and bypass season/climate restrictions, including custom supernatural weather. Recent severe weather applies a short cooldown so the RNG does not repeatedly chain disasters without reason.
- Climate-aware generation — Setting Context plus the active Weather Profile ground ordinary weather so the forecast stays appropriate to real, historical, fantasy, or abstract worlds.

### 📋 Event Horizon
Four visible event tiers — **Immediate**, **This Week**, **This Month**, and **Undetermined** — each with its own regeneration control. Dated events beyond the current calendar month are held in an internal **Future Scheduled** queue and automatically surface when they enter a visible horizon.

Events come from two sources:
- **Detected** — the extension reads your chat and picks up explicit plans, arrangements, and scheduled happenings mentioned in text
- **Generated** — the planning LLM extrapolates plausible events from your world context, setting details, and current conditions

Events are further divided into:
- **NPC Events** — character-driven, orbit the player (meetings, hangouts, plans made between characters, birthdays)
- **World Events** — setting-driven, exist independently of player involvement (seasonal observances, political movements, cultural happenings, environmental cycles)

All proposed events require your approval before being committed. Undetermined events are **never** auto-regenerated — their timing is intentional. Pending proposals can also be approved or dismissed in bulk from Home.

Each event has a status: **Pending**, **In Progress**, **Resolved**, or **Missed**. Resolved and missed events are automatically excluded from prompt injection.

- Dated event placement is resolved structurally from the configured calendar, while tier age and compaction use elapsed story duration.
- Event validity review now distinguishes **Keep Event**, **Mark Resolved**, and **Mark Missed** instead of treating every expired premise as the same outcome.
- Time skips can re-tier surviving events, and existing events that are not explicitly changed by the LLM are preserved rather than silently auto-resolved.
- Concluded events promoted into Secrets are cleaned out of the active horizon after their history is preserved.

### 🌍 World State Conditions
Four condition tracks — **Political**, **Social**, **Spiritual/Supernatural**, and **Environmental** — each individually toggleable. Toggle a condition off and the extension stops tracking it, stops spending tokens on it, and stops injecting it. Useful for slice-of-life settings where political tracking would only poison the tone.

The Spiritual/Supernatural condition also controls whether a **Spiritual Climate** field appears in the current day block.

- Cadence updates now require **world-scale evidence** for grounded changes, with category-specific validation that rejects scene-level contamination, unsupported scale inflation, and ordinary character interactions masquerading as global state.
- Manual condition regeneration uses a restrained **ambient world** pass designed to rebuild durable background context without mining the active plot; invalid responses preserve the existing condition.

### 📓 Notebook
The planning LLM's internal working surface. Never injected into your main prompt. Three collapsible sections:

**Core**
- Unresolved details
- Promises / threats / deadlines
- Offscreen pressure
- Do not forget

**Mystery & Continuity**
- Established facts — do not contradict
- Planted details — not yet resolved
- Character whereabouts (offscreen)
- Inconsistencies flagged
- Current tone / atmosphere

**Secrets & Hidden Knowledge** — structured entries with:
- Secret text
- Who Knows (green) / Who Does NOT Know (red)
- Evidence already shown
- Pressure / risk
- Reveal conditions
- Type: Character secret / User-PC secret / World secret / Dramatic irony / Unconfirmed suspicion

The **who knows / who does not know** split is the most critical feature of the secrets system. The Narrative Consistency profile actively monitors to ensure characters never act on knowledge they shouldn't have.

- Cadence scans can retire stale or superseded Notebook state when a deadline resolves, a planted detail pays off, a pressure is replaced, or an inconsistency is fixed, while preserving durable historical facts.
- Secret knowledge lists now receive alias-aware integrity repair so short/full-name variants and reversed name order do not leave the same character duplicated across knowledge states.

### 🤝 Community Summaries
The extension detects recurring character clusters and generates community summaries — macro-level context about factions, social circles, and group dynamics. These inform event generation and world state updates but are never injected into the main prompt.

Community maintenance now emphasizes durable collective structure, hierarchy, loyalties, fractures, and shared pressures instead of scene recap. Membership updates preserve absent members unless the story actually establishes a change, and alias-aware merging reduces duplicate communities/characters.

### 🔍 Narrative Consistency Monitoring
A dedicated lightweight LLM profile monitors secrets on the same cadence as the message scanner. It checks whether any character acted on knowledge they shouldn't have, whether reveal conditions have been met, and whether anything feels inconsistent with established facts. Flags are written to a **Consistency Flags** field in the notebook for your review — the LLM flags, you decide.

A separate **Secrets Sidecar** profile performs lightweight scene-presence and pressure analysis so secret relevance can distinguish characters who are actually present from characters merely mentioned in narration, documents, memories, or offscreen discussion.

Secrets are injected **selectively**: only when a character from the "Who Knows" list is detected as present in the current scene. Secrets whose characters aren't in the scene stay silent. Short/full-name variants are reconciled when knowledge changes are applied.

### 🔄 Cadence Scanner
- Cadence scanning is split into a **detailed continuity pass** (Notebook, Secrets, detected future plans, active Event status) and a **World/Community pass** for macro-scale persistent state. Both responses are validated before either pass is applied, preventing half-applied scan windows.
- Scan windows are bounded and backlog-aware so older unscanned messages are processed in order instead of being skipped when a backlog develops.
- A Home-tab health indicator reports warmup progress, active scanning, backlog, the last successful scan, failures, and when the next cadence pass is due.
- Explicit completion-token budgets are used across NWST's structured LLM calls to reduce reasoning-heavy models exhausting their response allowance before returning valid JSON.

### ⚡ Batch Scan
Install mid-campaign? Run the batch scan. The extension reads your full chat history and generates an initial world state across all components — current day, forecast, events, world conditions, notebook fields, and community groupings. Non-compounding: it will not overwrite data you've already entered.

---

## How It Works

NWST uses **four LLM connection profiles**, each suited to a different kind of task:

| Profile | Job | Recommended Tier |
|---|---|---|
| **Planning LLM** | Continuity scanning, world/community maintenance, event generation, time skips, notebook, batch scan | Frontier/capable model |
| **Day Advancement LLM** | Date, forecast, moon phase generation | Lighter model |
| **Narrative Consistency LLM** | Secrets knowledge reconciliation, reveal tracking, and consistency checks | Capable mid-size or local model |
| **Secrets Sidecar LLM** | Lightweight scene presence and pressure analysis used for secret relevance scoring | Small, fast local or hosted model |

All profiles use **connection profiles you have already set up in SillyTavern**. No separate API keys required.

---

## Prompt Injection

The following is injected into your main prompt on every message:
- Current day block (date, season, weather, flora/fauna, spiritual climate if enabled)
- 7-day forecast and moon phases
- Active upcoming events (pending and in-progress only)
- Active world conditions (enabled conditions only)
- Active secret blocks (selectively, when relevant characters are present)

The following is **never** injected:
- Notebook fields
- Community summaries
- Secrets (except when selectively triggered by the Narrative Consistency profile)

Injection placement is fully configurable: Before/After Main Prompt, Top/Bottom of Author's Note, or Inject at Depth with role selector (System / User / Assistant).

---


## Starting Date, Calendar Cycles & Elapsed Story Days

NWST keeps **calendar position** and **story duration** as separate concepts. Saving a Starting Date never resets your current world state, events, notebook, secrets, or calendar.

- **`dayCount` is cyclical.** It is the 1-based position inside the current configured calendar year and wraps back to 1 at New Year. Its maximum comes from that year's configured month lengths, so custom calendars can be shorter or longer than 365 days. Seasons and recurring Special Days use this annual position.
- **`elapsedStoryDays` is duration only.** The Starting Date is elapsed day 0. It increases as canonical story days pass and is used for event tier age, resolution age, compaction, and review cooldowns. It does not drive seasons, Special Days, or weekday progression.
- **Weekdays use the configured weekday cycle.** Weekday progression continues through New Year independently of the cyclical annual day count.
- **One-time Starting Date entry.** Enter the story's actual first canonical date. Standard Gregorian forms and configured custom month names are supported. Confirmation shows how the date was interpreted before the field locks.
- **Late setup catches up immediately.** If NWST already has a Current Day when you enter the Starting Date, it parses the current LLM-written date using that chat's Calendar Config, calculates the configured-calendar distance from Starting Date to Current Day, and rebases duration markers by the same offset.
- **Custom LLM-written dates are supported.** Current-date parsing matches configured month names longest-first, including punctuation/commas, and can read an absolute year from the secondary date line. Formats such as `Doyōbi, Jūgatsu 19` + `Reiwa 6 • 2024` or `Frostwane, the Eleventh Month · Seventh Day` + `Imperial Era · 1125 CE` are supported.
- **Day advances are calendar-built.** The canonical date advances through configured month lengths and year rollover directly; `elapsedStoryDays` increments separately and the annual `dayCount` is recalculated from the resulting date.
- **International format** reads ambiguous numeric dates day-first when enabled. **Leap years** apply to Gregorian-compatible 12-month calendars when enabled, including renamed Earth-calendar month sets. In **Lunisolar** mode, Gregorian leap-day handling is replaced by dynamic 29/30-day months and intercalary-month insertion for each calendar year.
- **Eras.** Custom calendars use the **Era name** field (write `{year}` for the computed year). Real-world era labels may remain LLM-written or player-pinned while the absolute year is used for calendar arithmetic.

## Data Storage

All narrative data is stored **per chat**. Your high fantasy roleplay has its own world state, events, notebook, Setting Context profile library, and Weather Profile library. Your modern city roleplay has its own. Opening a different chat loads that chat's data entirely. There is no crossover.

Narrative-state snapshots are saved at day advancement boundaries. Previous Day restores the saved world state, events, notebook, active Setting Context selection, and severe-weather simulation state for that boundary. Batch-scan and pre-time-skip landmark snapshots are protected from retention pruning, so the stored total can exceed the configured snapshot target when necessary.

---

## UI Overview

Five tabs:

- **Home** — current day journal view, day navigation, time skip, 7-day forecast, moon phases, upcoming events digest
- **Events** — full event horizon management across all four tiers
- **World State** — condition tracks with visibility toggles, community summaries
- **Notebook** — accordion sections for core notes, mystery & continuity, secrets
- **Settings** — connection profiles, scan frequency, setting context, injection placement, planner prompt, batch scan, import/export

All editable fields support a **⛶ popout editor** for comfortable editing in a larger modal — especially useful on mobile.

---

## Requirements

- [SillyTavern](https://github.com/SillyTavern/SillyTavern) (1.18.0 or higher)
- At least one configured API connection in SillyTavern
- A second connection profile recommended for Day Advancement (lighter model)
- A third connection profile recommended for Narrative Consistency (mid-size or local model)
- A fourth lightweight connection profile recommended for the Secrets Sidecar

---

## Installation

> Installation instructions will be added when the extension reaches a stable release.

---

## Compatibility

Built to use SillyTavern's native structures throughout — prompt injection API, connection profile system, extension panel, chat storage, and message visibility. Does not require any other extensions to function. Optional compatibility with Kaldigo-style day trackers is planned for a future update.

---

## Roadmap

- [ ] Initial build and feature-complete release
- [ ] Mobile UI testing and refinement
- [ ] Extensions Chat Pop-Out Menu
- [ ] Fantasy calendar support (custom cycle lengths)
- [ ] Optional Kaldigo integration hook for automatic day detection (maybe)

---

## Credits

Designed and directed by [ExtensionMuncher](https://github.com/ExtensionMuncher). Built with [Zoo Code](https://github.com/Zoo-Code-Org/Zoo-Code/) in VS Code.

---

> *This extension was designed for complex, long-running narrative roleplays where world continuity matters. If your story has multiple characters, mysteries, factions, seasonal rhythms, and characters with secrets — this was built for you.*
