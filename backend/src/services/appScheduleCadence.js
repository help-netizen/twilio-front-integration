'use strict';

const { appRuntimeError } = require('./appRuntimeErrors');
const {
    dateInTZ,
    localDateTimeParts,
    normalizeCompanyTimezone,
} = require('../utils/companyTime');

const DAYS_PER_MONTH = 365 / 12;
const MINUTES_PER_DAY = 24 * 60;
const DEFAULT_MAX_DATA_READS_PER_RUN = 5;
const DEFAULT_MAX_COMPUTE_MS_PER_RUN = 12000;

function invalidCadence() {
    return appRuntimeError(
        'INVALID_CADENCE',
        'Schedule cadence is invalid.',
        422
    );
}

function exactKeys(value, keys) {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length
        && actual.every((key, index) => key === expected[index]);
}

function validTime(value) {
    return typeof value === 'string'
        && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function validateCadence(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || typeof value.kind !== 'string') {
        throw invalidCadence();
    }
    if (value.kind === 'every_minutes'
        && exactKeys(value, ['kind', 'n'])
        && Number.isInteger(value.n)
        && value.n >= 1
        && value.n <= MINUTES_PER_DAY) {
        return { kind: value.kind, n: value.n };
    }
    if (value.kind === 'hourly'
        && exactKeys(value, ['kind', 'minute'])
        && Number.isInteger(value.minute)
        && value.minute >= 0
        && value.minute <= 59) {
        return { kind: value.kind, minute: value.minute };
    }
    if (value.kind === 'daily'
        && exactKeys(value, ['kind', 'at'])
        && validTime(value.at)) {
        return { kind: value.kind, at: value.at };
    }
    if (value.kind === 'weekly'
        && exactKeys(value, ['kind', 'dow', 'at'])
        && Number.isInteger(value.dow)
        && value.dow >= 0
        && value.dow <= 6
        && validTime(value.at)) {
        return { kind: value.kind, dow: value.dow, at: value.at };
    }
    if (value.kind === 'monthly'
        && exactKeys(value, ['kind', 'dom', 'at'])
        && Number.isInteger(value.dom)
        && value.dom >= 1
        && value.dom <= 31
        && validTime(value.at)) {
        return { kind: value.kind, dom: value.dom, at: value.at };
    }
    throw invalidCadence();
}

function parseTime(value) {
    return value.split(':').map(Number);
}

function localCandidate({ year, month, day }, at, timezone) {
    const [hour, minute] = parseTime(at);
    return dateInTZ(year, month, day, hour, minute, timezone);
}

function shiftedLocalDate(parts, days) {
    const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
    return {
        year: shifted.getUTCFullYear(),
        month: shifted.getUTCMonth() + 1,
        day: shifted.getUTCDate(),
    };
}

function nextHourly(minute, from, timezone) {
    let candidateMs = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000;
    for (let checked = 0; checked < 180; checked += 1) {
        const candidate = new Date(candidateMs);
        if (localDateTimeParts(candidate, timezone).minute === minute) return candidate;
        candidateMs += 60_000;
    }
    throw invalidCadence();
}

function nextDaily(cadence, from, timezone) {
    const today = localDateTimeParts(from, timezone);
    let candidate = localCandidate(today, cadence.at, timezone);
    if (candidate.getTime() <= from.getTime()) {
        candidate = localCandidate(shiftedLocalDate(today, 1), cadence.at, timezone);
    }
    return candidate;
}

function nextWeekly(cadence, from, timezone) {
    const today = localDateTimeParts(from, timezone);
    const todayDow = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
    let daysAhead = (cadence.dow - todayDow + 7) % 7;
    let target = shiftedLocalDate(today, daysAhead);
    let candidate = localCandidate(target, cadence.at, timezone);
    if (candidate.getTime() <= from.getTime()) {
        daysAhead += 7;
        target = shiftedLocalDate(today, daysAhead);
        candidate = localCandidate(target, cadence.at, timezone);
    }
    return candidate;
}

function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function monthTarget(year, month, dom) {
    const normalized = new Date(Date.UTC(year, month - 1, 1));
    const targetYear = normalized.getUTCFullYear();
    const targetMonth = normalized.getUTCMonth() + 1;
    return {
        year: targetYear,
        month: targetMonth,
        day: Math.min(dom, daysInMonth(targetYear, targetMonth)),
    };
}

