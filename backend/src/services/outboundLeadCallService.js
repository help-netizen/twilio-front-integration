/**
 * outboundLeadCallService.js — OUTBOUND-LEAD-CALL-001.
 *
 * Everything lead-call-specific lives here: the lead.created eligibility
 * gauntlet (enqueue), the pure business-window/ladder math, and (§5.3-5.6,
 * OLC-T4) the claim-time processing + retry ladder + dispatcher tasks the
 * shared dialer worker dispatches to for scenario='lead_call' rows.
 *
 * Design (architecture D-A/D-C): one dialer, two scenarios. The parts flow
 * (OUTBOUND-PARTS-CALL-001) is LIVE — this module never touches its guards,
 * settings, or retry math. The lead flavor deliberately has NO human-takeover
 * cancellation (owner decision D3): only goal-achieved and eligibility gates.
 *
 * SAFE-FAIL: onLeadCreated never throws (a failing gauntlet is logged and
 * dropped — the lead itself is untouched). Window helpers never throw and
 * never loop regardless of config garbage.
 *
 * Log prefix: [outboundLeadCall]; every skip/carry logs a machine-readable
 * reason (N-6).
 */

const db = require('../db/connection');
const leadsService = require('./leadsService');
const marketplaceService = require('./marketplaceService');
const outboundLeadCallSettingsService = require('./outboundLeadCallSettingsService');
const scheduleService = require('./scheduleService');

const APP_KEY = 'outbound-lead-caller';

// scheduleService's DEFAULT_DISPATCH_SETTINGS is module-private — mirror the
// window-relevant keys (sanitizeDispatchSettings would coerce to the same
// values from an empty object anyway; this keeps the intent explicit).
const FALLBACK_DISPATCH_SETTINGS = {
    timezone: 'America/New_York',
    work_start_time: '08:00',
    work_end_time: '18:00',
    work_days: [1, 2, 3, 4, 5],
};

// ── §5.1 Pure helpers (exported for jest — no DB, injectable now) ───────────

/**
 * E.164 or null. Mirrors createLead's normalization plus a validity gate:
 * 10 digits → +1…; 1+10 → +…; an explicit +international with 10-15 digits is
 * DIALABLE (placement failures feed the ladder, not the skip — E-2).
 */
function normalizeDialablePhone(raw) {
    const str = String(raw ?? '').trim();
    const digits = str.replace(/\D/g, '');
    if (digits.length === 10) return '+1' + digits;
    if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
    if (str.startsWith('+') && digits.length >= 10 && digits.length <= 15) return '+' + digits;
    return null;
}

const TIME_RE = /^\d{1,2}:\d{2}$/;

function parseMinutes(hhmm) {
    const [h, m] = String(hhmm).split(':').map(Number);
    return h * 60 + m;
}

/**
 * Sanitized copy of dispatch settings (never throws, never loops):
 * work_days → non-empty int 0-6 array else [1..5]; start/end must match
 * HH:MM with start < end (windows never cross midnight in v1) else
 * 08:00/18:00; timezone falsy → America/New_York.
 */
function sanitizeDispatchSettings(ds) {
    const src = ds && typeof ds === 'object' ? ds : {};
    let workDays = Array.isArray(src.work_days)
        ? src.work_days.filter(d => Number.isInteger(d) && d >= 0 && d <= 6)
        : [];
    if (workDays.length === 0) workDays = [1, 2, 3, 4, 5];

    let start = src.work_start_time;
    let end = src.work_end_time;
    const validShape = TIME_RE.test(String(start)) && TIME_RE.test(String(end));
    const validRange = validShape
        && parseMinutes(start) < parseMinutes(end)
        && parseMinutes(end) <= 24 * 60 && parseMinutes(start) >= 0
        && Number(String(start).split(':')[1]) < 60 && Number(String(end).split(':')[1]) < 60;
    if (!validRange) { start = '08:00'; end = '18:00'; }

    return {
        timezone: src.timezone || 'America/New_York',
        work_start_time: start,
        work_end_time: end,
        work_days: workDays,
    };
}

const WEEKDAY_TO_NUM = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Company-local wall clock probe of a UTC instant: { dow, minutes }. */
function localWallClock(date, timezone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(date);
    const get = (t) => (parts.find(p => p.type === t) || {}).value;
    const dow = WEEKDAY_TO_NUM[get('weekday')] ?? 1;
    // hour12:false may render 24 for midnight in some ICU versions — normalize.
    const hour = Number(get('hour')) % 24;
    const minute = Number(get('minute'));
    return { dow, minutes: hour * 60 + minute };
}

