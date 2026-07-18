/**
 * slotEngineService.js — builds a live snapshot (new job geo, technician roster +
 * base locations, scheduled jobs) and proxies it to the standalone slot engine
 * (SLOT-ENGINE-001 Phase 2). The engine is stateless: we push everything it needs
 * and it returns ranked arrival time-frame + technician recommendations.
 *
 * SAFE-FAILURE: any engine fault (non-2xx, network error, timeout, or missing
 * SLOT_ENGINE_URL) degrades to an empty, clearly-flagged result — never a throw,
 * never a fabricated slot.
 */
const db = require('../db/connection');
const queries = require('../db/technicianBaseLocationQueries');
const technicianRosterService = require('./technicianRosterService');
const googlePlacesService = require('./googlePlacesService');
const jobsService = require('./jobsService');
const scheduleService = require('./scheduleService');
const slotEngineSettingsService = require('./slotEngineSettingsService');
const technicianAvailabilityService = require('./technicianAvailabilityService');
const technicianServiceAreaService = require('./technicianServiceAreaService');
const { dateInTZ } = require('../utils/companyTime');

const DEFAULT_TZ = 'America/New_York';
const DEFAULT_DURATION_MINUTES = 75;
const ENGINE_TIMEOUT_MS = 4000;

// OUTBOUND-PARTS-CALL-TECHSLOT-001 §3: the engine's candidate_timeframes count
// (slot-engine/src/config.js — five fixed 2h arrival windows per day). Used to
// widen the per-tech ranking caps on single-technician queries so a one-day query
// can return ALL of that day's windows (the engine defaults cap at 2 per tech).
const SINGLE_TECH_TIMEFRAME_COUNT = 5;

// Extra ranking.top_n headroom when effective-unavailability blocks exist —
// post-filtered rejects would otherwise burn
// the ranking quota and under-fill the response (E-11). Sliced back after filtering.
const UNAVAILABILITY_TOPN_HEADROOM = 5;

function isFiniteNum(n) {
    return typeof n === 'number' && Number.isFinite(n);
}

// ─── Company-timezone helpers (kept local + small so they're testable) ──────────

/** 'YYYY-MM-DD' for `d` in the company timezone (en-CA gives ISO-ordered date). */
function localDate(d, tz) {
    return new Date(d).toLocaleDateString('en-CA', { timeZone: tz });
}

/** 'HH:MM' (24h) for `d` in the company timezone. */
function localHHMM(d, tz) {
    return new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(d));
}

/** Whole minutes between two ISO/date values (>= 0), or null if not computable. */
function minutesBetween(start, end) {
    if (!start || !end) return null;
    const ms = new Date(end).getTime() - new Date(start).getTime();
    if (!Number.isFinite(ms) || ms < 0) return null;
    return Math.round(ms / 60000);
}

/** today + n days as 'YYYY-MM-DD' in the company timezone. */
function addDaysLocal(baseDateStr, n) {
    const base = new Date(`${baseDateStr}T00:00:00Z`);
    base.setUTCDate(base.getUTCDate() + n);
    return base.toISOString().slice(0, 10);
}

/**
 * Combine a wall-clock date + time in company `tz` into a UTC ISO string.
 * The inverse of localDate/localHHMM. Thin adapter over the canonical
 * companyTime.dateInTZ — the single source of the DST offset math (itself
 * mirrored from frontend companyTime.ts). DST-aware: an EDT date resolves
 * UTC−4, an EST date UTC−5.
 *
 * @param {string} dateStr 'YYYY-MM-DD'
 * @param {string} hhmm    'HH:MM' (24h)
 * @param {string} tz      IANA timezone name
 * @returns {string} ISO 8601 UTC string, e.g. '2026-07-08T14:00:00.000Z'
 */
function tzCombine(dateStr, hhmm, tz) {
    const [y, mo, d] = String(dateStr).split('-').map(Number);
    const [hh, mm] = String(hhmm).split(':').map(Number);
    return dateInTZ(y, mo, d, hh, mm, tz).toISOString();
}

async function resolveTimezone(companyId) {
    try {
        const settings = await scheduleService.getDispatchSettings(companyId);
        return settings?.timezone || DEFAULT_TZ;
    } catch {
        return DEFAULT_TZ;
    }
}

/** Smart recommendations must not invent a timezone if company hours fail. */
async function resolveRecommendationTimezone(companyId) {
    const settings = await scheduleService.getDispatchSettings(companyId);
    const timezone = settings?.timezone;
    if (!timezone) throw new Error('Company schedule timezone is unavailable');
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return timezone;
}

