/* eslint-disable */
// =============================================================================
// NWST Per-Chat Moon Configuration — data/moons.js
// =============================================================================
// Moon configuration and manual phenomenon overrides are narrative-world data,
// so they live in chatMetadata instead of global extension settings.
// Existing global moon settings are used once as a migration seed for chats
// that predate this module, preserving every user's current configuration.
// =============================================================================

import { getSetting } from '../index.js';
import {
    getChatData,
    setChatData,
    chatDataExists,
    DEFAULT_MOON_CONFIG,
    DEFAULT_MOON_PHENOMENON_OVERRIDES
} from './storage.js';

export const MOON_OVERRIDE_PHENOMENA = [
    { value: '🌕 Super Moon', label: 'Super Moon' },
    { value: '🌕 Blood Moon', label: 'Blood Moon' },
    { value: '🌕 Micro Moon', label: 'Micro Moon' },
    { value: '☀️ Partial Solar Eclipse', label: 'Partial Solar Eclipse' },
    { value: '☀️ Annular Solar Eclipse', label: 'Annular Solar Eclipse' },
    { value: '☀️ Total Solar Eclipse', label: 'Total Solar Eclipse' },
    { value: '☀️ Hybrid Solar Eclipse', label: 'Hybrid Solar Eclipse' },
    { value: '🌑 Penumbral Lunar Eclipse', label: 'Penumbral Lunar Eclipse' },
    { value: '🌑 Partial Lunar Eclipse', label: 'Partial Lunar Eclipse' },
    { value: '🌑 Total Lunar Eclipse', label: 'Total Lunar Eclipse' },
    { value: '🌌 Moonbow', label: 'Moonbow' },
    { value: '🌘 Earthshine', label: 'Earthshine' },
    { value: '🌈 Lunar Corona', label: 'Lunar Corona' },
    { value: '✨ Moondogs', label: 'Moondogs' },
    { value: '🕯️ Moon Pillar', label: 'Moon Pillar' },
    { value: '🌙 Lunar Halo', label: 'Lunar Halo' },
    { value: '🌕 Moon Illusion', label: 'Moon Illusion' },
    { value: '🟠 Amber Moonrise', label: 'Amber Moonrise' },
    { value: '✨ Lunar Occultation', label: 'Lunar Occultation' },
    { value: '__custom__', label: 'Custom phenomenon…' }
];

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function normalizeMoon(moon, index) {
    const cycle = Number(moon?.cycleDays);
    return {
        id: String(moon?.id || (index === 0 ? 'primary' : `moon_${index}`)),
        name: String(moon?.name || (index === 0 ? 'The Moon' : `Moon ${index + 1}`)).trim() || 'Moon',
        cycleDays: Number.isFinite(cycle) && cycle >= 1 && cycle <= 999 ? cycle : 29.53,
        enabled: moon?.enabled !== false
    };
}

export function normalizeMoonConfig(value) {
    const source = value && typeof value === 'object' ? value : DEFAULT_MOON_CONFIG;
    const fallbackCycle = Number(source.moonCycleDays);
    let moons = Array.isArray(source.moons) ? source.moons.map(normalizeMoon) : [];
    if (moons.length === 0) {
        moons = [normalizeMoon({
            id: 'primary',
            name: 'The Moon',
            cycleDays: Number.isFinite(fallbackCycle) ? fallbackCycle : 29.53,
            enabled: true
        }, 0)];
    }
    // The first moon owns the legacy primary lunarAngle/moonPhases pipeline.
    moons[0].id = 'primary';
    return {
        enableMoons: source.enableMoons !== false,
        enableMoonPhenomena: source.enableMoonPhenomena !== false,
        moonCycleDays: Number.isFinite(fallbackCycle) && fallbackCycle >= 1 && fallbackCycle <= 999
            ? fallbackCycle : 29.53,
        moons
    };
}

function legacyMoonSeed() {
    return normalizeMoonConfig({
        enableMoons: getSetting('enableMoons') !== false,
        enableMoonPhenomena: getSetting('enableMoonPhenomena') !== false,
        moonCycleDays: getSetting('moonCycleDays') || 29.53,
        moons: getSetting('moons')
    });
}

export function getMoonConfig(chatId) {
    if (chatDataExists(chatId, 'moonConfig')) {
        return normalizeMoonConfig(getChatData(chatId, 'moonConfig'));
    }
    return legacyMoonSeed();
}

export async function saveMoonConfig(chatId, config) {
    const normalized = normalizeMoonConfig(config);
    await setChatData(chatId, 'moonConfig', normalized);
    return normalized;
}

export async function updateMoonConfig(chatId, patch) {
    return saveMoonConfig(chatId, { ...getMoonConfig(chatId), ...(patch || {}) });
}

export async function ensureMoonConfigMigrated(chatId) {
    if (!chatId || chatDataExists(chatId, 'moonConfig')) return false;
    await setChatData(chatId, 'moonConfig', legacyMoonSeed());
    return true;
}

function normalizeDate(value) {
    const year = Number(value?.year);
    const month = Number(value?.month);
    const day = Number(value?.day);
    if (!Number.isInteger(year) || year === 0 || !Number.isInteger(month) || month < 1 || !Number.isInteger(day) || day < 1) {
        return null;
    }
    return { year, month, day };
}

function normalizeOverride(item, index) {
    const phenomenon = String(item?.phenomenon || '').trim();
    const customLabel = String(item?.customLabel || '').trim();
    return {
        id: String(item?.id || `moon_override_${Date.now()}_${index}`),
        enabled: item?.enabled !== false,
        moonId: String(item?.moonId || 'all'),
        phenomenon: phenomenon || '__custom__',
        customLabel,
        description: String(item?.description || '').trim(),
        startDate: normalizeDate(item?.startDate),
        endDate: normalizeDate(item?.endDate) || normalizeDate(item?.startDate)
    };
}

export function getMoonPhenomenonOverrides(chatId) {
    const stored = getChatData(chatId, 'moonPhenomenonOverrides');
    if (!Array.isArray(stored)) return clone(DEFAULT_MOON_PHENOMENON_OVERRIDES);
    return stored.map(normalizeOverride).filter(item => item.startDate && item.endDate);
}

export async function saveMoonPhenomenonOverrides(chatId, overrides) {
    const normalized = Array.isArray(overrides)
        ? overrides.map(normalizeOverride).filter(item => item.startDate && item.endDate)
        : [];
    await setChatData(chatId, 'moonPhenomenonOverrides', normalized);
    return normalized;
}

export function getOverrideDisplayLabel(override) {
    if (!override) return '';
    if (override.phenomenon === '__custom__') return String(override.customLabel || '').trim();
    return String(override.phenomenon || '').trim();
}
