# NWST Function Implementation Plan

## Current State

All UI, data, settings, LLM, and injection modules are structurally complete. The LLM modules (scanner, dayAdvancement, currentDaySynth, eventGen, timeskip, batchScan, narrativeConsistency) are fully written as standalone functions. **The gap is the integration layer** — nothing calls them.

## Execution Order

Each phase is self-contained. Build order matters because later phases depend on earlier ones being functional.

---

### Phase 1: Wire LLM modules to Home tab buttons

**Files to modify:** [`ui/home.js`](ui/home.js)

**Changes:**
- Import `advanceToNextDay()`, `restorePreviousDay()` from [`llm/dayAdvancement.js`](llm/dayAdvancement.js)
- Import `executeTimeSkip()` from [`llm/timeskip.js`](llm/timeskip.js)
- Import `synthesizeCurrentDay()` from [`llm/currentDaySynth.js`](llm/currentDaySynth.js)
- Replace placeholder toasts in [`wireHomeEvents()`](ui/home.js:141):
  - *Next Day* button → calls `advanceToNextDay()`
  - *Prev Day* button → calls `restorePreviousDay()`
  - *Time Skip Jump* button → calls `executeTimeSkip(skipDescription)`
  - *Forecast Regen* button → calls `synthesizeCurrentDay()`
- Wire `showLoading(show)` for forecast/moon strips during day advancement
- Wire `showTimeskipLoading(show)` during time skip
- Refresh UI after each operation completes

---

### Phase 2: Wire LLM modules to Events tab buttons

**Files to modify:** [`ui/events.js`](ui/events.js)

**Changes:**
- Import `regenerateTierEvents()` and `regenerateAllEvents()` from [`llm/eventGen.js`](llm/eventGen.js)
- Replace placeholder toasts in [`wireEventItemEvents()`](ui/events.js:133):
  - *Regenerate All* button → calls `regenerateAllEvents()`, then `refreshEventsUI()`
  - *Tier Regen* buttons → calls `regenerateTierEvents(tier)`, then `refreshEventsUI()`

---

### Phase 3: Wire Batch scan to Settings tab

**Files to modify:** [`ui/settings.js`](ui/settings.js)

**Changes:**
- Import `runBatchScan()` from [`llm/batchScan.js`](llm/batchScan.js)
- Replace placeholder toast in [`wireSettingsEvents()`](ui/settings.js:285): 
  - *Run batch scan* button → calls `runBatchScan()`
- Wire `showBatchScanLoading(show)` to show spinner + disable button during scan

---

### Phase 4: Start background scanner + wire narrative consistency

**Files to modify:** [`llm/scanner.js`](llm/scanner.js), [`index.js`](index.js)

**Changes to** [`index.js`](index.js):
- Import `startScanner()`, `stopScanner()`, `restartScanner()` from [`llm/scanner.js`](llm/scanner.js)
- In `init()`, call `startScanner()` after panel registration
- In [`updateStatusLabel()`](index.js:303) and [`updatePauseButton()`](index.js:324), call `stopScanner()`/`startScanner()` based on pause state
- Register `MESSAGE_SENT`/`MESSAGE_RECEIVED` event listeners that call the scanner's message count check

**Changes to** [`llm/scanner.js`](llm/scanner.js):
- In [`runScan()`](llm/scanner.js:133) (the main Planning LLM scan), add a call to `runConsistencyCheck()` from [`llm/narrativeConsistency.js`](llm/narrativeConsistency.js) after the main scan finishes
- Import `runConsistencyCheck`
- The consistency check will automatically respect pause/disable because it's called from within the scanner's `runScan()` which is gated by [`checkAndScan()`](llm/scanner.js:116)

---

### Phase 5: Connect prompt injection + selective secret injection to ST

**Files to modify:** [`manifest.json`](manifest.json), [`inject/promptInjector.js`](inject/promptInjector.js), [`index.js`](index.js)

**Changes to** [`manifest.json`](manifest.json):
- Add `"generate_interceptor": "NWSInjectionInterceptor"` registration

**Changes to** [`inject/promptInjector.js`](inject/promptInjector.js):
- Rewrite [`registerPromptInjection()`](inject/promptInjector.js:197) to actually register with ST's injection system:
  - Use `SillyTavern.getContext().extension_prompt_types` and `extension_prompt_roles`
  - Register a dynamic prompt that calls `buildInjectionBlock()` on each generation
- Wire `getInjectionConfig()` to dynamically return config based on current settings

**Changes to** [`index.js`](index.js):
- In `init()`, call `registerPromptInjection()` after scanner start
- Register the generate_interceptor hook