// ─── Snapshot pieces ────────────────────────────────────────────────────────────

async function resolveNewJobPoint(newJob) {
    if (isFiniteNum(newJob.lat) && isFiniteNum(newJob.lng)) {
        return { lat: newJob.lat, lng: newJob.lng };
    }
    if (newJob.address && String(newJob.address).trim()) {
        const g = await googlePlacesService.geocodeAddress(newJob.address);
        if (g.status !== 'failed' && isFiniteNum(g.lat) && isFiniteNum(g.lng)) {
            return { lat: g.lat, lng: g.lng };
        }
    }
    const err = new Error('Provide a location (lat/lng or a geocodable address) for the new job.');
    err.httpStatus = 422;
    err.code = 'NEW_JOB_LOCATION_REQUIRED';
    throw err;
}

async function buildTechnicians(companyId) {
    const stored = await queries.listByCompany(companyId);
    const byId = new Map(stored.map(r => [String(r.tech_id), r]));

    let members = [];
    try {
        members = await technicianRosterService.listActive(companyId);
    } catch (err) {
        console.warn('[SlotEngine] roster unavailable:', err.message);
        members = [];
    }

    return (Array.isArray(members) ? members : []).map(m => {
        const techId = String(m.id);
        const base = byId.get(techId);
        const name = m.name || techId;
        return {
            id: techId,
            name,
            active: m.deactivated === true ? false : true,
            base: base && isFiniteNum(base.lat) && isFiniteNum(base.lng)
                ? { lat: base.lat, lng: base.lng }
                : null,
        };
    });
}

async function buildScheduledJobs(companyId, startDate, endDate, tz, excludeJobId) {
    const jobs = await jobsService.listJobs({ companyId, startDate, endDate, limit: 500 });
    const list = Array.isArray(jobs) ? jobs : (jobs?.jobs || jobs?.data || []);
    const out = [];
    for (const j of list) {
        // Reschedule: drop the job being moved so its current slot isn't treated as occupied.
        if (excludeJobId != null && String(j.id) === String(excludeJobId)) continue;
        const lat = j.lat;
        const lng = j.lng;
        if (!isFiniteNum(lat) || !isFiniteNum(lng)) continue;
        if (j.blanc_status === 'Canceled' || j.blanc_status === 'Visit completed') continue;
        if (!j.start_date) continue;

        const endRef = j.end_date || j.start_date;
        out.push({
            id: String(j.id),
            date: localDate(j.start_date, tz),
            status: 'scheduled',
            job_type: j.job_type || 'unknown',
            window_start: localHHMM(j.start_date, tz),
            window_end: localHHMM(endRef, tz),
            lat,
            lng,
            duration_minutes: minutesBetween(j.start_date, j.end_date) || DEFAULT_DURATION_MINUTES,
            assigned_technicians: (Array.isArray(j.assigned_techs) ? j.assigned_techs : [])
                .map(t => String(t.id))
                .filter(id => id && id !== 'undefined' && id !== 'null'),
        });
    }

    // VAPI-SLOT-ENGINE-001 (FR-5, Decision A): append OPEN HELD LEADS as area
    // occupancy so a caller's held window isn't re-offered near the same place.
    // Filter mirrors the leads-in-Schedule UNION verbatim (scheduleQueries.js:136)
    // — case-INSENSITIVE terminal-status (LOWER) so a capitalized 'Converted'/'Lost'
    // (as written by convertLead/markLost) actually drops the hold. Company-scoped,
    // date-windowed, coords-required (a coord-less hold can't block routing — the
    // engine's own skip-guard would drop it anyway; accepted v1). Same occupancy
    // shape as a job (reusing localDate/localHHMM/minutesBetween); assigned_technicians:[]
    // = the engine treats it as an area block for ANY tech, not one tech's route.
    const leadsSql = `
        SELECT id, lead_date_time, lead_end_date_time, latitude, longitude, job_type
        FROM leads
        WHERE company_id = $1
          AND LOWER(status) NOT IN ('converted','lost','spam')
          AND lead_date_time IS NOT NULL
          AND latitude IS NOT NULL AND longitude IS NOT NULL
          AND lead_date_time >= ($2::date::timestamp AT TIME ZONE $4)
          AND lead_date_time <  (($3::date + INTERVAL '1 day')::timestamp AT TIME ZONE $4)
    `;
    const { rows: heldLeads } = await db.query(leadsSql, [companyId, startDate, endDate, tz]);
    for (const l of heldLeads) {
        out.push({
            id: `lead:${l.id}`,
            date: localDate(l.lead_date_time, tz),
            status: 'scheduled',
            job_type: l.job_type || 'unknown',
            window_start: localHHMM(l.lead_date_time, tz),
            window_end: localHHMM(l.lead_end_date_time || l.lead_date_time, tz),
            lat: Number(l.latitude),
            lng: Number(l.longitude),
            duration_minutes: minutesBetween(l.lead_date_time, l.lead_end_date_time) || DEFAULT_DURATION_MINUTES,
            assigned_technicians: [],
        });
    }

    return out;
}

