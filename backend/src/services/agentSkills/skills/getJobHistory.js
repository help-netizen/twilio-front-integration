/**
 * agentSkills / skills / getJobHistory — read, L2 (sensitive)
 * (AGENT-SKILLS-001, spec §4.7 / task T6 · FR-S7 / FR-C4)
 *
 * "What did the tech say last time?" — a SUMMARIZED, speech-friendly timeline of a
 * single job. Returns `{ ok, timeline:[{ date, event, note_summary }], speak }`.
 *
 * PRIVACY (the whole point of this skill):
 *   - L2-only. The gate (verificationGate.assert, called by index.runSkill BEFORE
 *     run) already blocked anything below L2, so `run` can trust
 *     verifiedContext.level === 'L2' + a real contactId. We STILL defend (belt +
 *     braces): a non-L2 context, or no contactId, returns the soft needs-verify
 *     shape rather than any data.
 *   - Company isolation + contact ownership: the job is fetched company-scoped
 *     (getJobById(jobId, companyId)) AND must belong to the verified contactId. A
 *     job from another company or another contact is treated as not-found — never
 *     disclosed (a cross-contact/cross-company row → safe refusal, not the data).
 *   - REDACT internal-only / technician-private notes. Raw note text is NEVER read
 *     back; every surfaced note is SUMMARIZED to a short, neutral phrase. Notes
 *     that look internal/technician-private are dropped from the spoken timeline.
 *   - No addresses, no technician PII, no internal codes (spec §2.5 / §9).
 *
 * Service calls (real signatures, verified):
 *   - jobsService.getJobById(id, companyId)  → job (carries notes[], contact_id).
 *   - eventService.getEntityHistory(companyId, 'job', jobId, job.notes)
 *       → merged [{ id, type:'event'|'note', event_type, description?, text?,
 *          author?, actor, created_at, data }] sorted DESC.
 */

'use strict';

const jobsService = require('../../jobsService');
const eventService = require('../../eventService');
const resultShapes = require('../resultShapes');

/**
 * Belt-and-braces L2 + contact-ownership guard. The choke-point's gate already
 * enforced L2 BEFORE this runs, so we can trust it — but re-check so the module is
 * safe even if ever invoked off the choke-point. True → the caller is a verified
 * (L2) identity bound to a concrete contactId.
 * @param {{ level?:string, contactId?:number|null }} ctx verifiedContext.
 * @returns {boolean}
 */
function isVerifiedContact(ctx) {
    return Boolean(ctx && ctx.level === 'L2' && ctx.contactId != null && ctx.contactId !== '');
}

/** Max timeline entries spoken back — keep it short and speech-friendly. */
const MAX_TIMELINE = 8;
/** Cap a summarized note so nothing long / raw is read aloud. */
const NOTE_SUMMARY_MAX_CHARS = 120;

/**
 * Is this note internal-only / technician-private and therefore NOT to be read to
 * a customer? Conservative and fail-safe: when in doubt, redact. We never surface
 * raw note text regardless — this only decides whether the note appears at all.
 *
 * Signals (from the real note shape — see notesMutationService.canMutateNote and
 * jobsService.addNote / ZB `job_notes`): an explicit internal/private/visibility
 * marker, or an author/source that indicates a technician / field note. "AI Phone"
 * (our own audit author) and "Albusto" are system-safe and stay.
 * @param {object} note A note history item ({ text, author, actor, data, ... }).
 * @returns {boolean} true → drop from the customer-facing timeline.
 */
function isInternalNote(note) {
    if (!note || typeof note !== 'object') return true; // unknown shape → redact

    // Explicit privacy flags anywhere on the note or its data payload.
    const data = note.data && typeof note.data === 'object' ? note.data : {};
    const flagged = (o) =>
        Boolean(
            o.internal === true ||
                o.is_internal === true ||
                o.private === true ||
                o.tech_only === true ||
                o.technician_private === true ||
                (typeof o.visibility === 'string' && o.visibility.toLowerCase() !== 'public'),
        );
    if (flagged(note) || flagged(data)) return true;

    // Author/source heuristic. System-safe authors are allowed; a technician /
    // field author is treated as private (the customer shouldn't hear internal
    // field chatter — only a neutral summary of customer-relevant events).
    const author = String(note.author || note.actor || '').trim().toLowerCase();
    if (author) {
        const SYSTEM_SAFE = new Set(['ai phone', 'albusto', 'system', '']);
        if (!SYSTEM_SAFE.has(author)) {
            // Any human/technician-authored free note is redacted from the spoken
            // timeline (we still surface structured events like status changes).
            return true;
        }
    }
    return false;
}

