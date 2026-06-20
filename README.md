# Narrative World State Tracker
### A SillyTavern Extension

> **Status: Alpha** — Core features are functional and being tested in active roleplays. Expect rough edges, especially in fantasy calendar and multi-moon configurations. Report bugs via GitHub Issues.

No additional features planned at this time. Strictly for bug fixes and refinement.

---

# Secrets Engine (v2) — Technical & User Documentation
### ✅ Complete Overhaul Implemented 6/20/26

The Secrets Engine is a prose-based hidden-state system. It tracks who knows what, who must not know, and what narrative pressure is active — then injects the most relevant secrets into the main prompt as narrator guidance. It is built for multi-character, cutaway-heavy roleplay where dramatic irony lives in scenes the player character isn't even in.

This document covers both how it works (for understanding and debugging) and how to use it (configuration and tuning).

---

## Why It Exists

The original secrets system used a presence gate: a secret injected only if a specific knowing character was in the scene, and for Normal-priority secrets, only if an at-risk character was also present. This is structurally blind to cutaway scenes — when characters scheme offscreen, away from the player, the "at-risk party present" condition fails exactly when the secret is most live.

The v2 engine replaces the gate with relevance scoring. A secret accumulates points from many independent signals. No single missing signal silences it. A surveillance cutaway involving a secret's holder scores high on its own merits, even with the at-risk party completely absent. This matches how dramatic irony actually works in cutaway-heavy writing.

---

## Architecture — Four Layers

The engine is built in four layers, each with one job, none reaching into another's internals.

### Layer 1 — Alias Registry (`data/aliasRegistry.js`)

Resolves the many ways an entity is named down to a single canonical ID. "Full Title Variant," "Epithet Variant," and "Character A" all resolve to `character_a`.

Two sources, merged:
- **Auto-built** — every name in your secrets' Who Knows / Who Does Not Know lists and your community members becomes a canonical entity automatically. No setup required.
- **Manual** — alias groups you define in the Alias Manager. These let you collapse variants the auto-builder can't know are the same person, and they take precedence.

The registry never reads the character card name or message metadata. Detection happens purely by scanning prose. Diacritics are stripped internally for matching (so accented and unaccented spellings still match) but preserved in display names for the UI. Typographic apostrophes and all punctuation are normalized, so "Character A's" still matches at a word boundary.

### Layer 2 — Sidecar Scene Analyzer (`llm/secretsSidecar.js`)

A lightweight LLM that reads recent prose and returns structured scene comprehension. It runs on its own cadence using a dedicated, cheap connection profile.

It exists to fill the gap pure JavaScript can't cover: resolving pronouns ("he watched for six paragraphs" → which character), recognizing scene *type* (cutaway vs player-present vs surveillance vs faction), and detecting active narrative *pressure*. These are semantic judgments only an LLM can make.

It returns:
```
{
  charactersPresent: ["character_a", "character_b"],   // canonical IDs, pronouns resolved
  sceneType: "npc_cutaway",                   // player_present | npc_cutaway | surveillance | faction | mixed
  activePressures: ["surveillance"],          // free-text pressure tags
  sceneSummary: "Character B and Character C observe..."// one-line scene summary
}
```

It reads only prose (`msg.mes`), never the card name. It does **not** decide injection — it only produces the scene picture that the scoring engine consumes. Its output is cached in `chatMetadata` and reused between runs.

### Layer 3 — Scoring Engine (`llm/secretsScoring.js`)

Pure JavaScript, zero API calls. Consumes the cached sidecar read plus a fresh prose scan, scores every secret against the scene, and ranks them. The injection selector then fills from the top until either the token budget or the max-count cap is hit, whichever comes first.

Between sidecar runs the scene comprehension can be slightly stale (up to one cadence window). A `sidecarFresh` flag tracks this; even with no sidecar read at all, the pure-JS prose scan still provides character presence, so the engine degrades gracefully rather than failing.

### Layer 4 — Injection Format (`llm/secretsInjection.js`)

Formats the winning secrets as narrator guidance with explicit knowledge boundaries:

```
[SECRET CONTINUITY — Narrator Guidance Only]
Secret: Character A is under 24/7 surveillance by Faction X operatives.
Known by: Character B, Character C, Monitoring Cell.
Unknown to: Character A, Character D.
Use: Maintain dramatic irony and the pressure around this secret. Do not let
     unaware characters learn this unless the scene naturally reveals evidence.
Current relevance: this is a scene where the secret-holder is active away from
     the unaware party.
```

---

## Scoring Signals

Each secret accumulates points from these signals. All weights are editable in Settings → Secrets Engine.