// ─── Effective-unavailability helpers ─────────────────────────────────────────
// All comparisons run on UTC-instant milliseconds with STRICT half-open interval
// overlap (aStart < bEnd && bStart < aEnd) — records merely touching a boundary do
// NOT overlap (INV-8). Multi-day / cross-midnight blocks stay ONE interval; there
// is never any per-date slicing.

/** Combined blocks → Map<technician_id, [{start, end}]> (epoch ms, half-open). */
function groupUnavailabilityByTech(rows) {
    const byTech = new Map();
    for (const r of rows) {
        const key = String(r.technician_id);
        if (!byTech.has(key)) byTech.set(key, []);
        byTech.get(key).push({
            start: new Date(r.starts_at).getTime(),
            end: new Date(r.ends_at).getTime(),
        });
    }
    return byTech;
}

/**
 * Pre-shaping: drop technicians having ONE unavailable block that covers
 * the entire [horizonStartMs, horizonEndMs). Multi-records are deliberately NOT
 * merged (E-2, v1 conservative) — a tech covered only by the union of several
 * records stays in the roster and the post-filter kills their dead windows. Pure
 * input-shaping AFTER buildTechnicians (INV-4), same precedent as the TECHSLOT
 * one-tech filter in getRecommendations.
 */
function dropFullHorizonUnavailableTechs(technicians, unavailableByTech, horizonStartMs, horizonEndMs) {
    return technicians.filter(t => {
        const offs = unavailableByTech.get(String(t.id));
        if (!offs) return true;
        return !offs.some(o => o.start <= horizonStartMs && o.end >= horizonEndMs);
    });
}

/**
 * Post-filter (S-5 steps 3-4): drop every rec whose arrival window overlaps ANY
 * unavailable block of ANY of its technicians, then slice back to top_n
 * and renumber rank 1..n. Window instants are built with the SAME tzCombine as
 * the vapi slot-persist path (E-8: DST-safe by construction — a switch-day
 * 08:00–10:00 window lands on the exact instants bookings use).
 */
function applyUnavailabilityPostFilter(recommendations, unavailableByTech, tz, topN) {
    const kept = recommendations.filter(rec => {
        const tf = rec?.time_frame || {};
        const winStart = Date.parse(tzCombine(rec.date, tf.start, tz));
        const winEnd = Date.parse(tzCombine(rec.date, tf.end, tz));
        const techs = Array.isArray(rec?.technicians) ? rec.technicians : [];
        return !techs.some(t => {
            const offs = unavailableByTech.get(String(t?.id));
            return offs != null && offs.some(o => winStart < o.end && o.start < winEnd);
        });
    });
    return kept.slice(0, topN).map((rec, i) => ({ ...rec, rank: i + 1 }));
}

// ─── Public entrypoint ──────────────────────────────────────────────────────────

/**
 * Build the snapshot and proxy it to the slot engine.
 * @param {string} companyId
 * @param {{ new_job: { lat?, lng?, address?, job_type?, duration_minutes?, territory_id?, earliest_allowed_date?, latest_allowed_date?, technician_id? } }} input
 *   `new_job.technician_id` (TECHSLOT-001 §3, optional): constrain the query to that
 *   ONE technician — the roster is filtered to a one-element array (unknown/foreign
 *   id → empty → no recommendations, safe) and the per-tech ranking caps are widened
 *   so a single-day query returns ALL candidate windows. Absent → legacy all-tech.
 * @returns {{ recommendations, summary, engine_status: 'ok' | 'unavailable' }}
 */
