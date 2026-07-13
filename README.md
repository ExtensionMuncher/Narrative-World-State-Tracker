# Narrative World State Tracker
### A SillyTavern Extension

> **Status: Alpha** — Core features are functional and being tested in active roleplays. Expect rough edges, especially in fantasy calendar and multi-moon configurations. Report bugs via GitHub Issues.

No additional features planned at this time. Strictly for bug fixes and refinement.

---

## What Is This?

Narrative World State Tracker (NWST) is a SillyTavern extension that maintains a **living world state** for ongoing roleplays. Instead of manually tracking what day it is, what the weather looks like, what events are coming up, or what political tensions are simmering in the background, NWST handles all of it automatically — and injects the relevant context into your main prompt so your AI always knows what world it's writing in.

It runs quietly in the background on a configurable message cadence, updating as your story evolves. Everything it generates is editable. Nothing is committed until you approve it.

---

## Features

### 🗓 Day & Date Tracking
- Tracks the current in-game date with a rich display (supports real-world and fantasy calendar formats)
- **Prev/Next Day** navigation with full state snapshots — going back restores exactly what was there, no API call, no data loss
- **Time Skip** — enter a natural language description ("Three weeks later, end of harvest season") and the extension performs a full narrative overhaul across all components automatically, with automatic rollback if anything fails
- Manual date editing for corrections — does not trigger API calls
- Configurable snapshot cap (default 30) to keep per-chat file size bounded; batch scan and time skip snapshots are always protected from pruning

### 🌤 Weather, Forecast & Moon Phases
- 7-day forecast with weather icons, descriptions, hi/lo temperatures in °F and °C, and precipitation chance
- 7-day moon phase strip alongside the forecast, computed programmatically — no LLM involvement, no API cost
- Moon phenomena (Blood Moons, Lunar Eclipses, Moonbows, Harvest Moons) generated via deterministic seeding — same phase always produces the same phenomenon
- Multi-moon support for fantasy worlds — define additional moons with custom cycle lengths in Settings
- Regenerate the forecast at any time
- Setting Context field defines your world's geography and climate so forecasts stay appropriate to your setting

### 📋 Event Horizon
Four event tiers — **Immediate**, **This Week**, **This Month**, and **Undetermined** — each with its own regeneration control.

Tiers are **calendar-anchored**: the week runs from weekday #1 to weekday #N of your calendar's weekday list (N is the list length — not hardcoded to 7). *Immediate* means today or tomorrow, *This Week* means before the current weekday cycle ends, *This Month* means beyond this week, and *Undetermined* means deliberately timeless — no clock applies (see Event Lifecycle below).

Events come from three origins:
- **Detected** — the scanner reads your chat and picks up explicit plans, arrangements, and scheduled happenings mentioned in text. These are proposed for your review and never auto-committed.
- **Generated** — the Planning LLM extrapolates plausible events from world context, setting details, current conditions, community dynamics, and character behavior

Events are further divided by type:
- **NPC Events** — character-driven (meetings, plans, routines, character behavior extrapolated from established dynamics). NPC events detected from explicit chat text bypass all pool caps — they're facts, not generated content.
- **World Events** — setting-driven, exist independently of characters (seasonal observances, political movements, cultural happenings, environmental cycles). Auto-topped up when the pool runs thin after day advancement.
- **Special Days** — player-defined recurring calendar days (see the Special Days section below) materialize as dated events automatically, each wearing a category chip on its card.

**Event caps (per regen call):**
- Detected NPC events: no cap
- Generated NPC events: max 3 per tier
- World events: max 2 per tier
- Active event pool: configurable maximum (default 12, set in Injection Settings). Only pending and in-progress events count toward this cap.

All proposed events appear in the **Pending Events** section on the Home tab for approval before being committed. Undetermined events are **never** auto-regenerated — their timing is intentional.

Each event has a status: **Pending**, **In Progress**, **Resolved**, or **Missed**. Resolved and missed events are excluded from prompt injection automatically, and after ~3 story days they compact into the Notebook's Past Events as one-line summaries so the active list stays lean.

