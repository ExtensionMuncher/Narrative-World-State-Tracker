/* eslint-disable */
// =============================================================================
// NWST Weather Profile Analyzer — llm/weatherProfile.js
// =============================================================================
// One-shot semantic helper. Reads the active Setting Context and creates a
// reusable per-chat Weather Profile. It does NOT roll weather.
// =============================================================================

import { getChatId, nwstToast } from '../utils.js';
import { getSettingContext, getSettingContextProfiles } from '../data/worldState.js';
import { makeDefaultWeatherProfile, upsertWeatherProfile, getWeatherProfilesState, saveWeatherProfilesState, WEATHER_EVENT_DEFS, REGIONAL_HAZARD_LEVELS, normalizeRegionalHazards } from '../data/severeWeather.js';
import { dlog } from '../lib/debug.js';
import { resolveProfile, generateWithProfile } from './connections.js';

const HAZARD_IDS = Object.keys(WEATHER_EVENT_DEFS);
const HAZARD_LEVEL_KEYS = Object.keys(REGIONAL_HAZARD_LEVELS);
const HAZARD_GUIDE = HAZARD_IDS.map(id => `${id} (${WEATHER_EVENT_DEFS[id].label})`).join(', ');

const SYSTEM_PROMPT = `You create a concise climate/terrain profile for a narrative weather simulator.
Read the supplied Setting Context and return JSON ONLY:
{
  "name": "short reusable region/profile name",
  "climate": ["tags"],
  "terrain": ["tags"],
  "characteristics": ["short climate traits"],
  "regionalHazards": {
    "severe_thunderstorm": "neutral"
  },
  "notes": "1-2 sentence weather-relevant summary"
}

Regional hazards are an additional location-specific likelihood modifier layered on top of climate, terrain, season, and overall frequency. Use exactly one of: ${HAZARD_LEVEL_KEYS.join(', ')}.
- very_low: the hazard is exceptionally unlikely for this region
- low: below-normal regional likelihood
- neutral: no special regional tendency; use this whenever evidence is absent or mixed
- elevated: clearly more likely than an otherwise similar region
- high: defining or recurrent regional hazard
Return every tracked hazard key. Tracked hazards: ${HAZARD_GUIDE}.
Do not force a non-neutral result. Neutral is the correct middle-ground when the Setting Context does not establish a special tendency.

Use only weather-relevant information. Do not summarize plot, characters, relationships, factions, or story events.
Prefer tags from these vocabularies where they fit:
Climate: temperate, humid, subtropical, tropical, continental, maritime, subarctic, alpine, arid, semiarid.
Terrain: urban, suburban, rural, coastal, island, inland, mountainous, foothills, high_elevation, valley, plains, forested, desert, steppe, river_adjacent, lowland, exposed, snowbelt.
You may use additional concise tags only when necessary for a fantasy/abstract world.
Characteristics should capture useful facts such as harsh winters, humid summers, rainy season, monsoon influence, persistent dry season, perpetual night, supernatural atmosphere, large daily temperature swings.
Do not invent precise geography the Setting Context does not support.`;

function parseJson(text) {
    if (!text) return null;
    let raw = String(text).trim();
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) raw = fence[1].trim();
    const obj = raw.match(/\{[\s\S]*\}/);
    if (obj) raw = obj[0];
    try { return JSON.parse(raw); } catch { return null; }
}
function cleanList(v) {
    return Array.isArray(v) ? [...new Set(v.map(x => String(x || '').trim()).filter(Boolean))].slice(0, 12) : [];
}

export async function analyzeSettingContextToWeatherProfile(chatId = getChatId(), { activate = true, silent = false } = {}) {
    if (!chatId) throw new Error('No active chat detected.');
    const context = getSettingContext(chatId);
    if (!String(context || '').trim()) throw new Error('The active Setting Context is empty.');

    const llmProfile = resolveProfile('planningLLM');
    if (!llmProfile) throw new Error('No Planning LLM connection profile configured.');

    const settingLib = getSettingContextProfiles(chatId);
    const activeSetting = settingLib.profiles.find(p => p.id === settingLib.activeProfileId);
    const hint = activeSetting?.name ? `Active Setting Context profile name: ${activeSetting.name}\n` : '';
    const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `${hint}SETTING CONTEXT:\n${context}` }
    ];
    const response = await generateWithProfile(llmProfile, messages, { maxTokens: 700 });
    if (getChatId() !== chatId) {
        dlog('[NWST WeatherProfile] Active chat changed during analysis; discarding stale profile result.');
        return null;
    }
    const parsed = parseJson(response);
    if (!parsed) throw new Error('Weather Profile analyzer returned invalid JSON.');

    const profile = makeDefaultWeatherProfile(String(parsed.name || activeSetting?.name || 'Generated Weather').trim());
    profile.climate = cleanList(parsed.climate);
    profile.terrain = cleanList(parsed.terrain);
    profile.characteristics = cleanList(parsed.characteristics);
    profile.regionalHazards = normalizeRegionalHazards(parsed.regionalHazards);
    profile.regionalHazardsSource = 'setting_context_analysis';
    profile.regionalHazardsUpdatedAt = Date.now();
    profile.notes = String(parsed.notes || '').trim();

    await upsertWeatherProfile(chatId, profile, { activate });
    if (!silent) nwstToast(`Weather Profile created: ${profile.name}`, 'success');
    return profile;
}

