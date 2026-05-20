# Narrative World State Tracker
### A SillyTavern Extension

> **Status: In Development** — This extension is currently being built. This README reflects the planned feature set and design. Not yet available for installation.

---

## What Is This?

Narrative World State Tracker (NWST) is a SillyTavern extension that maintains a **living world state** for ongoing roleplays. Instead of manually tracking what day it is, what the weather looks like, what events are coming up, or what political tensions are simmering in the background, NWST handles all of it automatically — and injects the relevant context into your main prompt so your AI always knows what world it's writing in.

It runs quietly in the background on a configurable message cadence, updating as your story evolves. Everything it generates is editable. Nothing is permanent until you say so.

---

## Features

### 🗓 Day & Date Tracking
- Tracks the current in-game date with a rich display (supports real-world and fantasy calendar formats)
- Prev/Next Day navigation with full state snapshots — going back to a previous day restores exactly what was there, no data loss
- **Time Skip** — enter a natural language description ("Three weeks later, end of harvest season") and the extension performs a full narrative overhaul across all components automatically
- Manual date editing for typo corrections — does not trigger API calls

### 🌤 Weather & Moon Phases
- 7-day forecast with weather icons, descriptions, hi/lo temperatures in both °F and °C, and precipitation chance
- 7-day moon phase strip alongside the forecast
- Regenerate the forecast at any time
- Climate-aware generation — define your world's geography and climate in Settings so the forecast stays appropriate to your setting (feudal Japan, fantasy desert kingdom, modern city, etc.)

### 📋 Event Horizon
Four event tiers — **Immediate**, **This Week**, **This Month**, and **Undetermined** — each with its own regeneration control.

Events come from two sources:
- **Detected** — the extension reads your chat and picks up explicit plans, arrangements, and scheduled happenings mentioned in text
- **Generated** — the planning LLM extrapolates plausible events from your world context, setting details, and current conditions

Events are further divided into:
- **NPC Events** — character-driven, orbit the player (meetings, hangouts, plans made between characters, birthdays)
- **World Events** — setting-driven, exist independently of player involvement (seasonal observances, political movements, cultural happenings, environmental cycles)

All proposed events require your approval before being committed. Undetermined events are **never** auto-regenerated — their timing is intentional.

Each event has a status: **Pending**, **In Progress**, **Resolved**, or **Missed**. Resolved and missed events are automatically excluded from prompt injection.

### 🌍 World State Conditions
Four condition tracks — **Political**, **Social**, **Spiritual/Supernatural**, and **Environmental** — each individually toggleable. Toggle a condition off and the extension stops tracking it, stops spending tokens on it, and stops injecting it. Useful for slice-of-life settings where political tracking would only poison the tone.

The Spiritual/Supernatural condition also controls whether a **Spiritual Climate** field appears in the current day block.

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

### 🤝 Community Summaries
The extension detects recurring character clusters and generates community summaries — macro-level context about factions, social circles, and group dynamics. These inform event generation and world state updates but are never injected into the main prompt.

### 🔍 Narrative Consistency Monitoring
A dedicated lightweight LLM profile monitors secrets on the same cadence as the message scanner. It checks whether any character acted on knowledge they shouldn't have, whether reveal conditions have been met, and whether anything feels inconsistent with established facts. Flags are written to a **Consistency Flags** field in the notebook for your review — the LLM flags, you decide.

Secrets are injected **selectively**: only when a character from the "Who Knows" list is detected as present in the current scene. Secrets whose characters aren't in the scene stay silent.

### ⚡ Batch Scan
Install mid-campaign? Run the batch scan. The extension reads your full chat history and generates an initial world state across all components — current day, forecast, events, world conditions, notebook fields, and community groupings. Non-compounding: it will not overwrite data you've already entered.

---

## How It Works

NWST uses **three LLM connection profiles**, each suited to a different kind of task:

| Profile | Job | Recommended Tier |
|---|---|---|
| **Planning LLM** | World state synthesis, event generation, time skips, notebook, batch scan | Frontier model (Claude, GPT-4o, DeepSeek) |
| **Day Advancement LLM** | Date, forecast, moon phase generation | Lighter model (Haiku, GLM-5, Mistral Small) |
| **Narrative Consistency LLM** | Secrets monitoring, consistency flagging, selective secret injection | Capable mid-size model (Mistral Small 24B, Qwen 3.5 9B, or equivalent — local model supported) |

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

## Data Storage

All data is stored **per chat**. Your Heian era roleplay has its own world state, events, and notebook. Your Yakuza roleplay has its own. Opening a different chat loads that chat's data entirely. There is no crossover.

Per-message snapshots are saved at day advancement boundaries, enabling Previous Day to restore exact prior state and chat branches to initialize from the correct historical snapshot.

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
