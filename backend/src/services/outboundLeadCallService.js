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

/**
 * Parse the appliance context a lead carries so the agent can reference it
 * specifically ("your Samsung refrigerator that isn't cooling") instead of a
 * generic "your appliance" — the owner's trust/naturalness ask.
 *
 * Real prod leads store this two ways, both handled:
 *  - job_type: "Refrigerator Repair" → unit type "Refrigerator".
 *  - comments: pipe-delimited "Unit: Refrigerator | Brand: Samsung | Age: 5
 *    years | Problem: not cooling | Fee agreed: Yes | …" (lead-generator ingest).
 * Free-text lead_notes is the fallback problem when nothing structured is found.
 * Pure; never throws; placeholder values ("unknown"/"n/a") are dropped.
 */
function parseLeadContext(lead) {
    const out = { applianceType: null, applianceBrand: null, applianceProblem: null };
    const clean = (v) => {
        const s = String(v ?? '').trim();
        if (!s || /^(unknown|n\/?a|none|-|\?)$/i.test(s)) return null;
        return s;
    };

    // job_type ("<Unit> Repair/Service/Install") → unit type.
    if (lead.JobType) {
        out.applianceType = clean(String(lead.JobType).replace(/\s*(repair|service|maintenance|install(ation)?)\s*$/i, ''));
    }

    // Structured pipe-delimited comments — "Key: Value | Key: Value".
    const text = String(lead.Comments || '');
    const field = (...keys) => {
        for (const k of keys) {
            const m = new RegExp(`(?:^|\\|)\\s*${k}\\s*:\\s*([^|]+)`, 'i').exec(text);
            if (m) { const v = clean(m[1]); if (v) return v; }
        }
        return null;
    };
    out.applianceType = field('Unit', 'Appliance', 'Type') || out.applianceType;
    out.applianceBrand = field('Brand', 'Make', 'Manufacturer');
    out.applianceProblem = field('Problem', 'Issue', 'Symptom', 'Concern');

    // No structured problem? Use free-text lead_notes as the reported issue.
    if (!out.applianceProblem) out.applianceProblem = clean(lead.Description);

    return out;
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

// ── §5.3-5.6 Claim-time processing, ladder, webhook classification, tasks ────
// (OLC-T4/T5.) Heavy collaborators are lazy-required inside the functions:
// outboundCallService / vapiCallTimelineService / recommendSlots / timelines-
// Queries / eventService / companyProfileService — keeps unit tests light and
// avoids any chance of require cycles through the worker.

/** Same 3-line terminal UPDATE as the worker's private terminate — local copy. */
async function terminateLead(attemptId, status, reason) {
    await db.query(
        `UPDATE outbound_call_attempts
         SET status = $2, reason = $3, updated_at = now()
         WHERE id = $1`,
        [attemptId, status, String(reason || '').slice(0, 120)]
    );
    console.log(`[outboundLeadCall] terminated attempt=${attemptId} status=${status} reason=${reason}`);
}

const IGNORE_HOURS_RE = /^(1|true|yes|on)$/i;

/**
 * §5.3 — claim-time processing for a scenario='lead_call' row (worker Touch-1
 * dispatches here). Company scope always from the attempt row.
 */
async function processLeadAttempt(attempt) {
    const companyId = attempt.company_id;
    const now = new Date();

    // 1. Lead re-read (FK CASCADE usually beat us to deleted leads; belt).
    let lead;
    try {
        lead = await leadsService.getLeadByUUID(attempt.lead_uuid, companyId);
    } catch (err) {
        if (err && err.code === 'LEAD_NOT_FOUND') {
            return terminateLead(attempt.id, 'canceled', 'lead_not_found');
        }
        throw err; // worker catch → 'failed' worker_error (audited)
    }

    // 2. Goal-achieved skip (FR-6/D3 — NOT a takeover guard).
    const status = String(lead.Status || '').toUpperCase();
    if (lead.LeadDateTime) {
        return terminateLead(attempt.id, 'canceled', 'goal_achieved:hold_set');
    }
    if (status === 'LOST' || status === 'CONVERTED') {
        return terminateLead(attempt.id, 'canceled', `goal_achieved:closed_${status.toLowerCase()}`);
    }

    // 3. Eligibility re-check (FR-15): disconnect/source-off stops queued work
    // at the next tick without any queue-purge code.
    const connected = await marketplaceService.isAppConnected(companyId, APP_KEY);
    if (!connected) return terminateLead(attempt.id, 'canceled', 'app_disconnected');
    const settings = await outboundLeadCallSettingsService.resolve(companyId);
    if (!outboundLeadCallSettingsService.isSourceEnabled(settings, lead.JobSource)) {
        return terminateLead(attempt.id, 'canceled', 'source_disabled');
    }

    // 4. Business window (FR-4/D2) — carry, never drop. Test toggle honored
    // (same regex as the parts worker).
    let ds;
    try {
        ds = await scheduleService.getDispatchSettings(companyId);
    } catch {
        ds = { ...FALLBACK_DISPATCH_SETTINGS };
    }
    const ignoreHours = IGNORE_HOURS_RE.test(process.env.OUTBOUND_CALL_IGNORE_BUSINESS_HOURS || '');
    if (!ignoreHours && !isWithinWorkWindow(now, ds)) {
        const carryTo = nextWindowStart(now, ds);
        await db.query(
            `UPDATE outbound_call_attempts
             SET status = 'pending', scheduled_at = $2, updated_at = now()
             WHERE id = $1`,
            [attempt.id, carryTo]
        );
        console.log(`[outboundLeadCall] carried attempt=${attempt.id} to=${carryTo.toISOString()}`);
        return;
    }

    // 5. Slot pre-compute (FR-9 — never dial empty-handed). recommendSlots
    // safe-fails to {available:false, fallback:true} and gates on the
    // smart-slot-engine app itself — the gate is never bypassed here.
    const zip = lead.PostalCode || undefined;
    // Number(null) is 0 — a lead without geocode must NOT become lat/lng 0,0.
    const lat = lead.Latitude != null && lead.Latitude !== '' ? Number(lead.Latitude) : NaN;
    const lng = lead.Longitude != null && lead.Longitude !== '' ? Number(lead.Longitude) : NaN;
    const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);
    const address = lead.Address
        ? [lead.Address, lead.City, lead.State].filter(Boolean).join(', ')
        : undefined;

    let topSlot = null;
    try {
        const recommendSlots = require('./agentSkills/skills/recommendSlots');
        const recs = await recommendSlots.run(companyId, {}, {
            zip,
            ...(hasCoords ? { lat, lng } : {}),
            address,
        });
        if (recs && recs.available && !recs.fallback && Array.isArray(recs.slots) && recs.slots.length > 0) {
            topSlot = recs.slots[0];
        }
    } catch (err) {
        console.warn('[outboundLeadCall] recommendSlots failed:', err.message);
    }
    if (!topSlot) {
        await scheduleLeadRetryOrExhaust(attempt, 'no_slots', 'failed');
        return;
    }

    // 6. Place the call.
    const customerName = [lead.FirstName, lead.LastName].filter(Boolean).join(' ') || 'there';
    // Structured appliance context so the agent confirms the SPECIFIC job
    // ("your Samsung refrigerator that isn't cooling — is that right?") before
    // scheduling — reads human, not robotic (owner's trust ask).
    const ctx = parseLeadContext(lead);
    const applianceType = ctx.applianceType ? ctx.applianceType.slice(0, 60) : undefined;
    const applianceBrand = ctx.applianceBrand ? ctx.applianceBrand.slice(0, 40) : undefined;
    const applianceProblem = ctx.applianceProblem ? ctx.applianceProblem.slice(0, 120) : undefined;

    // The greeting is owned by the DEDICATED lead-booking VAPI assistant (its
    // own static firstMessage + prompt — see VAPI_LEAD_CALL_ASSISTANT_ID). We no
    // longer compose a per-call firstMessage from the company profile name: that
    // pulled the legal name ("… LLC") and, on the shared parts assistant, let the
    // model drift into the part-arrival script. The dedicated assistant carries
    // the correct spoken brand name and a lead-only prompt.

    // lat/lng ride on the slot object → reuses placeCall's TECHSLOT spread.
    const slot = { ...topSlot, ...(hasCoords ? { lat, lng } : {}) };

    const outboundCallService = require('./outboundCallService');
    const result = await outboundCallService.placeCall({
        companyId,
        scenario: 'lead_call',
        leadUuid: attempt.lead_uuid,
        contactId: attempt.contact_id || undefined,
        customerName,
        customerNumber: attempt.phone,
        slot,
        zip,
        applianceType,
        applianceBrand,
        applianceProblem,
        source: lead.JobSource || undefined,
    });

    if (result.ok) {
        await db.query(
            `UPDATE outbound_call_attempts
             SET vapi_call_id = $2, slot_json = $3, updated_at = now()
             WHERE id = $1`,
            [attempt.id, result.vapiCallId, JSON.stringify(topSlot)]
        );
        try {
            const vapiCallTimelineService = require('./vapiCallTimelineService');
            await vapiCallTimelineService.recordPlacement({
                attempt,
                vapiCallId: result.vapiCallId,
                dialedNumber: attempt.phone,
                callerId: process.env.VAPI_OUTBOUND_TWILIO_NUMBER || process.env.OUTBOUND_CALLER_ID || null,
            });
        } catch (err) {
            console.warn('[outboundLeadCall] timeline placement mirror failed:', err.message);
        }
        console.log(`[outboundLeadCall] dialed attempt=${attempt.id} lead=${attempt.lead_uuid} vapi=${result.vapiCallId}`);
    } else {
        await scheduleLeadRetryOrExhaust(attempt, result.error || 'place_call_failed', 'failed');
    }
}