| Signal | Default | Fires when |
|---|---|---|
| Knower present | +30 | a character who knows the secret is in the scene |
| Unaware party present | +20 | a character who must NOT know is in the scene |
| Both present | +40 | a knower and an unaware party share the scene (irony live) |
| NPC cutaway w/ holder | +35 | a cutaway/surveillance/faction scene involves the secret-holder |
| Group/faction match | +25 | a group tied to the secret is present |
| Anchor/concept match | +20 | the scene references the secret's subject matter |
| Reveal condition match | +35 | the prose approaches the secret's reveal conditions |
| Pressure match | +25 | the secret's pressure/risk is active in the scene |
| Continuity risk | +45 | omitting a relevant Critical secret risks a continuity break |
| Priority: Low | −15 | secret is Low priority (pushes it down) |
| Priority: Normal | 0 | secret is Normal priority |
| Priority: High | +20 | secret is High priority |
| Priority: Critical | +50 | secret is Critical priority |

A secret must reach the **injection threshold** (default 30) to be eligible. "Both present" and the cutaway bonus are deliberately the strongest non-priority signals — they correspond to the moments where hidden knowledge matters most.

### How priority changed

Priority no longer gates whether a secret functions. It only modifies urgency. A Normal-priority secret works perfectly in cutaway scenes because the cutaway and pressure signals carry it. You no longer need to set everything to High to make secrets fire — set priority by how *urgent* a secret is, not by whether you want it to work at all.

---

## Configuration

All settings live in **Settings → Secrets Engine**, except the connection profile which is under **Settings → Connection Profiles**.

**Secrets Sidecar profile** — assign a cheap, fast model (Mistral-Nemo, Haiku, a local 8B). This is NOT the heavy Narrative Consistency model. The sidecar runs frequently, so cost matters.

**Max secrets injected** (default 4) — hard cap on how many secrets inject at once, regardless of token budget. The dual limits work together: token budget catches a few long secrets, count cap catches many short ones. Whichever is hit first wins.

**Sidecar cadence** (default 10 messages) — how often the scene analyzer runs. Lower means fresher reads and more API calls. 10 suits a typical scene length.

**Injection threshold** (default 30) — the minimum score for eligibility. Raise it to inject fewer, more-certain secrets; lower it to inject more liberally.

**Scoring weights** — all 13 weights are editable number inputs. Tune them to your style, then reset to defaults if you overshoot.

**Token budget** (default 600, in Injection Settings) — the older size cap, still respected alongside the count cap.

---

## Debugging

The scoring engine makes nuanced decisions you can't see in normal play. Two tools expose them:

**`/secretsdebug`** (slash command) or **Settings → Debug → Secrets scoring report** — shows the full decision: detected characters, scene type, active pressures, whether the sidecar read is fresh, every secret's score with the specific reasons behind it, and for each secret whether it injected or was skipped and exactly why (below threshold / max count reached / would exceed budget).

**Settings → Debug → Run sidecar now** — forces a sidecar analysis on demand so you can immediately inspect a fresh scene read rather than waiting for the cadence.

When a secret isn't injecting and you expect it to, run the report. It will tell you whether the issue is a low score, a missing knower in the registry, a stale sidecar read, or a cap being hit.

### Validation warnings

The report flags common configuration problems: a secret with an empty Who Knows list (can't trigger on knower presence), an empty Who Does Not Know on a knowledge-boundary secret (no irony to track), a generic title (weak anchor matching), a knower name that doesn't resolve to any known entity (check spelling or add an alias), and a secret with no pressure, reveal conditions, or anchors (only presence signals will fire for it).

---

## Connection Profiles Summary

The extension now uses four connection profiles:

| Profile | Job | Model class |
|---|---|---|
| Planning LLM | World state, events, communities, time skips | Frontier |
| Day Advancement LLM | Date, forecast, moon | Light |
| Narrative Consistency LLM | Secrets violation auditing | Mid-size / local |
| Secrets Sidecar LLM | Per-scene comprehension for the scoring engine | Cheap / fast |

The sidecar and the consistency check are deliberately separate profiles. The sidecar runs frequently and must be cheap; the consistency check runs less often and can be heavier. Do not point them at the same expensive model.

---

## Migration

Existing secrets load unchanged. The v2 fields (`triggerAnchors`, priority levels beyond High/Normal/Low) are optional and inferred where missing. Anchors are auto-derived from each secret's pressure/risk, reveal conditions, and evidence text, so older secrets gain relevance matching without a manual rebuild. No data is wiped or rewritten on upgrade.

---

## Known Limitations

- The sidecar's quality depends on the model assigned to it. A very cheap model may misjudge scene type or miss pronoun resolution. If scene detection feels off, try a slightly stronger sidecar model before adjusting weights.
- Scoring weights ship as reasonable defaults, not tuned values. Expect to adjust them over a few sessions to match your style.
- Between sidecar runs, scene type and pressures can lag by up to one cadence window. For fast cutaway sequences this may briefly affect scoring until the next sidecar run catches up.
- This is a power-user system. For simple, single-character, player-present roleplay it is more than necessary; its value is specific to multi-character, cutaway-heavy storytelling.
