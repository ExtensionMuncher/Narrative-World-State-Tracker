/* eslint-disable */
// =============================================================================
// NWST Weather Profile Analyzer — llm/weatherProfile.js
// =============================================================================
// One-shot semantic helper. Reads the active Setting Context and creates a
// reusable per-chat Weather Profile. It does NOT roll weather.
// =============================================================================

import { getChatId, nwstToast } from '../utils.js';
import { getSettingContext, getSettingContextProfiles } from '../data/worldState.js';
import { makeDefaultWeatherProfile, upsertWeatherProfile } from '../data/severeWeather.js';
import { dlog } from '../lib/debug.js';
import { resolveProfile, generateWithProfile } from './connections.js';

const SYSTEM_PROMPT = `You create a concise climate/terrain profile for a narrative weather simulator.
Read the supplied Setting Context and return JSON ONLY:
{
  "name": "short reusable region/profile name",
  "climate": ["tags"],
  "terrain": ["tags"],
  "characteristics": ["short climate traits"],
  "notes": "1-2 sentence weather-relevant summary"
}

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
    profile.notes = String(parsed.notes || '').trim();

    await upsertWeatherProfile(chatId, profile, { activate });
    if (!silent) nwstToast(`Weather Profile created: ${profile.name}`, 'success');
    return profile;
}
