/* eslint-disable */
// =============================================================================
// NWST Severe Weather — data/severeWeather.js
// =============================================================================
// Per-chat saved weather profiles + deterministic severe-weather generator.
// The RNG decides IF/WHAT/WHEN/HOW LONG. The forecast LLM only renders the
// already-decided system into atmospheric 7-day forecast prose.
// =============================================================================

import { getChatData, setChatData } from './storage.js';
import { getCurrentDay } from './worldState.js';

export const WEATHER_EVENT_DEFS = {
    severe_thunderstorm: {
        label: 'Severe Thunderstorm', icon: '🌩️',
        durationHours: [1, 18], recoveryDays: [0, 1],
        base: 18,
        seasons: { spring: 1.35, summer: 1.6, autumn: 0.75, winter: 0.12 },
        climate: { humid: 1.35, tropical: 1.5, subtropical: 1.35, temperate: 1.0, continental: 1.05, arid: 0.45, subarctic: 0.25, alpine: 0.55 },
        terrain: { plains: 1.2, foothills: 1.25, mountainous: 1.1, valley: 1.1, urban: 1.05, coastal: 1.0, forested: 0.95 },
        effects: ['torrential rain', 'lightning', 'strong gusts', 'possible hail', 'localized flooding']
    },
    torrential_rain: {
        label: 'Torrential Rain', icon: '🌧️', durationHours: [3, 120], recoveryDays: [1, 3], base: 17,
        seasons: { spring: 0.85, summer: 1.35, autumn: 1.35, winter: 0.45 },
        climate: { humid: 1.4, tropical: 1.55, subtropical: 1.4, temperate: 0.9, maritime: 1.2, arid: 0.18 },
        terrain: { coastal: 1.2, mountainous: 1.25, valley: 1.2, river_adjacent: 1.25, forested: 1.05 },
        effects: ['flash flooding', 'river swelling', 'low visibility', 'landslide risk in steep terrain']
    },
    prolonged_heavy_rain: {
        label: 'Prolonged Heavy Rain', icon: '🌧️', durationHours: [24, 240], recoveryDays: [1, 4], base: 11,
        seasons: { spring: 0.85, summer: 1.2, autumn: 1.35, winter: 0.55 },
        climate: { humid: 1.4, tropical: 1.45, subtropical: 1.35, maritime: 1.25, temperate: 0.9, arid: 0.15 },
        terrain: { coastal: 1.15, mountainous: 1.3, valley: 1.2, river_adjacent: 1.3, forested: 1.05 },
        effects: ['saturated ground', 'flooding', 'landslide risk', 'persistent fog or mist', 'travel disruption']
    },
    windstorm: {
        label: 'Windstorm', icon: '💨', durationHours: [4, 72], recoveryDays: [0, 2], base: 11,
        seasons: { spring: 1.1, summer: 0.55, autumn: 1.35, winter: 1.3 },
        climate: { maritime: 1.2, temperate: 1.0, continental: 1.05, arid: 1.0, subarctic: 1.1 },
        terrain: { coastal: 1.3, mountainous: 1.3, high_elevation: 1.35, plains: 1.2, exposed: 1.35, forested: 0.9 },
        effects: ['falling branches', 'blowing debris', 'travel difficulty', 'power disruption in modern settings']
    },
    tropical_cyclone: {
        label: 'Tropical Cyclone / Typhoon', icon: '🌀', durationHours: [12, 96], recoveryDays: [1, 4], base: 9,
        seasons: { spring: 0.12, summer: 1.25, autumn: 1.6, winter: 0 },
        climate: { tropical: 1.8, subtropical: 1.55, humid: 1.15, maritime: 1.4, temperate: 0.35, continental: 0.03, subarctic: 0 },
        terrain: { coastal: 1.7, island: 1.8, river_adjacent: 1.1, inland: 0.2, mountainous: 0.65 },
        effects: ['torrential rain', 'destructive wind', 'coastal flooding where applicable', 'river flooding', 'landslides', 'transport shutdown']
    },
    heavy_snow: {
        label: 'Heavy Snow', icon: '❄️', durationHours: [4, 96], recoveryDays: [1, 5], base: 13,
        seasons: { spring: 0.35, summer: 0, autumn: 0.35, winter: 1.65 },
        climate: { subarctic: 1.7, alpine: 1.75, continental: 1.35, temperate: 0.65, maritime: 0.7, tropical: 0, arid: 0.15 },
        terrain: { mountainous: 1.55, high_elevation: 1.65, snowbelt: 1.5, inland: 1.15, coastal: 0.8 },
        effects: ['heavy accumulation', 'difficult travel', 'reduced visibility', 'isolation in remote terrain']
    },
    blizzard: {
        label: 'Blizzard', icon: '🌨️', durationHours: [8, 120], recoveryDays: [2, 10], base: 6,
        seasons: { spring: 0.12, summer: 0, autumn: 0.14, winter: 1.8 },
        climate: { subarctic: 1.8, alpine: 1.7, continental: 1.55, temperate: 0.25, maritime: 0.35, tropical: 0 },
        terrain: { mountainous: 1.55, high_elevation: 1.65, plains: 1.25, exposed: 1.45, snowbelt: 1.5 },
        effects: ['whiteout conditions', 'severe wind chill', 'deep drifting snow', 'blocked travel']
    },
    snow_squall: {
        label: 'Snow Squall', icon: '🌨️', durationHours: [1, 3], recoveryDays: [0, 1], base: 8,
        seasons: { spring: 0.25, summer: 0, autumn: 0.2, winter: 1.6 },
        climate: { subarctic: 1.6, alpine: 1.5, continental: 1.35, temperate: 0.45, tropical: 0 },
        terrain: { mountainous: 1.4, high_elevation: 1.5, snowbelt: 1.55, exposed: 1.2 },
        effects: ['sudden heavy snow', 'rapid visibility collapse', 'strong gusts', 'rapid surface accumulation']
    },
    ice_storm: {
        label: 'Ice Storm / Freezing Rain', icon: '🧊', durationHours: [3, 72], recoveryDays: [1, 4], base: 5,
        seasons: { spring: 0.3, summer: 0, autumn: 0.25, winter: 1.5 },
        climate: { continental: 1.5, temperate: 1.0, maritime: 0.75, subarctic: 1.0, tropical: 0 },
        terrain: { valley: 1.3, inland: 1.2, mountainous: 1.05 },
        effects: ['ice-covered roads and surfaces', 'broken branches', 'power loss', 'dangerous travel']
    },
    cold_wave: {
        label: 'Cold Wave', icon: '🥶', durationHours: [48, 336], recoveryDays: [1, 4], base: 9,
        seasons: { spring: 0.35, summer: 0, autumn: 0.35, winter: 1.7 },
        climate: { subarctic: 1.65, continental: 1.45, alpine: 1.45, temperate: 0.8, tropical: 0.02 },
        terrain: { inland: 1.25, mountainous: 1.25, high_elevation: 1.4, valley: 1.1 },
        effects: ['hard frost', 'dangerous wind chill', 'ice persistence', 'resource and travel strain']
    },
    heat_wave: {
        label: 'Heat Wave', icon: '🥵', durationHours: [48, 360], recoveryDays: [1, 3], base: 10,
        seasons: { spring: 0.35, summer: 1.7, autumn: 0.35, winter: 0.01 },
        climate: { tropical: 1.45, subtropical: 1.45, humid: 1.2, arid: 1.45, continental: 1.0, temperate: 0.8, subarctic: 0.1 },
        terrain: { urban: 1.35, inland: 1.25, arid: 1.35, valley: 1.05 },
        effects: ['oppressive nighttime heat', 'heat stress', 'high energy demand in modern settings', 'drying vegetation where applicable']
    },
    dust_storm: {
        label: 'Dust / Sandstorm', icon: '🌪️', durationHours: [1, 36], recoveryDays: [0, 1], base: 7,
        seasons: { spring: 1.2, summer: 1.15, autumn: 0.8, winter: 0.45 },
        climate: { arid: 1.8, semiarid: 1.65, continental: 0.55, temperate: 0.15, humid: 0.03, tropical: 0.02 },
        terrain: { desert: 1.9, steppe: 1.6, exposed: 1.4, plains: 1.15, forested: 0.05 },
        effects: ['near-zero visibility', 'dust infiltration', 'travel hazards', 'abrasive wind']
    },
    hazardous_fog: {
        label: 'Dense / Hazardous Fog', icon: '🌫️', durationHours: [2, 72], recoveryDays: [0, 1], base: 10,
        seasons: { spring: 0.8, summer: 0.65, autumn: 1.35, winter: 1.25 },
        climate: { humid: 1.4, maritime: 1.35, temperate: 1.0, arid: 0.15 },
        terrain: { valley: 1.5, coastal: 1.35, river_adjacent: 1.45, mountainous: 1.2, lowland: 1.15 },
        effects: ['very low visibility', 'navigation danger', 'travel delays', 'persistent damp and chill']
    }
};