/**
 * §5.4 — the ONE ladder site (worker failures AND webhook transients).
 * Marks the attempt terminal, re-checks goal/eligibility ONLY (D3 — no
 * human-takeover guard), then inserts the next rung or exhausts + task.
 */
async function scheduleLeadRetryOrExhaust(attempt, reason, klass = 'failed') {
    const companyId = attempt.company_id;
    const eventService = require('./eventService');

    // 1. Honest-terminal mark frees the (lead_uuid) active guard.
    await db.query(
        `UPDATE outbound_call_attempts
         SET status = $2, reason = $3, updated_at = now()
         WHERE id = $1`,
        [attempt.id, klass, String(reason || '').slice(0, 120)]
    );

    // 2. No-resurrection re-check (goal + eligibility only; fail-open).
    let lead = null;
    let blockedBy = null;
    try {
        try {
            lead = await leadsService.getLeadByUUID(attempt.lead_uuid, companyId);
        } catch (err) {
            if (err && err.code === 'LEAD_NOT_FOUND') blockedBy = 'lead_not_found';
            else throw err;
        }
        if (!blockedBy && lead) {
            const status = String(lead.Status || '').toUpperCase();
            if (lead.LeadDateTime) blockedBy = 'goal_achieved';
            else if (status === 'LOST' || status === 'CONVERTED') blockedBy = 'goal_achieved';
            else if (!(await marketplaceService.isAppConnected(companyId, APP_KEY))) blockedBy = 'app_disconnected';
            else {
                const settings = await outboundLeadCallSettingsService.resolve(companyId);
                if (!outboundLeadCallSettingsService.isSourceEnabled(settings, lead.JobSource)) {
                    blockedBy = 'source_disabled';
                }
            }
        }
    } catch (err) {
        console.warn('[outboundLeadCall] retry re-check failed (fail-open):', err.message);
    }
    if (blockedBy) {
        try {
            eventService.logEvent(companyId, 'lead', attempt.lead_uuid, 'outbound_lead_call_retry_skipped',
                { attemptNo: attempt.attempt_no, outcome: klass, blockedBy }, 'system');
        } catch { /* non-fatal */ }
        console.log(`[outboundLeadCall] retry blocked attempt=${attempt.id} by=${blockedBy}`);
        return;
    }

    const settings = await outboundLeadCallSettingsService.resolve(companyId);
    const maxAttempts = settings.max_attempts || 3;

    if (attempt.attempt_no < maxAttempts) {
        // 3. Next rung — fresh slot at claim (slot_json deliberately not copied).
        let ds;
        try {
            ds = await scheduleService.getDispatchSettings(companyId);
        } catch {
            ds = { ...FALLBACK_DISPATCH_SETTINGS };
        }
        const nextAt = computeLeadNextDueAt(attempt.attempt_no, settings, ds, new Date());
        await db.query(
            `INSERT INTO outbound_call_attempts
                 (company_id, lead_uuid, scenario, contact_id, phone, attempt_no, status, scheduled_at)
             VALUES ($1, $2, 'lead_call', $3, $4, $5, 'pending', $6)`,
            [companyId, attempt.lead_uuid, attempt.contact_id || null, attempt.phone, attempt.attempt_no + 1, nextAt]
        );
        try {
            eventService.logEvent(companyId, 'lead', attempt.lead_uuid, 'outbound_lead_call_retry',
                { attemptNo: attempt.attempt_no, nextScheduledAt: nextAt.toISOString(), outcome: klass }, 'system');
        } catch { /* non-fatal */ }
        console.log(`[outboundLeadCall] retry scheduled lead=${attempt.lead_uuid} attempt=${attempt.attempt_no + 1} at=${nextAt.toISOString()}`);
    } else {
        // 4. Exhaustion (FR-12): terminal marker row + dispatcher task.
        await db.query(
            `INSERT INTO outbound_call_attempts
                 (company_id, lead_uuid, scenario, contact_id, phone, attempt_no, status, scheduled_at, reason)
             VALUES ($1, $2, 'lead_call', $3, $4, $5, 'exhausted', now(), 'max_attempts_reached')`,
            [companyId, attempt.lead_uuid, attempt.contact_id || null, attempt.phone, attempt.attempt_no]
        );
        await createLeadCallTask(companyId, lead, attempt, 'exhausted', { finalReason: String(reason || '') });
        try {
            eventService.logEvent(companyId, 'lead', attempt.lead_uuid, 'outbound_lead_call_exhausted',
                { attempts: maxAttempts }, 'system');
        } catch { /* non-fatal */ }
        console.log(`[outboundLeadCall] exhausted lead=${attempt.lead_uuid} after=${attempt.attempt_no}`);
    }
}

