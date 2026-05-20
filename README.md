# Narrative World State Tracker
### A SillyTavern Extension

> **Status: Alpha** — Core features are functional and have been tested in active roleplays. Expect rough edges, especially in fantasy calendar and multi-moon configurations. Report bugs via GitHub Issues.

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

Events come from two origins:
- **Detected** — the scanner reads your chat and picks up explicit plans, arrangements, and scheduled happenings mentioned in text. These are proposed for your review and never auto-committed.
- **Generated** — the Planning LLM extrapolates plausible events from world context, setting details, current conditions, community dynamics, and character behavior

Events are further divided by type:
- **NPC Events** — character-driven (meetings, plans, routines, character behavior extrapolated from established dynamics). NPC events detected from explicit chat text bypass all pool caps — they're facts, not generated content.
- **World Events** — setting-driven, exist independently of characters (seasonal observances, political movements, cultural happenings, environmental cycles). Auto-topped up when the pool runs thin after day advancement.

**Event caps (per regen call):**
- Detected NPC events: no cap
- Generated NPC events: max 3 per tier
- World events: max 2 per tier
- Active event pool: configurable maximum (default 12, set in Injection Settings). Only pending and in-progress events count toward this cap.

All proposed events appear in the **Pending Events** section on the Home tab for approval before being committed. Undetermined events are **never** auto-regenerated — their timing is intentional.

Each event has a status: **Pending**, **In Progress**, **Resolved**, or **Missed**. Resolved and missed events are excluded from prompt injection automatically.

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
- **Injection Priority**: High / Normal / Low (see Secrets section below)

### 🔐 Secrets & Selective Injection
Secrets are injected **selectively and silently** — no LLM involvement, no API cost, just a fast JavaScript lookup before every generation.

**How injection works:**
1. Before each generation, the last 15 messages are scanned for character names
2. Those names are compared against every secret's Who Knows list
3. Secrets that match are injected into the main prompt for that generation
4. Secrets whose characters aren't present stay silent

**Injection Priority** controls when a secret is injected:
- **High** — inject whenever any Who Knows character is present in the scene
- **Normal** (default) — inject only when a Who Does NOT Know character is *also* present (the secret is at active risk of leaking)
- **Low** — never inject into the main prompt; the Narrative Consistency monitor still tracks it

**Narrative Consistency Monitoring** runs on the same cadence as the message scanner, using the Narrative Consistency LLM profile. It checks whether any character acted on knowledge they shouldn't have, whether reveal conditions have been met, or whether anything contradicts established facts. Flags are written to the notebook's Inconsistencies field — the LLM flags, you decide what to do.

### 🤝 Community Summaries
The extension detects recurring character clusters and generates analytical community summaries — portrait-style descriptions of factions, social circles, and group dynamics that surface the underlying power structures and unspoken tensions. These inform event generation and world state updates but are **never** injected into the main prompt.

Community summaries have two parts: an atmospheric overview paragraph and 3-5 specific analytical observations (max 2 sentences each) tied to actual moments or patterns from the chat.

### ⚡ Batch Scan
Starting mid-campaign? Run the batch scan. The extension reads your full chat history and generates an initial world state across all components — current day, forecast, events, world conditions, notebook fields, and community groupings. Non-compounding: it will not overwrite data you've already entered.

After batch scan completes, the message scanner transitions immediately to normal cadence — no warmup period needed.

---

## How It Works

NWST uses **three LLM connection profiles**, each suited to a different kind of task:

| Profile | Job | Recommended Model |
|---|---|---|
| **Planning LLM** | Scanner updates, world state synthesis, event generation, community analysis, time skips, batch scan | Frontier model (Claude Sonnet, GPT-4o, DeepSeek V3) |
| **Day Advancement LLM** | Date generation, 7-day forecast, moon phase anchoring | Lighter model (Claude Haiku, GLM-5, Mistral Small) |
| **Narrative Consistency LLM** | Secrets monitoring, consistency flagging | Mid-size or local model (Mistral Small 24B, Qwen 3.5 9B) |

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
- Active secret blocks (selectively, based on scene character presence)

**Never injected:**
- Notebook fields
- Community summaries
- Low-priority secrets
- Normal-priority secrets when no at-risk character is in the scene

Injection placement is fully configurable: Before/After Main Prompt, Top/Bottom of Author's Note, or Inject at Depth with role selector (System / User / Assistant).

**Maximum active events** (Injection Settings, default 12) controls how many pending/in-progress events can exist at once. New generated events won't be added when this limit is reached. Detected NPC events always bypass this cap — they're facts from chat, not generated content.

---

## Data Storage

All narrative data is stored **per chat** in SillyTavern's native `chatMetadata` system. Your Heian era roleplay and your Yakuza roleplay each have their own world state, events, and notebook. Opening a different chat loads that chat's data entirely — no crossover.

Global user preferences (connection profiles, scan frequency, injection settings) are stored in `extensionSettings` and shared across all chats.

Snapshots are saved at day advancement boundaries. Previous Day restores from snapshots with no API call. Snapshots are capped at a configurable maximum (default 30) to keep file sizes manageable; protected snapshots (batch scan baseline, time skip rollback points) are never pruned.

---

## UI Overview

**Five tabs**, accessible from the extension dropdown or the chat bar globe button (⊕):

- **Home** — current day journal, day navigation, time skip, 7-day forecast, moon phases, upcoming events digest, pending event approvals
- **Events** — full event horizon across all four tiers, add/edit/regen controls
- **World State** — condition tracks with eye toggles, community summaries
- **Notebook** — collapsible sections for core notes, mystery & continuity, secrets
- **Settings** — connection profiles, scanner settings, injection settings, setting context, planner prompt, batch scan, import/export, debug tools

All editable text fields support a **⛶ popout editor** for comfortable editing in a larger modal.

The **Debug** section (bottom of Settings) provides manual trigger buttons for Scan for Secrets, Scan for Communities, and Scan World State — useful for testing or forcing an update outside the normal cadence.

---

## Requirements

- [SillyTavern](https://github.com/SillyTavern/SillyTavern) (1.12.0 or higher)
- At least one configured API connection profile in SillyTavern
- A second connection profile recommended for Day Advancement (lighter model)
- A third connection profile recommended for Narrative Consistency (mid-size or local model is fine)

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

- Output density control (Direct / Atmospheric / Token Budget modes) is planned but not yet built — all injection currently uses the atmospheric style
- Fantasy calendar configurations have had limited real-world testing
- Multi-moon configurations are implemented but edge cases may exist

---

## Roadmap

- [ ] Output density modes (Direct / Atmospheric / Token Budget)
- [ ] UI polish pass
- [ ] Mobile UI testing
- [ ] Fantasy calendar stress testing
- [ ] Optional Kaldigo integration hook

---


## Credits

Designed and directed by [ExtensionMuncher](https://github.com/ExtensionMuncher).

---

> *Built for complex, long-running narrative roleplays where world continuity matters. If your story has multiple characters, mysteries, factions, seasonal rhythms, and characters with secrets — this was made for you.*