const FREQUENCY_MASTER_CHANCE = { rare: 0.008, occasional: 0.02, active: 0.05 };
const SEVERITY_WEIGHTS = [
    { value: 'moderate', weight: 70 },
    { value: 'severe', weight: 25 },
    { value: 'extreme', weight: 5 }
];
const TIME_BUCKETS = ['morning', 'afternoon', 'evening', 'overnight', 'all day'];

const DURATION_BY_SEVERITY = {
    severe_thunderstorm: { moderate:[1,3], severe:[3,8], extreme:[6,18] },
    torrential_rain: { moderate:[3,12], severe:[12,48], extreme:[48,120] },
    prolonged_heavy_rain: { moderate:[24,48], severe:[48,120], extreme:[120,240] },
    windstorm: { moderate:[4,12], severe:[12,36], extreme:[24,72] },
    tropical_cyclone: { moderate:[12,24], severe:[24,48], extreme:[48,96] },
    heavy_snow: { moderate:[4,12], severe:[12,36], extreme:[48,96] },
    blizzard: { moderate:[8,18], severe:[24,72], extreme:[72,120] },
    snow_squall: { moderate:[1,1], severe:[1,2], extreme:[2,3] },
    ice_storm: { moderate:[3,8], severe:[8,24], extreme:[24,72] },
    cold_wave: { moderate:[48,96], severe:[96,192], extreme:[168,336] },
    heat_wave: { moderate:[48,96], severe:[96,192], extreme:[168,360] },
    dust_storm: { moderate:[1,4], severe:[4,12], extreme:[12,36] },
    hazardous_fog: { moderate:[2,6], severe:[6,18], extreme:[18,72] }
};