/**
 * §5.5 — end-of-call classification for lead attempts (called from the VAPI
 * webhook AFTER the shared timeline finalize + terminal-idempotence no-op).
 * Safe-fail by contract.
 */
async function handleLeadEndOfCall(attempt, klass, endedReason, message) {
    try {
        const companyId = attempt.company_id;
        const eventService = require('./eventService');

        // 1. Booked belt: the hold is the truth even if the mid-call flip failed.
        let lead = null;
        try {
            lead = await leadsService.getLeadByUUID(attempt.lead_uuid, companyId);
        } catch { /* fall through to classification */ }
        if (lead && lead.LeadDateTime) {
            await db.query(
                `UPDATE outbound_call_attempts SET status = 'booked', updated_at = now() WHERE id = $1`,
                [attempt.id]
            );
            console.log(`[outboundLeadCall] booked (belt) attempt=${attempt.id} lead=${attempt.lead_uuid}`);
            return;
        }

        // 2. Declined — a human said no; terminal, dispatcher follows up (FR-11).
        const outcome = message && message.analysis && message.analysis.structuredData
            && message.analysis.structuredData.outcome;
        if (klass === 'declined' || outcome === 'declined' || outcome === 'callback') {
            await db.query(
                `UPDATE outbound_call_attempts SET status = 'declined', reason = $2, updated_at = now() WHERE id = $1`,
                [attempt.id, String(endedReason || outcome || 'declined').slice(0, 120)]
            );
            await createLeadCallTask(companyId, lead, attempt, 'declined', {
                summary: message && message.analysis && message.analysis.summary,
            });
            try {
                eventService.logEvent(companyId, 'lead', attempt.lead_uuid, 'outbound_lead_call_declined',
                    { attemptNo: attempt.attempt_no, outcome: outcome || klass }, 'system');
            } catch { /* non-fatal */ }
            return;
        }

        // 3. Transient (no_answer / voicemail / failed) → the ladder.
        await scheduleLeadRetryOrExhaust(attempt, String(endedReason || klass), klass);
    } catch (err) {
        console.warn('[outboundLeadCall] handleLeadEndOfCall failed:', err && err.message);
    }
}