const HAZARD_BACKFILL_SYSTEM_PROMPT = `You classify location-specific severe-weather likelihoods for existing narrative Weather Profiles.
Return JSON ONLY:
{
  "profiles": [
    {
      "id": "exact profile id",
      "regionalHazards": {
        "severe_thunderstorm": "neutral"
      }
    }
  ]
}

Use exactly one level per tracked hazard: ${HAZARD_LEVEL_KEYS.join(', ')}.
- very_low: exceptionally unlikely for the described region
- low: below-normal regional likelihood
- neutral: no special tendency, insufficient evidence, or mixed/ordinary likelihood
- elevated: clearly more likely than an otherwise similar region
- high: defining or recurrent regional hazard

Return every tracked hazard key for every supplied profile. Tracked hazards: ${HAZARD_GUIDE}.
Base the classification on each profile's own climate, terrain, characteristics, and notes. The active Setting Context is optional support only for the profile explicitly marked active; do not use it to rewrite or contaminate other stored profiles. Do not invent precise geography. Neutral is a valid and preferred answer when the evidence does not justify a directional adjustment.`;

export async function analyzeRegionalHazardsForProfiles(chatId = getChatId(), { profileIds = null, silent = false } = {}) {
    if (!chatId) throw new Error('No active chat detected.');
    const state = getWeatherProfilesState(chatId);
    const requested = Array.isArray(profileIds) && profileIds.length
        ? new Set(profileIds.map(String))
        : null;
    const profiles = state.profiles.filter(p => !requested || requested.has(String(p.id)));
    if (!profiles.length) throw new Error('No Weather Profiles are available to analyze.');

    const llmProfile = resolveProfile('planningLLM');
    if (!llmProfile) throw new Error('No Planning LLM connection profile configured.');

    const context = getSettingContext(chatId);
    const payload = {
        activeProfileId: state.activeProfileId || null,
        activeSettingContext: String(context || '').trim() || null,
        profiles: profiles.map(p => ({
            id: p.id,
            name: p.name,
            active: p.id === state.activeProfileId,
            climate: p.climate || [],
            terrain: p.terrain || [],
            characteristics: p.characteristics || [],
            notes: p.notes || ''
        }))
    };
    const response = await generateWithProfile(llmProfile, [
        { role: 'system', content: HAZARD_BACKFILL_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(payload, null, 2) }
    ], { maxTokens: Math.min(2600, 700 + profiles.length * 320) });

    if (getChatId() !== chatId) {
        dlog('[NWST WeatherProfile] Active chat changed during hazard analysis; discarding stale result.');
        return [];
    }
    const parsed = parseJson(response);
    const rows = Array.isArray(parsed?.profiles) ? parsed.profiles : [];
    const byId = new Map(rows.map(row => [String(row?.id || ''), row]));
    const updatedIds = [];
    const now = Date.now();
    for (const profile of state.profiles) {
        if (!profiles.some(p => p.id === profile.id)) continue;
        const row = byId.get(String(profile.id));
        if (!row || !row.regionalHazards || typeof row.regionalHazards !== 'object') continue;
        profile.regionalHazards = normalizeRegionalHazards(row.regionalHazards);
        profile.regionalHazardsSource = 'llm_analysis';
        profile.regionalHazardsUpdatedAt = now;
        updatedIds.push(String(profile.id));
    }
    if (!updatedIds.length) throw new Error('Regional Hazards analyzer returned no usable profile classifications.');
    await saveWeatherProfilesState(chatId, state);
    if (!silent) nwstToast(`Regional Hazards updated for ${updatedIds.length} Weather Profile${updatedIds.length === 1 ? '' : 's'}.`, 'success');
    return state.profiles.filter(p => updatedIds.includes(String(p.id)));
}