/**
 * True iff `now` is inside the company work window: local weekday enabled AND
 * start ≤ local < end (a dial must START strictly before work_end_time;
 * exactly at end = outside). D2/FR-4.
 */
function isWithinWorkWindow(now, ds) {
    const s = sanitizeDispatchSettings(ds);
    const { dow, minutes } = localWallClock(now, s.timezone);
    if (!s.work_days.includes(dow)) return false;
    return minutes >= parseMinutes(s.work_start_time) && minutes < parseMinutes(s.work_end_time);
}

/** Company-local calendar date (y/m/d) of a UTC instant. */
function localCalendarDate(date, timezone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date); // YYYY-MM-DD
    const [y, m, d] = parts.split('-').map(Number);
    return { y, m, d };
}

/**
 * Earliest work-window START strictly AFTER `from` — including "today at
 * work_start" when `from` is a workday before opening. DST-safe: the tz offset
 * is probed per target day via the shared worker helper. Pathological config
 * (no candidate in 14 days) → warn + from+24h hard fallback. SC-03/FR-4.
 */
function nextWindowStart(from, ds) {
    const s = sanitizeDispatchSettings(ds);
    // Lazy require: the worker requires this module back in its tick branch —
    // a top-level cross-require would cycle (architecture pins this direction).
    const { getTimezoneOffsetMs } = require('./outboundCallWorker');
    const [startHour, startMinute] = s.work_start_time.split(':').map(Number);
    const base = localCalendarDate(from, s.timezone);
    // UTC-midday date math avoids calendar-day drift near midnight/DST.
    const baseUtcNoon = Date.UTC(base.y, base.m - 1, base.d, 12, 0, 0);

    for (let dayOffset = 0; dayOffset <= 13; dayOffset++) {
        const probe = new Date(baseUtcNoon + dayOffset * 24 * 60 * 60 * 1000);
        const y = probe.getUTCFullYear();
        const m = probe.getUTCMonth() + 1;
        const d = probe.getUTCDate();
        // Weekday of that company-local calendar date (probe at local noon).
        const offsetAtNoon = getTimezoneOffsetMs(s.timezone, y, m, d, 12);
        const localNoonUtc = new Date(Date.UTC(y, m - 1, d, 12, 0, 0) - offsetAtNoon);
        const { dow } = localWallClock(localNoonUtc, s.timezone);
        if (!s.work_days.includes(dow)) continue;

        const offsetMs = getTimezoneOffsetMs(s.timezone, y, m, d, startHour);
        const candidate = new Date(
            Date.UTC(y, m - 1, d, startHour, startMinute, 0) - offsetMs
        );
        if (candidate.getTime() > from.getTime()) return candidate;
    }
    console.warn('[outboundLeadCall] nextWindowStart: no window inside 14 days — pathological dispatch config; falling back to +24h');
    return new Date(from.getTime() + 24 * 60 * 60 * 1000);
}

/** Identity inside the window; else the next window start. */
function clampIntoWorkWindow(date, ds) {
    return isWithinWorkWindow(date, ds) ? date : nextWindowStart(date, ds);
}

/**
 * Ladder math (FR-5/D1), mirroring the parts convention: backoff_schedule
 * [justFailedNo] is the NEXT attempt's token, 0-based (after attempt 1 →
 * index 1). 'immediate' → now; '+Nm'/'+Nh' → now+N; unknown/absent → now
 * (conservative — the claim-time window check still protects). Result is
 * ALWAYS clamped into the work window.
 */
function computeLeadNextDueAt(justFailedNo, settings, ds, now = new Date()) {
    const schedule = Array.isArray(settings?.backoff_schedule) ? settings.backoff_schedule : [];
    const token = schedule[justFailedNo];
    let target = now;
    if (typeof token === 'string' && token.toLowerCase() !== 'immediate') {
        const m = /^\+(\d+)(m|h)$/i.exec(token.trim());
        if (m) {
            const n = Number(m[1]);
            const unitMs = m[2].toLowerCase() === 'h' ? 3_600_000 : 60_000;
            target = new Date(now.getTime() + n * unitMs);
        }
    }
    return clampIntoWorkWindow(target, ds);
}