/**
 * §5.6 — dispatcher task (FR-12/SC-08), Yelp createYelpCallTask precedent:
 * lead-bound AND Pulse-AR-visible; createdBy 'agent' with NO agentStatus (the
 * agentWorker never claims it). Non-fatal by contract.
 */
async function createLeadCallTask(companyId, lead, attempt, kind, extra = {}) {
    try {
        const timelinesQueries = require('../db/timelinesQueries');
        const leadClientId = lead && lead.ClientId ? lead.ClientId : null;

        // Exactly-once belt per chain. NOTE (spec deviation from architecture,
        // flagged there): the belt matches subject_type/subject_id — the columns
        // timelinesQueries.createTask actually writes (tasks.lead_id is only
        // populated by the /api/tasks parent path).
        if (leadClientId) {
            const { rows } = await db.query(
                `SELECT 1 FROM tasks
                 WHERE company_id = $1 AND subject_type = 'lead' AND subject_id = $2
                   AND agent_type = 'outbound_lead_call' AND status = 'open'
                 LIMIT 1`,
                [companyId, leadClientId]
            );
            if (rows.length > 0) {
                console.log(`[outboundLeadCall] task_exists lead=${attempt.lead_uuid}`);
                return;
            }
        }

        const timeline = await timelinesQueries.findOrCreateTimeline(attempt.phone, companyId);
        const name = lead
            ? ([lead.FirstName, lead.LastName].filter(Boolean).join(' ') || 'the lead')
            : 'the lead';
        const n = attempt.attempt_no;
        const sourceLabel = (lead && lead.JobSource) || '';

        let title;
        let description;
        if (kind === 'declined') {
            title = `${name} answered but didn't book — follow up`;
            description = `Sara reached the customer on this ${sourceLabel} lead but they didn't pick a time.`
                + (extra.summary ? `\n\nCall summary: ${extra.summary}` : '')
                + `\n\nPlease follow up personally.`;
        } else {
            // exhausted — per-attempt log lines from the chain.
            let lines = '';
            try {
                const { rows } = await db.query(
                    `SELECT attempt_no, status, reason, updated_at
                     FROM outbound_call_attempts
                     WHERE lead_uuid = $1 AND company_id = $2
                       AND status NOT IN ('pending', 'dialing', 'exhausted')
                     ORDER BY attempt_no, id`,
                    [attempt.lead_uuid, companyId]
                );
                lines = rows.map(r =>
                    `Attempt ${r.attempt_no}: ${r.status}${r.reason ? ` (${r.reason})` : ''} — ${new Date(r.updated_at).toISOString()}`
                ).join('\n');
            } catch { /* attempt log is best-effort */ }

            if (extra.finalReason === 'no_slots') {
                title = `Couldn't offer ${name} a time — appointment slots unavailable (${n} attempts)`;
                description = `Sara couldn't compute appointment slots for this lead (slot engine unavailable or no windows for the lead's location), so no call could offer a time.`
                    + (lines ? `\n\n${lines}` : '')
                    + `\n\nPlease schedule manually.`;
            } else {
                title = `Couldn't reach ${name} — ${n} automated call attempts`;
                description = `Sara tried to call this ${sourceLabel} lead but couldn't reach them.`
                    + (lines ? `\n\n${lines}` : '')
                    + `\n\nPlease follow up and book the appointment.`;
            }
        }

        await timelinesQueries.createTask({
            companyId,
            threadId: timeline.id,
            subjectType: 'lead',
            subjectId: leadClientId,
            title,
            description,
            priority: 'p1',
            createdBy: 'agent',
            agentType: 'outbound_lead_call',
        });
        console.log(`[outboundLeadCall] task created kind=${kind} lead=${attempt.lead_uuid}`);
    } catch (err) {
        console.warn('[outboundLeadCall] createLeadCallTask failed:', err && err.message);
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
    parseLeadContext,
    // §5.2
    onLeadCreated,
    // §5.3-5.6
    processLeadAttempt,
    scheduleLeadRetryOrExhaust,
    handleLeadEndOfCall,
    createLeadCallTask,
};