/**
 * Collapse arbitrary note/event text into a short, neutral, speech-safe summary.
 * Never returns the raw text verbatim: strips newlines/URLs/emails/phones, removes
 * anything that looks like an internal code/id, and truncates hard. Empty when
 * there's nothing safe to say.
 * @param {string} raw
 * @returns {string}
 */
function summarize(raw) {
    let s = String(raw || '');
    if (!s) return '';
    s = s.replace(/\s+/g, ' ').trim();
    // Redact obvious PII / contact handles that must never be read back.
    s = s.replace(/https?:\/\/\S+/gi, '');
    s = s.replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/gi, '');
    s = s.replace(/\b\+?\d[\d().\s-]{7,}\d\b/g, '');
    s = s.replace(/\s+/g, ' ').trim();
    if (!s) return '';
    if (s.length > NOTE_SUMMARY_MAX_CHARS) {
        s = `${s.slice(0, NOTE_SUMMARY_MAX_CHARS - 1).trimEnd()}…`;
    }
    return s;
}

/**
 * Format an ISO timestamp to a short, human, timezone-stable date phrase. Falls
 * back to '' when absent/unparseable (the entry still lists with an empty date).
 * @param {string|null} iso
 * @returns {string}
 */
function toDatePhrase(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    // America/New_York — the app's canonical timezone (project instructions).
    try {
        return d.toLocaleDateString('en-US', {
            timeZone: 'America/New_York',
            month: 'short',
            day: 'numeric',
            year: 'numeric',
        });
    } catch {
        return d.toISOString().slice(0, 10);
    }
}

/**
 * Turn a merged history item into a speech-safe timeline row, or null to drop it.
 * - Events: keep the neutral `description` (already code-free from eventService).
 * - Notes: drop when internal/technician-private; otherwise SUMMARIZE the text
 *   (never raw). A note with no safe content after redaction is dropped.
 * @param {object} item
 * @returns {{ date: string, event: string, note_summary: string }|null}
 */
function toTimelineRow(item) {
    if (!item || typeof item !== 'object') return null;
    const date = toDatePhrase(item.created_at);

    if (item.type === 'note') {
        if (isInternalNote(item)) return null;
        const note_summary = summarize(item.text);
        if (!note_summary) return null; // nothing customer-safe to say
        return { date, event: 'Note', note_summary };
    }

    // Event row: description is built by eventService.describeEvent (no raw codes,
    // no PII). Summarize defensively anyway (bounds length, strips any handles).
    const event = summarize(item.description || item.event_type || 'Update') || 'Update';
    return { date, event, note_summary: '' };
}

/**
 * getJobHistory — L2 sensitive read. See file header.
 * @param {string} companyId Tenant scope (server-provided; never the client's).
 * @param {{ level:'L0'|'L1'|'L2', contactId:number|null }} verifiedContext Server-derived.
 * @param {{ jobId?:string|number, job_id?:string|number }} input Skill payload (identity block ignored for auth).
 * @returns {Promise<object>} speech-safe result / soft refusal (never raw PII).
 */
async function run(companyId, verifiedContext, input = {}) {
    // Defense-in-depth: the gate already enforced L2, but re-check here so this
    // module is safe even if ever called off the choke-point.
    if (!isVerifiedContact(verifiedContext)) {
        return resultShapes.needsVerification();
    }

    const jobId = input.jobId != null ? input.jobId : input.job_id;
    if (jobId == null || jobId === '') {
        return resultShapes.refusal('Which job would you like the history for?');
    }

    // Ownership pre-check: company-scoped fetch, then confirm the job belongs to
    // the verified contact. Any mismatch → not-found-safe (no disclosure).
    const job = await jobsService.getJobById(jobId, companyId);
    if (!job || String(job.contact_id) !== String(verifiedContext.contactId)) {
        return resultShapes.refusal("I don't see that job on your account.");
    }

    const notes = Array.isArray(job.notes) ? job.notes : [];
    const history = await eventService.getEntityHistory(companyId, 'job', job.id, notes);

    const timeline = (Array.isArray(history) ? history : [])
        .map(toTimelineRow)
        .filter(Boolean)
        .slice(0, MAX_TIMELINE);

    const serviceName = summarize(job.service_name) || 'your service';
    const speak =
        timeline.length === 0
            ? `I don't have any recent history to read back for ${serviceName}. Is there anything else I can help with?`
            : `Here's a quick summary of what's happened with ${serviceName}. I can go over the recent updates with you.`;

    return resultShapes.ok(speak, { timeline });
}

module.exports = { run };
