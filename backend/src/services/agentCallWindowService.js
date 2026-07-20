'use strict';

/**
 * AGENT-CALL-WINDOW-001 — the single outbound-robot call-window guard.
 *
 * Every robot asks nextAllowedAt(companyId, agentKey, instant) before creating
 * or starting a dial. Agent settings contain either a complete custom window or
 * nulls (inherit); inherited windows come from company dispatch settings.
 * Resolver faults never escape into the dial path and never fail open.
 */
const scheduleService = require('./scheduleService');
const outboundCallSettingsService = require('./outboundCallSettingsService');
const outboundLeadCallSettingsService = require('./outboundLeadCallSettingsService');

const AGENT_KEYS = Object.freeze({
    PARTS: 'outbound-parts-caller',
    LEADS: 'outbound-lead-caller',
});

const FALLBACK_WINDOW = Object.freeze({
    timezone: 'America/New_York',
    work_start_time: '08:00',
    work_end_time: '18:00',
    work_days: Object.freeze([1, 2, 3, 4, 5]),
});

const SETTINGS_SERVICES = Object.freeze({
    [AGENT_KEYS.PARTS]: outboundCallSettingsService,
    [AGENT_KEYS.LEADS]: outboundLeadCallSettingsService,
});

const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;
const WEEKDAY_TO_NUM = Object.freeze({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 });

function parseTime(value) {
    const match = TIME_RE.exec(String(value ?? ''));
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    const second = match[3] == null ? 0 : Number(match[3]);
    if (hour < 0 || hour > 24 || minute < 0 || minute > 59 || second !== 0) return null;
    if (hour === 24 && minute !== 0) return null;
    return { text: `${match[1]}:${match[2]}`, minutes: hour * 60 + minute };
}

function validTimezone(value) {
    const timezone = String(value || FALLBACK_WINDOW.timezone);
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
        return timezone;
    } catch {
        return FALLBACK_WINDOW.timezone;
    }
}

/**
 * The former lead-caller sanitizer, now shared by every agent. It returns a
 * complete same-day window and uses the conservative fallback for malformed
 * days/times/timezones.
 */
function sanitizeDispatchSettings(settings) {
    const src = settings && typeof settings === 'object' ? settings : {};
    const days = Array.isArray(src.work_days)
        ? [...new Set(src.work_days.filter(day => Number.isInteger(day) && day >= 0 && day <= 6))]
        : [];
    const start = parseTime(src.work_start_time);
    const end = parseTime(src.work_end_time);
    const validRange = start && end && start.minutes < end.minutes && end.minutes <= 24 * 60;

    return {
        timezone: validTimezone(src.timezone),
        work_start_time: validRange ? start.text : FALLBACK_WINDOW.work_start_time,
        work_end_time: validRange ? end.text : FALLBACK_WINDOW.work_end_time,
        work_days: days.length > 0 ? days : [...FALLBACK_WINDOW.work_days],
    };
}

function localWallClock(date, timezone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(date);
    const get = type => (parts.find(part => part.type === type) || {}).value;
    return {
        dow: WEEKDAY_TO_NUM[get('weekday')] ?? 1,
        minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')),
    };
}

function isWithinWindow(date, settings) {
    if (settings?.always === true) return true;
    const window = sanitizeDispatchSettings(settings);
    const local = localWallClock(date, window.timezone);
    const start = parseTime(window.work_start_time).minutes;
    const end = parseTime(window.work_end_time).minutes;
    return window.work_days.includes(local.dow)
        && local.minutes >= start
        && local.minutes < end;
}

function localCalendarDate(date, timezone) {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).formatToParts(date).map(part => [part.type, part.value])
    );
    return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

/** Offset in milliseconds where local wall-clock = UTC + offset. */
function getTimezoneOffsetMs(timezone, year, month, day, hour) {
    const probe = new Date(Date.UTC(year, month - 1, day, hour, 0, 0));
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        }).formatToParts(probe).map(part => [part.type, part.value])
    );
    const renderedAsUtc = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour) % 24,
        Number(parts.minute),
        Number(parts.second)
    );
    return renderedAsUtc - probe.getTime();
}