function nextMonthly(cadence, from, timezone) {
    const today = localDateTimeParts(from, timezone);
    let target = monthTarget(today.year, today.month, cadence.dom);
    let candidate = localCandidate(target, cadence.at, timezone);
    if (candidate.getTime() <= from.getTime()) {
        target = monthTarget(today.year, today.month + 1, cadence.dom);
        candidate = localCandidate(target, cadence.at, timezone);
    }
    return candidate;
}

function nextRunAt(value, companyTimezone, fromValue = new Date()) {
    const cadence = validateCadence(value);
    const timezone = normalizeCompanyTimezone(companyTimezone);
    const from = fromValue instanceof Date ? fromValue : new Date(fromValue);
    if (!Number.isFinite(from.getTime())) throw invalidCadence();

    if (cadence.kind === 'every_minutes') {
        const intervalMs = cadence.n * 60_000;
        return new Date(Math.floor(from.getTime() / intervalMs) * intervalMs + intervalMs);
    }
    if (cadence.kind === 'hourly') {
        return nextHourly(cadence.minute, from, timezone);
    }
    if (cadence.kind === 'daily') return nextDaily(cadence, from, timezone);
    if (cadence.kind === 'weekly') return nextWeekly(cadence, from, timezone);
    return nextMonthly(cadence, from, timezone);
}

function rounded(value) {
    return Number(value.toFixed(3));
}

function forecastCost(value, limits = {}) {
    const cadence = validateCadence(value);
    let runsPerDay;
    let runsPerMonth;
    if (cadence.kind === 'every_minutes') {
        runsPerDay = MINUTES_PER_DAY / cadence.n;
        runsPerMonth = runsPerDay * DAYS_PER_MONTH;
    } else if (cadence.kind === 'hourly') {
        runsPerDay = 24;
        runsPerMonth = 24 * DAYS_PER_MONTH;
    } else if (cadence.kind === 'daily') {
        runsPerDay = 1;
        runsPerMonth = DAYS_PER_MONTH;
    } else if (cadence.kind === 'weekly') {
        runsPerDay = 1 / 7;
        runsPerMonth = DAYS_PER_MONTH / 7;
    } else {
        runsPerDay = 12 / 365;
        runsPerMonth = 1;
    }

    const maxDataReadsPerRun = Number(limits.maxDataReadsPerRun)
        || DEFAULT_MAX_DATA_READS_PER_RUN;
    const maxComputeMsPerRun = Number(limits.maxComputeMsPerRun)
        || DEFAULT_MAX_COMPUTE_MS_PER_RUN;
    const dailyRunLimit = Number(limits.dailyRunLimit) || null;
    const dailyComputeLimitMs = Number(limits.dailyComputeLimitMs) || null;
    const dailyDataReadLimit = Number(limits.dailyDataReadLimit) || null;
    const warnings = [];
    if (dailyRunLimit && runsPerDay > dailyRunLimit) {
        warnings.push('This cadence can reach the daily run limit before the local day ends.');
    }
    if (dailyComputeLimitMs && runsPerDay * maxComputeMsPerRun > dailyComputeLimitMs) {
        warnings.push('Maximum projected compute time exceeds the daily compute limit.');
    }
    if (dailyDataReadLimit && runsPerDay * maxDataReadsPerRun > dailyDataReadLimit) {
        warnings.push('Maximum projected data reads exceed the daily data-read limit.');
    }
    return {
        runs_per_day: rounded(runsPerDay),
        runs_per_month: rounded(runsPerMonth),
        maximum_data_reads_per_month: Math.ceil(runsPerMonth * maxDataReadsPerRun),
        maximum_compute_ms_per_day: Math.ceil(runsPerDay * maxComputeMsPerRun),
        assumptions: {
            average_days_per_month: rounded(DAYS_PER_MONTH),
            maximum_data_reads_per_run: maxDataReadsPerRun,
            maximum_compute_ms_per_run: maxComputeMsPerRun,
        },
        limits: {
            daily_runs: dailyRunLimit,
            daily_data_reads: dailyDataReadLimit,
            daily_compute_ms: dailyComputeLimitMs,
        },
        warnings,
    };
}

module.exports = {
    DAYS_PER_MONTH,
    DEFAULT_MAX_COMPUTE_MS_PER_RUN,
    DEFAULT_MAX_DATA_READS_PER_RUN,
    forecastCost,
    nextRunAt,
    validateCadence,
};
