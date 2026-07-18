/**
 * Resolves and validates recurring technician schedules in company-local time.
 * A company-closed weekday is an absolute envelope; open weekdays may be
 * widened by a technician schedule.
 */
const queries = require('../db/technicianWorkScheduleQueries');
const scheduleService = require('./scheduleService');

const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?$/;

class TechnicianWorkScheduleError extends Error {
    constructor(code, message, httpStatus = 500) {
        super(message);
        this.name = 'TechnicianWorkScheduleError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

function normalizeTime(value) {
    if (typeof value !== 'string' || !TIME_RE.test(value)) return null;
    return value.slice(0, 5);
}

function timeMinutes(value) {
    const normalized = normalizeTime(value);
    if (!normalized) return NaN;
    const [hour, minute] = normalized.split(':').map(Number);
    return hour * 60 + minute;
}

function normalizeCompanySettings(settings) {
    const timezone = settings?.timezone;
    try {
        if (!timezone) throw new Error('missing timezone');
        new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    } catch {
        throw new TechnicianWorkScheduleError(
            'COMPANY_SCHEDULE_UNAVAILABLE',
            'Company schedule could not be resolved',
            503
        );
    }

    const workStart = normalizeTime(settings?.work_start_time);
    const workEnd = normalizeTime(settings?.work_end_time);
    const workDays = Array.isArray(settings?.work_days)
        ? Array.from(new Set(settings.work_days.map(Number)))
        : null;
    if (!workStart || !workEnd || timeMinutes(workStart) >= timeMinutes(workEnd)
        || !workDays || workDays.some(day => !Number.isInteger(day) || day < 0 || day > 6)) {
        throw new TechnicianWorkScheduleError(
            'COMPANY_SCHEDULE_UNAVAILABLE',
            'Company schedule could not be resolved',
            503
        );
    }

    const openDays = new Set(workDays);
    return {
        timezone,
        work_start_time: workStart,
        work_end_time: workEnd,
        work_days: workDays,
        days: Array.from({ length: 7 }, (_, day) => ({
            day_of_week: day,
            is_working: openDays.has(day),
            work_start_time: openDays.has(day) ? workStart : null,
            work_end_time: openDays.has(day) ? workEnd : null,
            company_closed: !openDays.has(day),
            source: 'company',
            exceeds_company_hours: false,
        })),
    };
}

async function getCompanySchedule(companyId) {
    let settings;
    try {
        settings = await scheduleService.getDispatchSettings(companyId);
    } catch (err) {
        throw new TechnicianWorkScheduleError(
            'COMPANY_SCHEDULE_UNAVAILABLE',
            'Company schedule could not be resolved',
            503
        );
    }
    return normalizeCompanySettings(settings);
}

function groupStoredRows(rows) {
    const grouped = new Map();
    for (const row of rows || []) {
        const id = String(row.technician_id);
        let value = grouped.get(id);
        if (!value) {
            value = {
                inherits_company_schedule: row.inherits_company_schedule !== false,
                days: [],
            };
            grouped.set(id, value);
        }
        if (row.day_of_week !== null && row.day_of_week !== undefined) {
            value.days.push({
                day_of_week: Number(row.day_of_week),
                is_working: row.is_working === true,
                work_start_time: row.is_working === true ? normalizeTime(row.work_start_time) : null,
                work_end_time: row.is_working === true ? normalizeTime(row.work_end_time) : null,
            });
        }
    }
    return grouped;
}

function isCompleteSavedWeek(days) {
    if (!Array.isArray(days) || days.length !== 7) return false;
    const seen = new Set();
    for (const day of days) {
        if (!Number.isInteger(day.day_of_week) || day.day_of_week < 0 || day.day_of_week > 6
            || seen.has(day.day_of_week)) return false;
        seen.add(day.day_of_week);
        if (day.is_working) {
            if (!day.work_start_time || !day.work_end_time
                || timeMinutes(day.work_start_time) >= timeMinutes(day.work_end_time)) return false;
        } else if (day.work_start_time || day.work_end_time) {
            return false;
        }
    }
    return true;
}

function resolveDay(companyDay, customDay, useCustom) {
    // SAFETY-COMPANY-CLOSED-WINS: this guard deliberately precedes all custom
    // schedule logic. A stored working row can never open a closed company day.
    if (!companyDay.is_working) {
        return { ...companyDay, company_closed: true };
    }
    if (!useCustom || !customDay) return { ...companyDay };
    if (!customDay.is_working) {
        return {
            day_of_week: companyDay.day_of_week,
            is_working: false,
            work_start_time: null,
            work_end_time: null,
            company_closed: false,
            source: 'work_schedule',
            exceeds_company_hours: false,
        };
    }

    const exceeds = timeMinutes(customDay.work_start_time) < timeMinutes(companyDay.work_start_time)
        || timeMinutes(customDay.work_end_time) > timeMinutes(companyDay.work_end_time);
    return {
        day_of_week: companyDay.day_of_week,
        is_working: true,
        work_start_time: customDay.work_start_time,
        work_end_time: customDay.work_end_time,
        company_closed: false,
        source: 'work_schedule',
        exceeds_company_hours: exceeds,
    };
}

function summarizeWeek(days) {
    const byDay = new Map(days.map(day => [day.day_of_week, day]));
    const ordered = DAY_ORDER.map(day => byDay.get(day));
    const segments = [];
    for (const day of ordered) {
        const signature = day?.is_working
            ? `${day.work_start_time}–${day.work_end_time}`
            : 'off';
        const last = segments[segments.length - 1];
        if (last?.signature === signature) last.days.push(day.day_of_week);
        else segments.push({ signature, days: [day.day_of_week] });
    }
    return segments.map(segment => {
        const first = DAY_NAMES[segment.days[0]];
        const last = DAY_NAMES[segment.days[segment.days.length - 1]];
        const label = segment.days.length > 1 ? `${first}–${last}` : first;
        return `${label} ${segment.signature}`;
    }).join(' · ');
}

function resolveOne(technician, companySchedule, stored, queryFailed) {
    const storedComplete = isCompleteSavedWeek(stored?.days);
    const requestedCustom = stored?.inherits_company_schedule === false;
    const useCustom = requestedCustom && storedComplete;
    const degraded = Boolean(queryFailed || (requestedCustom && !storedComplete));
    const savedByDay = new Map((storedComplete ? stored.days : []).map(day => [day.day_of_week, day]));
    const effectiveDays = companySchedule.days.map(companyDay =>
        resolveDay(companyDay, savedByDay.get(companyDay.day_of_week), useCustom));
    const widerDays = effectiveDays.filter(day => day.exceeds_company_hours).map(day => ({
        day_of_week: day.day_of_week,
        day_name: DAY_NAMES[day.day_of_week],
        technician_interval: `${day.work_start_time}–${day.work_end_time}`,
        company_interval: `${companySchedule.work_start_time}–${companySchedule.work_end_time}`,
    }));

    return {
        technician_id: String(technician.id),
        technician_name: technician.name || String(technician.id),
        has_schedule: Boolean(stored),
        inherits_company_schedule: degraded ? true : !useCustom,
        has_saved_custom_schedule: storedComplete,
        saved_week: storedComplete
            ? [...stored.days].sort((a, b) => a.day_of_week - b.day_of_week)
            : companySchedule.days.map(day => ({
                day_of_week: day.day_of_week,
                is_working: day.is_working,
                work_start_time: day.work_start_time,
                work_end_time: day.work_end_time,
            })),
        effective_week: effectiveDays,
        schedule_summary: summarizeWeek(effectiveDays),
        exceeds_company_hours: widerDays.length > 0,
        wider_days: widerDays,
        degraded_to_company_schedule: degraded,
    };
}

async function listEffective(companyId, technicians) {
    const companySchedule = await getCompanySchedule(companyId);
    const ids = (technicians || []).map(technician => String(technician.id));
    let stored = new Map();
    let queryFailed = false;
    try {
        stored = groupStoredRows(await queries.listByTechnicianIds(companyId, ids));
    } catch (err) {
        queryFailed = true;
        console.error('[TechnicianWorkSchedule] override read failed; using company schedule:', err.message);
    }
    return {
        company_schedule: companySchedule,
        technicians: (technicians || []).map(technician =>
            resolveOne(technician, companySchedule, stored.get(String(technician.id)), queryFailed)),
    };
}

async function getSettings(companyId, technician) {
    const result = await listEffective(companyId, [technician]);
    return {
        ...result.technicians[0],
        company_schedule: result.company_schedule,
    };
}

function validateCustomDays(days) {
    if (!Array.isArray(days) || days.length !== 7) {
        throw new TechnicianWorkScheduleError('VALIDATION', 'A custom schedule requires exactly seven weekdays', 400);
    }
    const normalized = days.map(day => {
        const dayOfWeek = Number(day?.day_of_week);
        if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
            throw new TechnicianWorkScheduleError('VALIDATION', 'day_of_week must be an integer from 0 through 6', 400);
        }
        if (typeof day.is_working !== 'boolean') {
            throw new TechnicianWorkScheduleError('VALIDATION', 'is_working must be a boolean for every weekday', 400);
        }
        if (!day.is_working) {
            return { day_of_week: dayOfWeek, is_working: false, work_start_time: null, work_end_time: null };
        }
        const start = normalizeTime(day.work_start_time);
        const end = normalizeTime(day.work_end_time);
        if (!start || !end || timeMinutes(start) >= timeMinutes(end)) {
            throw new TechnicianWorkScheduleError('VALIDATION', 'Working days require valid start and end times with start before end', 400);
        }
        return { day_of_week: dayOfWeek, is_working: true, work_start_time: start, work_end_time: end };
    });
    if (new Set(normalized.map(day => day.day_of_week)).size !== 7) {
        throw new TechnicianWorkScheduleError('VALIDATION', 'Each weekday must appear exactly once', 400);
    }
    return normalized.sort((a, b) => a.day_of_week - b.day_of_week);
}

async function save(companyId, technician, payload, updatedBy) {
    if (typeof payload?.inherits_company_schedule !== 'boolean') {
        throw new TechnicianWorkScheduleError('VALIDATION', 'inherits_company_schedule must be a boolean', 400);
    }
    const companySchedule = await getCompanySchedule(companyId);
    let days = [];
    if (!payload.inherits_company_schedule) {
        days = validateCustomDays(payload.days);
        const companyByDay = new Map(companySchedule.days.map(day => [day.day_of_week, day]));
        const closedOverride = days.find(day => day.is_working && !companyByDay.get(day.day_of_week)?.is_working);
        if (closedOverride) {
            throw new TechnicianWorkScheduleError(
                'COMPANY_CLOSED_DAY',
                `${DAY_NAMES[closedOverride.day_of_week]} is closed in the company schedule`,
                422
            );
        }
    }

    await queries.replace(companyId, technician.id, {
        inheritsCompanySchedule: payload.inherits_company_schedule,
        days,
        updatedBy,
    });
    return getSettings(companyId, technician);
}

module.exports = {
    getCompanySchedule,
    listEffective,
    getSettings,
    save,
    summarizeWeek,
    TechnicianWorkScheduleError,
    _normalizeCompanySettings: normalizeCompanySettings,
    _resolveDay: resolveDay,
};