---

### Phase 6: Add pause/disable gating to selective secret injection

**Files to modify:** [`llm/narrativeConsistency.js`](llm/narrativeConsistency.js)

**Changes:**
- In [`getSelectiveSecretInjection()`](llm/narrativeConsistency.js:82), add two early-return checks at the top:
  1. `if (!isEnabled()) return '';` — if extension disabled, suppress ALL secret injection
  2. `if (isPaused()) return '';` — if scanning is paused, suppress secret injection

This ensures:
- **Extension disabled** → no secret injection, no scanner, no prompt injection
- **Extension enabled, scanning paused** → no scanner, no consistency check, no secret injection
- **Extension enabled, scanning active** → everything runs normally

The `isEnabled()`/`isPaused()` functions are already exported from [`settings.js`](settings.js) and available to import.

---

### Phase 7: Add loading indicators across all processes

**Files to modify:** [`llm/dayAdvancement.js`](llm/dayAdvancement.js), [`llm/timeskip.js`](llm/timeskip.js), [`llm/batchScan.js`](llm/batchScan.js), [`llm/eventGen.js`](llm/eventGen.js)

The loading functions already exist:
- [`showLoading(show)`](llm/dayAdvancement.js:340) — toggles `nwst-loading` class on forecast/moon strips
- [`showTimeskipLoading(show)`](llm/timeskip.js:346) — toggles `nwst-loading` on home pane + disables Jump button
- [`showBatchScanLoading(show)`](llm/batchScan.js:380) — shows spinner + disables batch scan button

These are called internally by each LLM module (inside their functions). The CSS class `nwst-loading` may need a spinner animation added in [`style.css`](style.css) — verify and add if missing.

---

### Phase 8: Add popout (⛶) buttons to editable fields

**Files to modify:** [`ui/home.js`](ui/home.js), [`ui/events.js`](ui/events.js), [`ui/worldState.js`](ui/worldState.js)

Per the kickoff spec (UI Rules — Editable Fields — Popout Rule):
- Each textarea/input that has Save/Cancel should also have a ⛶ popout button
- Clicking ⛶ opens a larger modal editor using ST's `callGenericPopup`
- Notebook bullets use a different pattern: ⛶ appears only while the bullet span is focused

**Specific locations:**
- Current Day edit footer (Save / Cancel / ⛶)
- Each event body edit row (Save / Delete / ⛶)
- Each world condition edit footer (Save / Cancel / ⛶)
- Each community summary edit footer (Save / Cancel / ⛶)
- Notebook bullet popout (appears on focus, disappears on blur)

---

### Phase 9: Clean up index.js storage comments

**Files to modify:** [`index.js`](index.js)

**Changes:**
- Line 16: Change *"Per-chat narrative data stored in chatMetadata"* to *"Per-chat narrative data stored in extensionSettings.nwst.chatData"*
- The `getChatData`/`setChatData` functions (lines 191-205) that use chatMetadata are dead code — remove them or add a clear comment they're unused

---

## Pause/Disable Behavior Matrix

| State | Scanner | Consistency Check | Selective Secret Injection | Prompt Injection |
|-------|---------|-------------------|---------------------------|------------------|
| **Enabled + Active** | Runs | Runs on cadence | Injects on every message | Injects on every message |
| **Enabled + Paused** | Stopped | Stopped | Suppressed | Injects world state only (no secrets) |
| **Disabled** | Stopped | Stopped | Suppressed | Suppressed entirely |

---

## Dependency Map

```
Phase 1 (Home tab LLM wiring)
  └── Requires: LLM modules already written ✅
  └── Requires: UI modules already have button IDs ✅

Phase 2 (Events tab LLM wiring)
  └── Requires: LLM modules already written ✅

Phase 3 (Batch scan wiring)
  └── Requires: Batch scan module already written ✅

Phase 4 (Scanner start + consistency wiring)
  └── Requires: Phase 1 completed (scanner events use same pattern)
  └── Note: Scanner can run independently of UI

Phase 5 (Prompt injection)
  └── Requires: All LLM modules functional (so injection has data to inject)
  └── Note: Should verify injection data is populated before connecting

Phase 6 (Pause gating for secret injection)
  └── Requires: Phase 5 completed (injection system connected)

Phase 7 (Loading indicators)
  └── Can be done alongside Phases 1-5 (they share the same files)

Phase 8 (Popout buttons)
  └── Independent of other phases — can be done anytime

Phase 9 (Comment cleanup)
  └── Independent — can be done anytime
```