async function getRecommendations(companyId, input = {}) {
    const newJob = input.new_job || {};
    let tz;
    try {
        tz = await resolveRecommendationTimezone(companyId);
    } catch (err) {
        console.warn('[SlotEngine] company schedule unavailable:', err.message);
        return {
            recommendations: [],
            summary: null,
            engine_status: 'unavailable',
            coverage: { technicians_total: 0, technicians_with_base: 0 },
        };
    }

    // 1. New-job point (may throw NEW_JOB_LOCATION_REQUIRED — a real client error).
    const point = await resolveNewJobPoint(newJob);

    // Per-company recommendation settings (never throws; safe-fails to DEFAULTS).
    const settings = await slotEngineSettingsService.resolve(companyId);

    // Horizon: explicit window, else today..today + settings.horizon_days (company-local).
    const today = localDate(new Date(), tz);
    const earliest = newJob.earliest_allowed_date || today;
    const latest = newJob.latest_allowed_date || addDaysLocal(today, settings.horizon_days);

    // One company-local horizon for explicit time off plus recurring gaps.
    const horizonStartUtc = tzCombine(earliest, '00:00', tz);
    const horizonEndUtc = tzCombine(addDaysLocal(latest, 1), '00:00', tz);

    // 2 + 3. Technicians and scheduled jobs.
    const [allTechnicians, scheduledJobs] = await Promise.all([
        buildTechnicians(companyId),
        buildScheduledJobs(companyId, earliest, latest, tz, newJob.exclude_job_id),
    ]);

    let areaEligibility;
    try {
        areaEligibility = await technicianServiceAreaService.filterEligibleTechnicians(
            companyId,
            allTechnicians,
            { query: newJob.address || newJob.zip || '', lat: point.lat, lng: point.lng }
        );
    } catch (error) {
        console.warn('[SlotEngine] service-area eligibility unavailable:', error.message);
        const active = allTechnicians.filter(technician => technician.active);
        return {
            recommendations: [],
            summary: null,
            engine_status: 'unavailable',
            coverage: {
                technicians_total: active.length,
                technicians_with_base: active.filter(technician => technician.base).length,
            },
        };
    }
    if (!areaEligibility.target_resolved) {
        const active = allTechnicians.filter(technician => technician.active);
        return {
            recommendations: [],
            summary: null,
            engine_status: 'unavailable',
            coverage: {
                technicians_total: active.length,
                technicians_with_base: active.filter(technician => technician.base).length,
            },
        };
    }
    const areaEligibleTechnicians = areaEligibility.technicians;

    // TECHSLOT-001 §3: optional single-technician scope. The engine ranks across
    // whatever `technicians` array it is handed, so one-tech = a one-element array
    // — pure input shaping, zero engine change. Unknown/foreign id → [] → the
    // engine returns no recommendations (safe-fail upstream; never cross-tenant —
    // the filter only ever narrows THIS company's own roster).
    const technicianId = newJob.technician_id;
    const singleTech = technicianId != null && String(technicianId).trim() !== '';
    const technicians = singleTech
        ? areaEligibleTechnicians.filter(t => String(t.id) === String(technicianId))
        : areaEligibleTechnicians;

    let unavailableRows;
    try {
        unavailableRows = await technicianAvailabilityService.buildUnavailability(companyId, {
            from: horizonStartUtc,
            to: horizonEndUtc,
            technicians,
        });
    } catch (err) {
        if (err.code === 'COMPANY_SCHEDULE_UNAVAILABLE') {
            const active = technicians.filter(technician => technician.active);
            return {
                recommendations: [],
                summary: null,
                engine_status: 'unavailable',
                coverage: {
                    technicians_total: active.length,
                    technicians_with_base: active.filter(technician => technician.base).length,
                },
            };
        }
        throw err;
    }
    const hasUnavailability = Array.isArray(unavailableRows) && unavailableRows.length > 0;
    const unavailableByTech = hasUnavailability ? groupUnavailabilityByTech(unavailableRows) : null;

    // Existing pre-shaping seam: a tech whose single unavailable block
    // covers the whole horizon leaves the roster before the engine sees it, so
    // ranking quota isn't wasted on all-dead candidates. Zero-path hands through
    // the SAME array reference — no blocks, no delta (INV-2). TECHSLOT
    // one-tech fully covered → [] → engine yields 0 recs (E-9, existing
    // safe-fail semantics of every consumer).
    const engineTechnicians = hasUnavailability
        ? dropFullHorizonUnavailableTechs(
              technicians,
              unavailableByTech,
              Date.parse(horizonStartUtc),
              Date.parse(horizonEndUtc)
          )
        : technicians;

    // Base coverage — surfaced to the UI so the dispatcher knows recommendations may
    // be incomplete when some technicians have no base set (the engine can't place a
    // based-less technician on a day they have no other jobs). TECH-DAYOFF-001:
    // counted on the pre-shaped roster — it describes the techs actually ranked (S-5).
    const activeTechs = engineTechnicians.filter(t => t.active);
    const coverage = {
        technicians_total: activeTechs.length,
        technicians_with_base: activeTechs.filter(t => t.base).length,
    };

    // Per-company tuning (distance/overlap/buffer/horizon/top_n) + the fixed
    // empty-day + utilization values, mapped to the engine's config shape.
    let configOverride = slotEngineSettingsService.buildConfigOverride(settings);
    if (singleTech) {
        // TECHSLOT-001 §3 (verified gap): the engine's ranking defaults (top_n:3,
        // max_recommendations_per_technician:2, max_recommendations_per_same_timeframe:2)
        // would cap a single-tech day query at 2 of the 5 candidate windows —
        // breaking req-4 "offer that day's windows" and req-5 "true nearest".
        // Widen the caps for THIS query only, deep-merged onto the settings-based
        // override (all its other keys preserved; buildConfigOverride untouched).
        const N = SINGLE_TECH_TIMEFRAME_COUNT;
        configOverride = {
            ...configOverride,
            ranking: {
                ...configOverride.ranking,
                top_n: Math.max(Number(configOverride.ranking?.top_n) || 0, N),
                max_recommendations_per_technician: N,
                max_recommendations_per_same_timeframe: N,
            },
        };
    }

    // Remember the pre-headroom top_n for the final slice, then ask the engine
    // for +UNAVAILABILITY_TOPN_HEADROOM more so
    // post-filter rejects don't under-fill the answer (E-11). Composed AFTER the
    // singleTech widening above; the per-tech / per-timeframe caps are NOT
    // touched. Zero-path: configOverride is left completely untouched.
    const preHeadroomTopN = Number(configOverride.ranking?.top_n) || 3; // 3 = engine DEFAULT_CONFIG top_n
    if (hasUnavailability) {
        configOverride = {
            ...configOverride,
            ranking: {
                ...configOverride.ranking,
                top_n: preHeadroomTopN + UNAVAILABILITY_TOPN_HEADROOM,
            },
        };
    }

    // 4. Engine request body (per slot-engine/README.md contract).
    const requestId = `alb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const body = {
        request_id: requestId,
        requested_at: new Date().toISOString(),
        new_request: {
            id: 'new',
            lat: point.lat,
            lng: point.lng,
            job_type: newJob.job_type || 'unknown',
            duration_minutes: isFiniteNum(newJob.duration_minutes) ? newJob.duration_minutes : null,
            required_technician_count: 1,
            earliest_allowed_date: earliest,
            latest_allowed_date: latest,
        },
        // Pre-shaped roster (=== `technicians` when no unavailability).
        technicians: engineTechnicians,
        scheduled_jobs: scheduledJobs,
        config_override: configOverride,
    };

    // 5. Proxy with a short timeout. Any engine fault → safe-failure.
    const baseUrl = process.env.SLOT_ENGINE_URL;
    if (!baseUrl) {
        return { recommendations: [], summary: null, engine_status: 'unavailable', coverage };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ENGINE_TIMEOUT_MS);
    try {
        const res = await fetch(`${baseUrl}/api/v1/slot-recommendations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        if (!res.ok) {
            console.warn('[SlotEngine] non-2xx response:', res.status);
            return { recommendations: [], summary: null, engine_status: 'unavailable', coverage };
        }
        const json = await res.json();
        // 6. Success. The post-filter runs only when unavailable blocks exist;
        // zero-path returns the engine's array untouched
        // (INV-2). Response shape {recommendations, summary, engine_status,
        // coverage} is structurally unchanged (INV-3).
        let recommendations = Array.isArray(json?.recommendations) ? json.recommendations : [];
        if (hasUnavailability) {
            recommendations = applyUnavailabilityPostFilter(recommendations, unavailableByTech, tz, preHeadroomTopN);
        }
        return {
            recommendations,
            summary: json?.summary ?? null,
            engine_status: 'ok',
            coverage,
        };
    } catch (err) {
        console.warn('[SlotEngine] engine unavailable:', err.message);
        return { recommendations: [], summary: null, engine_status: 'unavailable', coverage };
    } finally {
        clearTimeout(timer);
    }
}

module.exports = {
    getRecommendations,
    // VAPI-SLOT-ENGINE-001: wall-clock→ISO combine + company-tz resolve, imported
    // by the vapi-tools recommendSlots/createLead slot-persist path (T2).
    tzCombine,
    resolveTimezone,
    // exported for unit tests
    _localDate: localDate,
    _localHHMM: localHHMM,
    _minutesBetween: minutesBetween,
    _buildScheduledJobs: buildScheduledJobs,
    _buildTechnicians: buildTechnicians,
};