function nextWindowStart(from, settings) {
    if (settings?.always === true) return new Date(from.getTime());
    const window = sanitizeDispatchSettings(settings);
    const start = parseTime(window.work_start_time);
    const base = localCalendarDate(from, window.timezone);
    const baseNoon = Date.UTC(base.year, base.month - 1, base.day, 12);

    for (let offset = 0; offset <= 13; offset += 1) {
        const calendar = new Date(baseNoon + offset * 24 * 60 * 60 * 1000);
        const year = calendar.getUTCFullYear();
        const month = calendar.getUTCMonth() + 1;
        const day = calendar.getUTCDate();
        const noonOffset = getTimezoneOffsetMs(window.timezone, year, month, day, 12);
        const localNoon = new Date(Date.UTC(year, month - 1, day, 12) - noonOffset);
        if (!window.work_days.includes(localWallClock(localNoon, window.timezone).dow)) continue;

        const startHour = Math.floor(start.minutes / 60);
        const startMinute = start.minutes % 60;
        const timezoneOffset = getTimezoneOffsetMs(window.timezone, year, month, day, startHour);
        const candidate = new Date(
            Date.UTC(year, month - 1, day, startHour, startMinute, 0) - timezoneOffset
        );
        if (candidate.getTime() > from.getTime()) return candidate;
    }

    return new Date(from.getTime() + 24 * 60 * 60 * 1000);
}

function clampIntoWindow(date, settings) {
    return isWithinWindow(date, settings) ? date : nextWindowStart(date, settings);
}

function hasAnyCustomField(settings) {
    return settings?.custom_start_time != null
        || settings?.custom_end_time != null
        || settings?.calling_window_work_days != null;
}

function effectiveWindow(settings, companySettings) {
    if (settings?.calling_window_mode === 'always') return { always: true };
    if (settings?.calling_window_mode == null && !hasAnyCustomField(settings)) {
        return sanitizeDispatchSettings(companySettings);
    }
    if (settings?.calling_window_mode !== 'custom'
        || !Array.isArray(settings.calling_window_work_days)
        || settings.calling_window_work_days.length === 0
        || settings.custom_start_time == null
        || settings.custom_end_time == null) {
        throw new Error('incomplete agent call-window override');
    }
    return sanitizeDispatchSettings({
        timezone: companySettings?.timezone,
        work_start_time: settings.custom_start_time,
        work_end_time: settings.custom_end_time,
        work_days: settings.calling_window_work_days,
    });
}

async function resolveEffectiveWindow(companyId, agentKey) {
    try {
        const settingsService = SETTINGS_SERVICES[agentKey];
        if (!settingsService) throw new Error('unknown agent key');
        const [settings, companySettings] = await Promise.all([
            settingsService.get(companyId),
            scheduleService.getDispatchSettings(companyId),
        ]);
        return effectiveWindow(settings, companySettings);
    } catch {
        console.warn('[callWindow] resolver failed; using conservative fallback');
        return sanitizeDispatchSettings(FALLBACK_WINDOW);
    }
}

async function nextAllowedAt(companyId, agentKey, now = new Date()) {
    const instant = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
    let allowedAt;
    try {
        const window = await resolveEffectiveWindow(companyId, agentKey);
        allowedAt = clampIntoWindow(instant, window);
    } catch {
        console.warn('[callWindow] guard failed; using conservative fallback');
        allowedAt = clampIntoWindow(instant, FALLBACK_WINDOW);
    }
    if (allowedAt.getTime() > instant.getTime()) {
        console.log(`[callWindow] deferred agent=${agentKey} until=${allowedAt.toISOString()}`);
    }
    return allowedAt;
}

module.exports = {
    AGENT_KEYS,
    FALLBACK_WINDOW,
    sanitizeDispatchSettings,
    isWithinWindow,
    nextWindowStart,
    clampIntoWindow,
    effectiveWindow,
    resolveEffectiveWindow,
    nextAllowedAt,
    getTimezoneOffsetMs,
};