function clone(v) { return JSON.parse(JSON.stringify(v)); }
function norm(s) { return String(s || '').trim().toLowerCase().replace(/[\s/-]+/g, '_'); }
function titleCase(s) { return String(s || '').replace(/_/g, ' ').replace(/\b\w/g, m => m.toUpperCase()); }

export function makeDefaultWeatherProfile(name = 'Default Weather') {
    return {
        id: `weather_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name,
        climate: [],
        terrain: [],
        characteristics: [],
        notes: '',
        frequency: 'occasional',
        activeSystem: null,
        history: [],
        overrides: []
    };
}

export function defaultWeatherProfilesState() {
    return {
        enabled: false,
        affectForecast: true,
        showOnHome: true,
        activeProfileId: null,
        profiles: []
    };
}

export function getWeatherProfilesState(chatId) {
    const raw = getChatData(chatId, 'weatherProfiles');
    const state = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : defaultWeatherProfilesState();
    state.enabled = state.enabled === true;
    state.affectForecast = state.affectForecast !== false;
    state.showOnHome = state.showOnHome !== false;
    state.profiles = (Array.isArray(state.profiles) ? state.profiles : [])
        .filter(p => p && typeof p === 'object' && !Array.isArray(p));
    state.profiles.forEach((p, index) => {
        p.id = String(p.id || `weather_profile_${index + 1}`);
        p.name = String(p.name || `Weather Profile ${index + 1}`);
        p.climate = Array.isArray(p.climate) ? p.climate : [];
        p.terrain = Array.isArray(p.terrain) ? p.terrain : [];
        p.characteristics = Array.isArray(p.characteristics) ? p.characteristics : [];
        p.notes = typeof p.notes === 'string' ? p.notes : '';
        p.history = Array.isArray(p.history) ? p.history.filter(h => h && typeof h === 'object') : [];
        p.overrides = Array.isArray(p.overrides) ? p.overrides.filter(o => o && typeof o === 'object') : [];
        p.activeSystem = p.activeSystem && typeof p.activeSystem === 'object' ? p.activeSystem : null;
        p.frequency = ['rare','occasional','active'].includes(p.frequency) ? p.frequency : 'occasional';
    });
    if (state.activeProfileId && !state.profiles.some(p => p.id === state.activeProfileId)) {
        state.activeProfileId = state.profiles[0]?.id || null;
    }
    return state;
}

export async function saveWeatherProfilesState(chatId, state) {
    await setChatData(chatId, 'weatherProfiles', state);
}

export function getActiveWeatherProfile(chatId) {
    const state = getWeatherProfilesState(chatId);
    return state.profiles.find(p => p.id === state.activeProfileId) || null;
}

export async function upsertWeatherProfile(chatId, profile, { activate = true } = {}) {
    const state = getWeatherProfilesState(chatId);
    const idx = state.profiles.findIndex(p => p.id === profile.id);
    const normalized = clone(profile);
    if (idx >= 0) state.profiles[idx] = normalized;
    else state.profiles.push(normalized);
    if (activate) state.activeProfileId = normalized.id;
    await saveWeatherProfilesState(chatId, state);
    return normalized;
}

export async function setActiveWeatherProfile(chatId, profileId) {
    const state = getWeatherProfilesState(chatId);
    if (profileId && !state.profiles.some(p => p.id === profileId)) return false;
    state.activeProfileId = profileId || null;
    await saveWeatherProfilesState(chatId, state);
    return true;
}

export async function deleteWeatherProfile(chatId, profileId) {
    const state = getWeatherProfilesState(chatId);
    state.profiles = state.profiles.filter(p => p.id !== profileId);
    if (state.activeProfileId === profileId) state.activeProfileId = state.profiles[0]?.id || null;
    await saveWeatherProfilesState(chatId, state);
}

function hash32(text) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}
function seeded(seedText) {
    let x = hash32(seedText) || 1;
    return () => {
        x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
        return (x >>> 0) / 4294967296;
    };
}
function weightedPick(items, rand) {
    const total = items.reduce((s, x) => s + Math.max(0, x.weight || 0), 0);
    if (total <= 0) return null;
    let r = rand() * total;
    for (const item of items) {
        r -= Math.max(0, item.weight || 0);
        if (r <= 0) return item.value;
    }
    return items[items.length - 1]?.value ?? null;
}
function seasonKey(season) {
    const s = norm(season);
    if (s.includes('spring') || s.includes('haru')) return 'spring';
    if (s.includes('summer') || s.includes('natsu')) return 'summer';
    if (s.includes('autumn') || s.includes('fall') || s.includes('aki')) return 'autumn';
    if (s.includes('winter') || s.includes('fuyu')) return 'winter';
    return null;
}
function customSeasonMultiplier(eventId, season) {
    const s = String(season || '').toLowerCase();
    if (!s) return 1;
    if (/cold|frost|snow|ice/.test(s)) return WEATHER_EVENT_DEFS[eventId]?.seasons?.winter ?? 1;
    if (/hot|heat/.test(s)) return WEATHER_EVENT_DEFS[eventId]?.seasons?.summer ?? 1;
    if (/wet|rain|monsoon/.test(s)) {
        if (['torrential_rain','prolonged_heavy_rain'].includes(eventId)) return 1.6;
        if (['severe_thunderstorm','tropical_cyclone','hazardous_fog'].includes(eventId)) return 1.3;
        if (eventId === 'dust_storm') return 0.12;
        return 0.9;
    }
    if (/dry|drought/.test(s)) {
        if (['dust_storm','heat_wave','windstorm'].includes(eventId)) return 1.4;
        if (['torrential_rain','prolonged_heavy_rain','hazardous_fog'].includes(eventId)) return 0.3;
        return 0.85;
    }
    if (/storm/.test(s) && ['severe_thunderstorm','torrential_rain','windstorm','tropical_cyclone'].includes(eventId)) return 1.35;
    return 1;
}
function characteristicMultiplier(def, characteristics = []) {
    let m = 1;
    const text = characteristics.join(' ').toLowerCase();
    if (/harsh winter|heavy snow|snowy/.test(text) && ['heavy_snow','blizzard','snow_squall','cold_wave'].includes(def._id)) m *= 1.35;
    if (/rainy season|monsoon|heavy rain/.test(text) && ['torrential_rain','prolonged_heavy_rain','severe_thunderstorm'].includes(def._id)) m *= 1.3;
    if (/humid summer|humid/.test(text) && ['severe_thunderstorm','torrential_rain','heat_wave'].includes(def._id)) m *= 1.18;
    if (/dry|arid/.test(text) && ['dust_storm','heat_wave'].includes(def._id)) m *= 1.2;
    return m;
}
function eventWeight(eventId, def, profile, season) {
    let w = def.base || 1;
    const s = seasonKey(season);
    w *= s ? (def.seasons?.[s] ?? 1) : customSeasonMultiplier(eventId, season);
    const climateTags = profile.climate.map(norm);
    const terrainTags = profile.terrain.map(norm);
    for (const tag of climateTags) if (def.climate?.[tag] != null) w *= def.climate[tag];
    for (const tag of terrainTags) if (def.terrain?.[tag] != null) w *= def.terrain[tag];
    w *= characteristicMultiplier({ ...def, _id: eventId }, profile.characteristics);
    return Number.isFinite(w) ? Math.max(0, w) : 0;
}
function simpleRangeRoll([min, max], rand) {
    if (min === max) return min;
    return Math.round(min + (max - min) * rand());
}
function durationRoll(eventId, severity, rand) {
    const range = DURATION_BY_SEVERITY[eventId]?.[severity] || WEATHER_EVENT_DEFS[eventId]?.durationHours || [1, 24];
    return simpleRangeRoll(range, rand);
}

function severityScale(severity) {
    if (severity === 'extreme') return [0.72, 1.0];
    if (severity === 'severe') return [0.38, 0.78];
    return [0.0, 0.45];
}
function rangeRoll([min, max], rand, severity) {
    const [lo, hi] = severityScale(severity);
    const t = lo + (hi - lo) * rand();
    return Math.round(min + (max - min) * t);
}
function hasRecentSevere(profile, elapsedDay) {
    const history = profile.history || [];
    const recent = history.filter(h => Number.isFinite(h.endedElapsedDay) && elapsedDay - h.endedElapsedDay <= 4);
    return recent.length > 0;
}
function activeSystemStatus(system, elapsedDay) {
    if (!system) return 'none';
    const start = Number(system.startsElapsedDay ?? 0);
    const activeDays = Math.max(1, Math.ceil((system.durationHours || 1) / 24));
    const activeEnd = start + activeDays - 1;
    const recoveryEnd = activeEnd + (system.recoveryDays || 0);
    if (elapsedDay < start) return 'upcoming';
    if (elapsedDay <= activeEnd) return 'active';
    if (elapsedDay <= recoveryEnd) return 'recovery';
    return 'expired';
}

function overrideDurationDays(override) {
    const explicitDays = Number(override?.durationDays);
    if (Number.isFinite(explicitDays) && explicitDays > 0) return Math.max(1, Math.ceil(explicitDays));
    const hours = Number(override?.durationHours);
    return Number.isFinite(hours) && hours > 0 ? Math.max(1, Math.ceil(hours / 24)) : 1;
}

function matchingOverride(profile, elapsedDay, lookaheadDays = 6) {
    const overrides = (profile.overrides || []).filter(o => o && o.enabled !== false);
    const candidates = overrides.filter(o => {
        const start = Number(o.startElapsedDay);
        const end = start + overrideDurationDays(o) - 1;
        return Number.isFinite(start) && end >= elapsedDay && start <= elapsedDay + Math.max(0, lookaheadDays);
    });
    candidates.sort((a, b) => Number(a.startElapsedDay) - Number(b.startElapsedDay));
    return candidates[0] || null;
}

function systemFromOverride(override) {
    const start = Number(override.startElapsedDay);
    return {
        id: `override_${override.id || start}`,
        type: override.type || 'custom',
        label: override.customName || WEATHER_EVENT_DEFS[override.type]?.label || titleCase(override.type || 'Custom Weather'),
        icon: WEATHER_EVENT_DEFS[override.type]?.icon || '⚠️',
        severity: override.severity || 'severe',
        startsElapsedDay: start,
        durationHours: Math.max(1, Number(override.durationHours || (overrideDurationDays(override) * 24))),
        recoveryDays: Math.max(0, Number(override.recoveryDays || 0)),
        timeOfDay: override.timeOfDay || 'all day',
        effects: Array.isArray(override.effects) ? override.effects : (WEATHER_EVENT_DEFS[override.type]?.effects || []),
        customDescription: override.description || '',
        source: 'override'
    };
}

export function prepareSevereWeatherAdvance(chatId, { targetElapsedDay, season, dayCount }) {
    const state = getWeatherProfilesState(chatId);
    if (!state.enabled || !state.activeProfileId) return { state, changed: false, system: null, status: 'disabled', toast: '' };
    const profile = state.profiles.find(p => p.id === state.activeProfileId);
    if (!profile) return { state, changed: false, system: null, status: 'no-profile', toast: '' };
    const next = clone(state);
    const p = next.profiles.find(x => x.id === next.activeProfileId);
    let mutated = false;

    if (p.activeSystem && activeSystemStatus(p.activeSystem, targetElapsedDay) === 'expired') {
        const endedElapsedDay = Number(p.activeSystem.startsElapsedDay || 0) + Math.max(1, Math.ceil((p.activeSystem.durationHours || 1) / 24)) - 1 + Number(p.activeSystem.recoveryDays || 0);
        p.history.push({ ...p.activeSystem, endedElapsedDay });
        p.history = p.history.slice(-30);
        p.activeSystem = null;
        mutated = true;
    }

    // Only an override that has actually reached its start day may replace
    // the persisted active system. A future override inside the 7-day horizon
    // is a forecast constraint, not permission to erase today's weather.
    const activeOverride = matchingOverride(p, targetElapsedDay, 0);
    if (p.activeSystem && p.activeSystem.source === 'override' && activeSystemStatus(p.activeSystem, targetElapsedDay) !== 'expired') {
        return { state: next, changed: mutated, system: p.activeSystem, status: activeSystemStatus(p.activeSystem, targetElapsedDay), toast: '' };
    }
    if (activeOverride) {
        const system = systemFromOverride(activeOverride);
        p.activeSystem = system;
        return { state: next, changed: true, system, status: activeSystemStatus(system, targetElapsedDay), toast: `Weather override active: ${system.label}` };
    }

    if (p.activeSystem) {
        return { state: next, changed: mutated, system: p.activeSystem, status: activeSystemStatus(p.activeSystem, targetElapsedDay), toast: '' };
    }

    // Reserve an upcoming manual override before rolling RNG so a random system
    // cannot occupy the same forecast window. Do not persist it as active yet.
    const upcomingOverride = matchingOverride(p, targetElapsedDay, 6);
    if (upcomingOverride) {
        const system = systemFromOverride(upcomingOverride);
        return { state: next, changed: mutated, system, status: 'upcoming', toast: '' };
    }

    const seedBase = `${chatId}|${p.id}|${targetElapsedDay}|${dayCount}|${season}`;
    const rand = seeded(seedBase);
    const weighted = Object.entries(WEATHER_EVENT_DEFS).map(([id, def]) => ({ value: id, weight: eventWeight(id, def, p, season) }));
    const baseTotal = Object.values(WEATHER_EVENT_DEFS).reduce((sum, def) => sum + (def.base || 0), 0) || 1;
    const weightedTotal = weighted.reduce((sum, item) => sum + Math.max(0, item.weight || 0), 0);
    // Season + climate + terrain influence not just WHICH event is eligible,
    // but the overall chance that severe weather forms at all.
    const suitability = Math.max(0.2, Math.min(2.0, weightedTotal / baseTotal));
    let masterChance = (FREQUENCY_MASTER_CHANCE[p.frequency] ?? FREQUENCY_MASTER_CHANCE.occasional) * suitability;
    if (hasRecentSevere(p, targetElapsedDay)) masterChance *= 0.4;
    if (rand() >= masterChance) return { state: next, changed: mutated, system: null, status: 'none', toast: '' };

    const type = weightedPick(weighted, rand);
    if (!type) return { state: next, changed: mutated, system: null, status: 'none', toast: '' };
    const def = WEATHER_EVENT_DEFS[type];
    const severity = weightedPick(SEVERITY_WEIGHTS, rand) || 'moderate';
    const durationHours = durationRoll(type, severity, rand);
    const recoveryDays = rangeRoll(def.recoveryDays, rand, severity);
    const leadDays = (type === 'tropical_cyclone' || type === 'blizzard' || type === 'prolonged_heavy_rain') ? Math.floor(rand() * 7) : Math.floor(rand() * 2);
    const timeOfDay = durationHours >= 24 ? 'all day' : TIME_BUCKETS[Math.floor(rand() * (TIME_BUCKETS.length - 1))];
    const system = {
        id: `weather_${type}_${targetElapsedDay}_${hash32(seedBase).toString(36)}`,
        type,
        label: def.label,
        icon: def.icon,
        severity,
        startsElapsedDay: targetElapsedDay + leadDays,
        durationHours,
        recoveryDays,
        timeOfDay,
        effects: clone(def.effects || []),
        source: 'rng',
        generatedElapsedDay: targetElapsedDay,
        profileName: p.name
    };
    p.activeSystem = system;
    return { state: next, changed: true, system, status: activeSystemStatus(system, targetElapsedDay), toast: `Severe weather system developing: ${system.label}` };
}

export async function commitPreparedWeather(chatId, prepared) {
    if (prepared?.state && prepared.changed) await saveWeatherProfilesState(chatId, prepared.state);
}

export function getWeatherProfileForecastContext(chatId) {
    const state = getWeatherProfilesState(chatId);
    if (!state.enabled) return '';
    const p = state.profiles.find(x => x.id === state.activeProfileId);
    if (!p) return '';
    return [
        '=== ACTIVE WEATHER PROFILE ===',
        `Region/Profile: ${p.name}`,
        p.climate?.length ? `Climate: ${p.climate.join(', ')}` : '',
        p.terrain?.length ? `Terrain: ${p.terrain.join(', ')}` : '',
        p.characteristics?.length ? `Characteristics: ${p.characteristics.join('; ')}` : '',
        p.notes ? `Weather notes: ${p.notes}` : '',
        'Use this profile to ground ordinary forecast conditions as well as severe-weather plausibility.'
    ].filter(Boolean).join('\n');
}

export function getSevereWeatherConstraint(chatId, currentElapsedDay = null) {
    const state = getWeatherProfilesState(chatId);
    if (!state.enabled || !state.affectForecast) return '';
    const p = state.profiles.find(x => x.id === state.activeProfileId);
    if (!p) return '';
    const elapsed = Number.isFinite(currentElapsedDay) ? currentElapsedDay : (getCurrentDay(chatId)?.elapsedStoryDays || 0);
    if (p.activeSystem && activeSystemStatus(p.activeSystem, elapsed) !== 'expired') {
        return formatSystemConstraint(p.activeSystem, elapsed, p);
    }
    // A newly-scheduled manual override should constrain forecast regeneration
    // immediately, even before the next story-day advancement persists it as the
    // profile's activeSystem.
    const override = matchingOverride(p, elapsed, 6);
    if (!override) return '';
    const system = systemFromOverride(override);
    system.id = `override_preview_${override.id || elapsed}`;
    return formatSystemConstraint(system, elapsed, p);
}

export function formatSystemConstraint(system, elapsedDay, profile = null) {
    if (!system) return '';
    const status = activeSystemStatus(system, elapsedDay);
    if (status === 'expired') return '';
    const startsIn = Number(system.startsElapsedDay || 0) - elapsedDay;
    const activeDays = Math.max(1, Math.ceil((system.durationHours || 1) / 24));
    let timing = startsIn > 0 ? `Begins in ${startsIn} day${startsIn === 1 ? '' : 's'}` : (status === 'recovery' ? 'Active phase has ended; lingering recovery conditions remain' : 'Active now');
    if (startsIn >= 0 && system.timeOfDay && system.timeOfDay !== 'all day') timing += ` (${system.timeOfDay})`;
    return [
        '=== SEVERE WEATHER SYSTEM — HARD FORECAST CONSTRAINT ===',
        profile?.name ? `Weather profile: ${profile.name}` : '',
        `Type: ${system.label}`,
        `Severity: ${system.severity}`,
        `Timing: ${timing}`,
        `Active duration: approximately ${system.durationHours} hours (~${activeDays} day${activeDays === 1 ? '' : 's'})`,
        `Recovery / lingering effects: ${system.recoveryDays || 0} day(s)`,
        system.effects?.length ? `Likely effects: ${system.effects.join(', ')}` : '',
        system.customDescription ? `Override notes: ${system.customDescription}` : '',
        'The 7-day forecast MUST honor this system. Build plausible lead-in conditions before arrival and plausible recovery afterward. Do not replace, move, erase, or invent a different severe-weather type.'
    ].filter(Boolean).join('\n');
}

export function getWeatherHomeStatus(chatId) {
    const state = getWeatherProfilesState(chatId);
    if (!state.enabled || !state.showOnHome) return null;
    const p = state.profiles.find(x => x.id === state.activeProfileId);
    if (!p) return { profileName: '', text: 'Severe weather enabled, but no Weather Profile is selected.', icon: '🌩️' };
    const elapsed = getCurrentDay(chatId)?.elapsedStoryDays || 0;
    if (!p.activeSystem) {
        const override = matchingOverride(p, elapsed, 6);
        if (override) {
            const delta = Math.max(0, Number(override.startElapsedDay) - elapsed);
            const label = override.customName || WEATHER_EVENT_DEFS[override.type]?.label || titleCase(override.type || 'Custom Weather');
            return { profileName: p.name, text: `${override.severity || 'severe'} ${label} · override ${delta > 0 ? `in ${delta} day${delta === 1 ? '' : 's'}` : 'active'}`, icon: WEATHER_EVENT_DEFS[override.type]?.icon || '⚠️' };
        }
        return { profileName: p.name, text: 'No severe weather active.', icon: '🌤️' };
    }
    const status = activeSystemStatus(p.activeSystem, elapsed);
    if (status === 'expired') return { profileName: p.name, text: 'No severe weather active.', icon: '🌤️' };
    const delta = Number(p.activeSystem.startsElapsedDay || 0) - elapsed;
    let text = `${p.activeSystem.severity} ${p.activeSystem.label}`;
    if (delta > 0) text += ` · begins in ${delta} day${delta === 1 ? '' : 's'}`;
    else if (status === 'recovery') text += ' · recovery conditions';
    else text += ' · active';
    return { profileName: p.name, text, icon: p.activeSystem.icon || '⚠️' };
}

export function profileSummary(profile) {
    if (!profile) return '';
    const bits = [...(profile.climate || []), ...(profile.terrain || [])].filter(Boolean);
    return bits.join(' • ');
}