// ── §5.2 onLeadCreated — the eligibility gauntlet ────────────────────────────

function skip(leadId, companyId, reason) {
    console.log(`[outboundLeadCall] skip lead=${leadId} company=${companyId} reason=${reason}`);
}

/**
 * lead.created handler (via eventSubscribers). Cheapest-first gates; whole
 * body try/caught — a throw is logged, never propagates (N-2). Connect-time
 * gate doubles as the no-backfill rule (FR-14b): events observed while
 * disconnected simply never enqueue.
 */
async function onLeadCreated({ leadId, companyId }) {
    try {
        // 1. Connected gate (no lead read yet — cheapest first).
        const connected = await marketplaceService.isAppConnected(companyId, APP_KEY);
        if (!connected) return skip(leadId, companyId, 'app_not_connected');

        // 2. Row is the truth; the bus payload is only a hint.
        let lead;
        try {
            lead = await leadsService.getLeadById(leadId, companyId);
        } catch (err) {
            if (err && err.code === 'LEAD_NOT_FOUND') return skip(leadId, companyId, 'lead_not_found');
            throw err;
        }

        // 3. Source gate (silent — SC-06).
        const settings = await outboundLeadCallSettingsService.resolve(companyId);
        if (!outboundLeadCallSettingsService.isSourceEnabled(settings, lead.JobSource)) {
            return skip(leadId, companyId, 'source_not_enabled');
        }

        // 4. Dialable phone — the ONE skip that leaves a visible trace (FR-3/SC-05).
        const phone = normalizeDialablePhone(lead.Phone);
        if (!phone) {
            const trace = `[AI Phone] ${new Date().toISOString()} — Outbound call skipped — no phone number on the lead.`;
            try {
                await db.query(
                    `UPDATE leads
                     SET comments = COALESCE(NULLIF(comments, '') || E'\\n\\n', '') || $2
                     WHERE uuid = $1 AND company_id = $3`,
                    [lead.UUID, trace, companyId]
                );
            } catch (err) {
                console.warn('[outboundLeadCall] no-phone trace append failed:', err.message);
            }
            return skip(leadId, companyId, 'no_phone');
        }

        // 5. Goal achieved at birth (e.g. Sara's own createLead with a hold).
        const status = String(lead.Status || '').toUpperCase();
        if (lead.LeadDateTime || status === 'LOST' || status === 'CONVERTED') {
            return skip(leadId, companyId, 'goal_achieved_at_birth');
        }

        // 6. Lifetime-once (FR-14c): ANY prior chain — even a finished one —
        // means this lead was already worked; re-enable never re-dials.
        const { rows: existing } = await db.query(
            `SELECT 1 FROM outbound_call_attempts WHERE lead_uuid = $1 LIMIT 1`,
            [lead.UUID]
        );
        if (existing.length > 0) return skip(leadId, companyId, 'chain_exists');

        // 7. Enqueue — due now, clamped into the business window (D2).
        let ds;
        try {
            ds = await scheduleService.getDispatchSettings(companyId);
        } catch {
            ds = { ...FALLBACK_DISPATCH_SETTINGS };
        }
        const dueAt = clampIntoWorkWindow(new Date(), ds);
        await db.query(
            `INSERT INTO outbound_call_attempts
                 (company_id, lead_uuid, scenario, contact_id, phone, attempt_no, status, scheduled_at)
             VALUES ($1, $2, 'lead_call', $3, $4, 1, 'pending', $5)
             ON CONFLICT (lead_uuid) WHERE status IN ('pending', 'dialing') DO NOTHING`,
            [companyId, lead.UUID, lead.ContactId || null, phone, dueAt]
        );
        console.log(`[outboundLeadCall] enqueued lead=${lead.UUID} due_at=${dueAt.toISOString()}`);
    } catch (err) {
        console.warn('[outboundLeadCall] onLeadCreated failed:', err && err.message);
    }
}

module.exports = {
    APP_KEY,
    // §5.1 pure helpers (jest)
    normalizeDialablePhone,
    sanitizeDispatchSettings,
    isWithinWorkWindow,
    nextWindowStart,
    clampIntoWorkWindow,
    computeLeadNextDueAt,
    // §5.2
    onLeadCreated,
};
