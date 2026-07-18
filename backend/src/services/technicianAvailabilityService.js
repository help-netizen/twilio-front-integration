/**
 * Single effective-unavailability seam for TECH-SCHEDULE-001.
 * Explicit technician_time_off rows are read as-is; recurring schedule gaps
 * are derived for the requested company-local dates and are never persisted.
 */
const timeOffQueries = require('../db/timeOffQueries');
const membershipQueries = require('../db/membershipQueries');
const technicianRosterService = require('./technicianRosterService');
const technicianWorkScheduleService = require('./technicianWorkScheduleService');
const { dateInTZ } = require('../utils/companyTime');

class TechnicianAvailabilityError extends Error {
    constructor(code, message, httpStatus = 500) {
        super(message);
        this.name = 'TechnicianAvailabilityError';
        this.code = code;
        this.httpStatus = httpStatus;
    }
}

function parseRange(from, to) {
    const start = typeof from === 'string' ? new Date(from) : null;
    const end = typeof to === 'string' ? new Date(to) : null;
    if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        throw new TechnicianAvailabilityError(
            'VALIDATION',
            'from and to are required and must be valid ISO timestamps',
            400
        );
    }
    if (start.getTime() >= end.getTime()) {
        throw new TechnicianAvailabilityError('VALIDATION', 'from must be before to', 400);
    }
    return { start, end };
}

function localDateKey(instant, timezone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(instant);
    const value = type => parts.find(part => part.type === type)?.value;
    return `${value('year')}-${value('month')}-${value('day')}`;
}

function addLocalDays(dateKey, count) {
    const [year, month, day] = dateKey.split('-').map(Number);
    const next = new Date(Date.UTC(year, month - 1, day + count));
    return next.toISOString().slice(0, 10);
}

function localInstant(dateKey, hhmm, timezone) {
    const [year, month, day] = dateKey.split('-').map(Number);
    const [hour, minute] = hhmm.split(':').map(Number);
    return dateInTZ(year, month, day, hour, minute, timezone);
}

function dayOfWeek(dateKey) {
    return new Date(`${dateKey}T00:00:00.000Z`).getUTCDay();
}

function scheduleGap(technician, dateKey, edge, startsAt, endsAt, source) {
    return {
        id: `schedule:${technician.id}:${dateKey}:${edge}`,
        kind: 'schedule_gap',
        technician_id: String(technician.id),
        technician_name: technician.name || String(technician.id),
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        note: null,
        source,
        mutable: false,
    };
}

function deriveScheduleGaps(technicians, resolved, fromDate, toDate) {
    const timezone = resolved.company_schedule.timezone;
    const resolvedByTech = new Map(resolved.technicians.map(item => [String(item.technician_id), item]));
    const gaps = [];
    const firstDate = localDateKey(fromDate, timezone);

    for (const technician of technicians) {
        const schedule = resolvedByTech.get(String(technician.id));
        if (!schedule) continue;
        const byWeekday = new Map(schedule.effective_week.map(day => [day.day_of_week, day]));

        for (let dateKey = firstDate; ; dateKey = addLocalDays(dateKey, 1)) {
            const dayStart = localInstant(dateKey, '00:00', timezone);
            if (dayStart >= toDate) break;
            const nextDate = addLocalDays(dateKey, 1);
            const dayEnd = localInstant(nextDate, '00:00', timezone);
            if (dayEnd <= fromDate) continue;

            const effectiveDay = byWeekday.get(dayOfWeek(dateKey));
            if (!effectiveDay?.is_working) {
                gaps.push(scheduleGap(
                    technician,
                    dateKey,
                    'full',
                    dayStart,
                    dayEnd,
                    effectiveDay?.source || 'company'
                ));
                continue;
            }

            const workStart = localInstant(dateKey, effectiveDay.work_start_time, timezone);
            const workEnd = localInstant(dateKey, effectiveDay.work_end_time, timezone);
            if (dayStart < workStart && workStart > fromDate && dayStart < toDate) {
                gaps.push(scheduleGap(
                    technician,
                    dateKey,
                    'before',
                    dayStart,
                    workStart,
                    effectiveDay.source || 'company'
                ));
            }
            if (workEnd < dayEnd && dayEnd > fromDate && workEnd < toDate) {
                gaps.push(scheduleGap(
                    technician,
                    dateKey,
                    'after',
                    workEnd,
                    dayEnd,
                    effectiveDay.source || 'company'
                ));
            }
        }
    }
    return gaps;
}

/**
 * Build combined blocks for a known, company-scoped active roster. Slot-engine
 * callers pass their already-built roster so no second Zenbooker read occurs.
 */
async function buildUnavailability(companyId, { from, to, technicians }) {
    const { start, end } = parseRange(from, to);
    const activeTechnicians = (technicians || []).map(technician => ({
        id: String(technician.id),
        name: technician.name || String(technician.id),
    }));

    const [explicitRows, resolved] = await Promise.all([
        timeOffQueries.listOverlappingRange(companyId, start.toISOString(), end.toISOString()),
        technicianWorkScheduleService.listEffective(companyId, activeTechnicians),
    ]);
    const activeIds = new Set(activeTechnicians.map(technician => technician.id));
    const rosterNames = new Map(activeTechnicians.map(technician => [technician.id, technician.name]));
    const explicit = (explicitRows || [])
        .filter(row => activeIds.has(String(row.technician_id)))
        .map(row => ({
            id: String(row.id),
            kind: 'time_off',
            technician_id: String(row.technician_id),
            technician_name: row.technician_name || rosterNames.get(String(row.technician_id)) || String(row.technician_id),
            starts_at: row.starts_at?.toISOString ? row.starts_at.toISOString() : String(row.starts_at),
            ends_at: row.ends_at?.toISOString ? row.ends_at.toISOString() : String(row.ends_at),
            note: row.note ?? null,
            source: row.source === 'company' ? 'company' : 'individual',
            mutable: true,
            batch_id: row.batch_id ?? null,
            created_at: row.created_at?.toISOString ? row.created_at.toISOString() : row.created_at,
        }));
    const derived = deriveScheduleGaps(activeTechnicians, resolved, start, end);
    return [...explicit, ...derived].sort((a, b) =>
        a.starts_at.localeCompare(b.starts_at) || a.technician_id.localeCompare(b.technician_id));
}

async function listUnavailability(companyId, { from, to, technicianId } = {}, providerScope = {}) {
    parseRange(from, to);
    let effectiveTechnicianId = technicianId ? String(technicianId) : null;
    if (providerScope?.assignedOnly) {
        if (!providerScope.userId) return [];
        const ownId = await membershipQueries.getZenbookerTeamMemberIdForUser(companyId, providerScope.userId);
        if (!ownId) return [];
        effectiveTechnicianId = String(ownId);
    }

    let roster = await technicianRosterService.listActive(companyId);
    if (effectiveTechnicianId) {
        roster = roster.filter(technician => technician.id === effectiveTechnicianId);
    }
    return buildUnavailability(companyId, { from, to, technicians: roster });
}

module.exports = {
    listUnavailability,
    buildUnavailability,
    TechnicianAvailabilityError,
    _deriveScheduleGaps: deriveScheduleGaps,
};