### 🔄 Event Lifecycle
Events don't just get created — the system maintains them across their whole life, splitting the work between free structural math and the LLM passes that already run:

- **Dated events move on their own.** During day advancement, any event with a parseable date ("Day 12", "Day 10-14" ranges, or a literal calendar date) is placed structurally with zero API calls: pulled into *This Week* when it falls before the current weekday cycle ends, into *Immediate* when due today or tomorrow (distance-based on purpose, so a "tomorrow" event never hides behind a week boundary), and marked *Missed* if its window passed. Demotions happen too — an event dated into next cycle settles back into *This Month* until the week rolls over.
- **The recurring scan keeps events truthful.** The message scanner can mark an active event *Resolved* when its moment clearly happened on-screen, *Missed* when its window visibly passed, and correct tiers for undated events — conservatively, with instructions that most scans should leave events untouched. This prevents the classic failure where something that actually happened in the roleplay later gets mislabeled "missed" because nothing recorded that it occurred.
- **Undated events age.** Every event stamps the story day it entered its tier, and the day-advance review sees "in this tier for N story days" — undated events squatting past their tier's natural horizon (~7 days for week, ~30 for month) must be re-tiered or escalated for your decision.
- **One review call, four jobs.** After each day advancement, a single Planning LLM call reviews events four ways: it flags active events whose premise has become impossible or moot (queued for your **Keep / Mark missed** decision — never removed automatically), places undated events into the right tier by narrative urgency, proposes timing for undetermined events whose moment the story has fixed, and assesses concluded events for concealed knowledge. Skipped entirely when there's nothing to review.
- **The Undetermined tier is protected.** Undetermined events are deliberately timeless: no automated pipeline — structural roll, review, scanner, or time skip — will ever move events into or out of that tier. They can still conclude (resolved when they happen, missed when their premise dies), but re-tiering them is yours alone. The one exception is opt-in: when the story explicitly fixes an undetermined event's timing (a stated date, a countdown, a scheduled confrontation), a **⏰ Timing proposal** card appears in the Events tab with the suggested placement and reason — Accept moves it onto the calendar; Keep Timeless dismisses it, and that event won't be re-proposed for about a week of story days.
- **Concluded events can become secrets — with your approval.** The day-advance review flags resolved/missed events whose outcome constitutes concealed knowledge (information some characters now hold that others don't). Candidates appear as **🔒 Promotion review** cards: *Promote to secret* creates a Notebook secret with LLM-inferred Who Knows / Who Does NOT Know; *Don't promote* declines. Either way the concluded event leaves the list, with a summary preserved in the Notebook's Past Events. Nothing is ever promoted silently — the old automatic promotion path has been removed, and the settings toggle now gates this queued assessment instead. Manual promotion from event cards remains available regardless.
- Events awaiting any of your decisions (validity, timing, or promotion cards) are shielded from the structural roll, the scanner, and compaction until you decide.

### 🎉 Special Days
Hardcode the calendar days your story cares about — birthdays, holidays, festivals, deadlines — instead of hoping the AI infers them. Configured in **Settings → Calendar Config**:

- **22 categories plus Custom**, each with its own chip: 🎂 Birthday, 💍 Anniversary, 🎉 Holiday, 🎪 Festival, 🍖 Feast Day, 🕯️ Memorial, 🔮 Ritual Day, 👑 Ceremony, ⛪ Religious Observance, 💒 Wedding, 🛒 Market Day, ⚔️ Tournament, 🎭 Performance, ⏳ Deadline, 🗓️ Appointment, 💰 Payment Due, 🗳️ Election, 🏛️ Founding Day, 🌾 Harvest, 🌘 Astronomical, 🚶 Pilgrimage, 🎓 School/Exams, and 📌 Custom with your own label
- **Single days or spans** — "Harvest 25" or "Harvest 25 – Amberfall 3", using your calendar's own month names, with multi-day ranges displaying as "Day 206-215" in the event
- **Optional lore description** — what the day means, how it's observed, who cares — carried into the materialized event every year so the roleplay LLM has real material to write with, not just a name
- **Card-based editor** — saved days collapse into cards grouped into sections by category; tap a card to open it for editing with its own Save button inside, Events-style. New days are drafted in place and commit only when you save them.
- **Automatic materialization, zero API calls** — when a day's occurrence enters the current calendar month (or sooner for last-minute additions), it appears as a real dated event starting under *This Month*, and the calendar walks it forward from there. Recurs annually, with exactly one event per occurrence — resolving or deleting this year's instance won't resurrect it until next year.
- Works with fully custom calendars: month names, month lengths, weekday counts, and years that wrap ranges across New Year are all respected.

### 🌍 World State Conditions
Four condition tracks — **Political**, **Social**, **Spiritual/Supernatural**, and **Environmental** — each individually toggleable via the eye icon. Toggle a condition off and the extension stops tracking it, stops spending tokens on it, and stops injecting it.

The Spiritual/Supernatural condition also controls whether a **Spiritual Climate** field appears in the current day block.

Conditions are written as atmospheric narratives — not plot summaries. They describe the macro mood, tensions, and undercurrents of the world, and are updated by the scanner as the story evolves.

### 📓 Notebook
The Planning LLM's internal working surface. **Never injected into your main prompt.** Three collapsible sections, all starting collapsed:

**Core**
- Unresolved details
- Promises / threats / deadlines
- Offscreen pressure
- Do not forget

**Mystery & Continuity**
- Established facts (the LLM treats these as constraints — it will not contradict them)
- Planted details (seeds not yet paid off)
- Character whereabouts (offscreen)
- Inconsistencies flagged
- Current tone / atmosphere

**Secrets & Hidden Knowledge** — structured entries with:
- Type badge: Character / User-PC / World / Dramatic Irony / Unconfirmed Suspicion
- Secret text
- Who Knows (green) / Who Does NOT Know (red)
- Evidence already shown
- Pressure / risk
- Reveal conditions
- **Injection Priority**: Critical / High / Normal / Low — an urgency modifier in relevance scoring, not an on/off gate (see Secrets section below)

### 🔐 Secrets Engine (v2) — Relevance-Scored Injection
Secrets are selected by **relevance scoring**, not a presence gate. The old system only injected a secret when its knower (and, for Normal priority, an at-risk party) was physically in the scene — which is structurally blind to cutaways, where characters scheme offscreen exactly when a secret is most alive. In v2, every secret accumulates points from independent signals and no single missing signal silences it, so a surveillance cutaway involving a secret's holder scores high with the unaware party nowhere in sight.

**How it works, in brief:**
- An **alias registry** resolves every way an entity gets named (titles, epithets, spelling variants, diacritics) to one canonical ID — auto-built from your secrets and communities, with a manual Alias Manager for the cases it can't infer.
- A cheap **Secrets Sidecar LLM** reads recent prose on its own cadence (default every 10 messages) and returns scene comprehension pure JS can't: pronoun resolution, scene type (player-present / cutaway / surveillance / faction), and active narrative pressures. Its read is cached and reused.
- A **pure-JavaScript scoring engine** — zero API calls, runs before every generation — scores each secret against the scene: knower present, unaware party present, both at once (irony live), cutaway involving the holder, anchor/subject match, reveal conditions approaching, pressure active, and more. All 13 weights are editable in Settings → Secrets Engine.
- Winners above the **injection threshold** (default 30) inject as narrator guidance with explicit knowledge boundaries, filled from the top score down until either the **max count** (default 4) or the **token budget** (default 600) is hit.

**Priority is now an urgency modifier, not a gate** — Critical / High / Normal / Low adjust a secret's score up or down, but any secret can fire when the scene makes it relevant. You no longer need to mark everything High just to make it work.

When a secret doesn't inject and you think it should, the **`/secretsdebug`** slash command (or Settings → Debug → Secrets scoring report) shows the full decision: detected characters, scene type, every secret's score with reasons, and exactly why anything was skipped — plus validation warnings for common configuration problems. **Run sidecar now** forces a fresh scene read on demand.

**Narrative Consistency Monitoring** runs on the same cadence as the message scanner, using the separate Narrative Consistency LLM profile. It checks whether any character acted on knowledge they shouldn't have, whether reveal conditions have been met, or whether anything contradicts established facts. Flags are written to the notebook's Inconsistencies field — the LLM flags, you decide what to do.

### 🤝 Community Summaries
The extension detects recurring character clusters and generates analytical community summaries — portrait-style descriptions of factions, social circles, and group dynamics that surface the underlying power structures and unspoken tensions. These inform event generation and world state updates but are **never** injected into the main prompt.

Community summaries have two parts: an atmospheric overview paragraph and 3-5 specific analytical observations (max 2 sentences each) tied to actual moments or patterns from the chat.

### ⚡ Batch Scan
Starting mid-campaign? Run the batch scan. The extension reads your full chat history and generates an initial world state across all components — current day, forecast, events, world conditions, notebook fields, and community groupings. Non-compounding: it will not overwrite data you've already entered.

After batch scan completes, the message scanner transitions immediately to normal cadence — no warmup period needed.

---

## How It Works

NWST uses **four LLM connection profiles**, each suited to a different kind of task:

| Profile | Job | Recommended Model |
|---|---|---|
| **Planning LLM** | Scanner updates, world state synthesis, event generation, day-advance event review, community analysis, time skips, batch scan | Frontier model (Claude Sonnet, GPT-4o, DeepSeek V3) |
| **Day Advancement LLM** | Date generation, 7-day forecast, moon phase anchoring | Lighter model (Claude Haiku, GLM-5, Mistral Small) |
| **Narrative Consistency LLM** | Secrets violation auditing, consistency flagging | Mid-size or local model (Mistral Small 24B, Qwen 3.5 9B) |
| **Secrets Sidecar LLM** | Per-scene comprehension for the secrets scoring engine | Cheap, fast model (Mistral-Nemo, Claude Haiku, a local 8B) |

All profiles pull from **connection profiles already configured in SillyTavern**. No separate API keys. If a profile isn't configured, that feature is skipped with a one-time toast warning — it will never silently fall back to your main chat model.

### Message Scanner — Two-Phase Lifecycle

**Phase 1 — Warmup (new chat, no batch scan):**
The scanner counts messages silently until the configured minimum floor (default 10 messages). No LLM calls. When the floor is reached, it fires an initial scan to build a first world state, then transitions to Phase 2.

**Phase 2 — Normal cadence:**
Fires every N messages (default 20, configurable). The cadence counter starts fresh after the initial scan — it does not inherit the warmup count.

If you run batch scan during warmup, the scanner skips the initial scan and goes straight to Phase 2 — batch scan already did the grounding pass.

---

## Prompt Injection

**Injected on every message:**
- Current day block (date, season, weather, flora/fauna, spiritual climate if enabled)
- 7-day forecast and moon phases
- Active upcoming events (pending and in-progress only)
- Active world conditions (enabled tracks only)
- Active secret blocks (selected by relevance score — see Secrets Engine)

**Never injected:**
- Notebook fields
- Community summaries
- Secrets that don't reach the relevance threshold, or that fall outside the injection count/token caps

**Output density** (Injection Settings) controls how much text all of the above costs per message, with three modes: **Token-Budget** — lean structured labels, no prose (~120–300 tokens/msg); **Combined** — balanced short prose, the default (~300–600 tokens/msg); **Atmospheric** — full narrative prose (~600–1,400 tokens/msg). Secrets injection is unaffected by mode — it's always the instant JS lookup.

Injection placement is fully configurable: Before/After Main Prompt, Top/Bottom of Author's Note, or Inject at Depth with role selector (System / User / Assistant).

**Maximum active events** (Injection Settings, default 12) controls how many pending/in-progress events can exist at once. New generated events won't be added when this limit is reached. Detected NPC events always bypass this cap — they're facts from chat, not generated content.

---

## Data Storage

All narrative data is stored **per chat** in SillyTavern's native `chatMetadata` system. Your high-fantasy roleplay and your cyberpunk roleplay each have their own world state, events, and notebook. Opening a different chat loads that chat's data entirely — no crossover.

Global user preferences (connection profiles, scan frequency, injection settings) are stored in `extensionSettings` and shared across all chats.

Snapshots are saved at day advancement boundaries. Previous Day restores from snapshots with no API call. Snapshots are capped at a configurable maximum (default 30) to keep file sizes manageable; protected snapshots (batch scan baseline, time skip rollback points) are never pruned.

---

## UI Overview

**Five tabs**, accessible from the extension dropdown or the chat bar globe button (⊕):

- **Home** — current day journal, day navigation, time skip, 7-day forecast, moon phases, upcoming events digest, pending event approvals
- **Events** — full event horizon across all four tiers, add/edit/regen controls, and the review card queues (validity flags, timing proposals, promotion candidates)
- **World State** — condition tracks with eye toggles, community summaries
- **Notebook** — collapsible sections for core notes, mystery & continuity, secrets
- **Settings** — connection profiles, scanner settings, injection settings, secrets engine (weights, threshold, caps, sidecar cadence), setting context, calendar config & special days, batch scan, import/export, debug tools

All editable text fields support a **⛶ popout editor** for comfortable editing in a larger modal.

The **Debug** section (bottom of Settings) provides manual trigger buttons for Scan for Secrets, Scan for Communities, Scan World State, Generate Missing Anchors, the Secrets scoring report, and Run Sidecar Now — useful for testing or forcing an update outside the normal cadence.

---

## Requirements

- [SillyTavern](https://github.com/SillyTavern/SillyTavern) (1.18.0 or higher)
- At least one configured API connection profile in SillyTavern
- A second connection profile recommended for Day Advancement (lighter model)
- A third connection profile recommended for Narrative Consistency (mid-size or local model is fine)
- A fourth connection profile recommended for the Secrets Sidecar (cheap and fast — it runs frequently)

---

## Installation

**Via SillyTavern Extension Manager (recommended):**
1. Open SillyTavern → Extensions → Install Extension
2. Paste the repository URL
3. Click Install

**Manual:**
1. Download the latest release zip
2. Extract into your `SillyTavern/public/scripts/extensions/third-party/` folder
3. Reload SillyTavern

---

## First-Time Setup

1. Go to **Settings → Connection Profiles** and assign at least a Planning LLM profile
2. Fill in **Setting Context** — describe your world's geography, climate, era, and starting date. This is the single most important input for quality generation.
3. Run **Batch Scan** if you're starting mid-campaign, or start a new chat and let the warmup scanner do its first pass at message 10
4. Configure **Injection Settings** to set placement and event pool cap

---

## Compatibility Notes

- Built entirely on SillyTavern's native structures: prompt injection API, connection profile system, extension panel (`#extensions_settings2`), `chatMetadata`, and event system
- Does not require any other extensions
- Moon and season engines are functional for real-world calendar settings; fantasy calendar configurations (custom month names, non-365-day years, multiple moons) are implemented but lightly tested — tagged experimental

---

## Known Limitations

- Fantasy calendar configurations have had limited real-world testing
- Multi-moon configurations are implemented but edge cases may exist

---

## Roadmap

- [ ] UI polish pass
- [ ] Mobile UI testing

---

## Credits

Designed and directed by [ExtensionMuncher](https://github.com/ExtensionMuncher).

---

> *Built for complex, long-running narrative roleplays where world continuity matters. If your story has multiple characters, mysteries, factions, seasonal rhythms, and characters with secrets — this was made for you.*
