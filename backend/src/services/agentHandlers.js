/**
 * agentHandlers.js — AUTO-001. Registry of agent_type → handler.
 *
 * Each handler receives the agent task row and returns an output object
 * (stored in tasks.agent_output). Adding an agent type = one REGISTRY entry.
 */

const db = require('../db/connection');

const HANDLERS = {
    // Echo input — used by templates/tests.
    async noop(task) {
        return { echo: task.agent_input || {} };
    },

    // Run a CRM MCP tool inside the task's tenant context.
    async mcp_tool(task) {
        const input = task.agent_input || {};
        if (!input.tool) throw new Error('mcp_tool requires input.tool');
        const executor = require('./crmMcpToolExecutor');
        // Synthetic request scoped to the task's company (no HTTP request).
        const syntheticReq = {
            companyFilter: { company_id: task.company_id },
            user: { crmUser: { id: null }, email: 'automation@albusto' },
            authz: {
                permissions: ['tenant.company.manage', 'contacts.view', 'leads.view', 'tasks.view'],
                company: {},
            },
            ip: null,
            headers: {},
        };
        const result = await executor.execute(syntheticReq, input.tool, input.args || {}, input.confirmation || null);
        return { tool: input.tool, result };
    },

    // SCHED-ROUTE-001: geocode a job address, persist, then trigger route recalc.
    async job_geocode(task) {
        const input = task.agent_input || {};
        const jobId = input.job_id;
        if (!jobId) throw new Error('job_geocode requires input.job_id');
        const { rows } = await db.query(
            `SELECT id, address, lat, lng, normalized_address, geocoding_status
             FROM jobs WHERE id = $1 AND company_id = $2`,
            [jobId, task.company_id]
        );
        const job = rows[0];
        if (!job) return { job_id: jobId, skipped: 'job_not_found' };

        // Skip paid geocode if we already have usable coords and the address is
        // unchanged since a successful/needs_review geocode (FR-004).
        const already = job.lat != null && job.lng != null
            && ['success', 'needs_review'].includes(job.geocoding_status);
        if (already) return { job_id: jobId, skipped: 'already_geocoded', status: job.geocoding_status };

        if (!job.address || !String(job.address).trim()) {
            await db.query(
                `UPDATE jobs SET geocoding_status='failed', geocoding_error_code='NO_ADDRESS', updated_at=now()
                 WHERE id=$1 AND company_id=$2`, [jobId, task.company_id]);
            return { job_id: jobId, status: 'failed', reason: 'no_address' };
        }

        const result = await require('./googlePlacesService').geocodeAddress(job.address);
        if (result.status === 'failed') {
            await db.query(
                `UPDATE jobs SET geocoding_status='failed', geocoded_at=now(),
                    geocoding_error_code=$3, geocoding_error_message=$4, updated_at=now()
                 WHERE id=$1 AND company_id=$2`,
                [jobId, task.company_id, result.error_code || 'ERROR', result.error_message || null]);
            return { job_id: jobId, status: 'failed' };
        }
        await db.query(
            `UPDATE jobs SET lat=$3, lng=$4, normalized_address=$5,
                geocoding_status=$6, geocoding_place_id=$7, geocoded_at=now(),
                geocoding_provider='google_maps', geocoding_error_code=NULL,
                geocoding_error_message=NULL, updated_at=now()
             WHERE id=$1 AND company_id=$2`,
            [jobId, task.company_id, result.lat, result.lng, result.normalized_address || null,
             result.status, result.place_id || null]);

        // Coordinates changed → recalc affected technician/day segments.
        await require('./routeSegmentService').recalcForJob(task.company_id, jobId, { coordsChanged: true });
        return { job_id: jobId, status: result.status, lat: result.lat, lng: result.lng };
    },

    // SCHED-ROUTE-001: compute pending route segments for a technician/day,
    // cache-first (Google only on cache miss). Idempotent.
    async route_calc(task) {
        const input = task.agent_input || {};
        const technicianId = input.technician_id;
        const scheduleDate = input.schedule_date;
        if (!technicianId || !scheduleDate) throw new Error('route_calc requires technician_id + schedule_date');
        const routeQueries = require('../db/routeQueries');
        const distance = require('./routeDistanceService');
        const segments = await routeQueries.getCalculableSegments(task.company_id, technicianId, scheduleDate);
        let success = 0, failed = 0, fromCache = 0;
        for (const seg of segments) {
            const r = await distance.computePair(
                { lat: seg.from_latitude, lng: seg.from_longitude },
                { lat: seg.to_latitude, lng: seg.to_longitude },
                seg.travel_mode || 'driving');
            if (r.status === 'success') {
                await routeQueries.setSegmentResult(task.company_id, seg.id, {
                    status: 'success', distanceMeters: r.distanceMeters, durationMinutes: r.durationMinutes, cacheKey: r.cacheKey });
                success++; if (r.fromCache) fromCache++;
            } else {
                await routeQueries.setSegmentResult(task.company_id, seg.id, {
                    status: 'failed', cacheKey: r.cacheKey, errorCode: r.errorCode, errorMessage: r.errorMessage });
                failed++;
            }
        }
        return { technician_id: technicianId, schedule_date: scheduleDate, segments: segments.length, success, failed, fromCache };
    },

    // SCHED-ROUTE-001 C-12: best-effort, dedupe-guarded create of a locally-made
    // Albusto job into ZenBooker. One attempt per local job; the local job is
    // never rolled back on failure (status recorded in jobs.zb_sync_status).
    async zb_job_sync(task) {
        const input = task.agent_input || {};
        const jobId = input.job_id;
        if (!jobId) throw new Error('zb_job_sync requires input.job_id');
        const { rows } = await db.query(
            `SELECT id, zenbooker_job_id, service_name, address,
                    customer_name, customer_phone, customer_email, start_date, end_date
             FROM jobs WHERE id = $1 AND company_id = $2`,
            [jobId, task.company_id]
        );
        const job = rows[0];
        if (!job) return { job_id: jobId, skipped: 'job_not_found' };
        // Dedupe: never create a second external job for one local job.
        if (job.zenbooker_job_id) {
            return { job_id: jobId, skipped: 'already_synced', zenbooker_job_id: job.zenbooker_job_id };
        }

        const zb = require('./zenbookerClient');
        const addr = input.address || {};
        let territoryId;
        try { if (addr.postal_code) territoryId = await zb.findTerritoryByPostalCode(addr.postal_code); }
        catch { /* best-effort: ZB still accepts jobs without a resolved territory */ }

        const start = job.start_date ? new Date(job.start_date) : null;
        const end = job.end_date ? new Date(job.end_date)
            : (start ? new Date(start.getTime() + 2 * 60 * 60 * 1000) : null);
        const payload = {
            territory_id: territoryId || undefined,
            timeslot: start ? { type: 'arrival_window', start: start.toISOString(), end: (end || start).toISOString() } : undefined,
            customer: {
                name: job.customer_name || 'Unknown',
                phone: job.customer_phone || undefined,
                email: job.customer_email || undefined,
            },
            address: {
                line1: addr.line1 || job.address || undefined,
                line2: addr.line2 || undefined,
                city: addr.city || undefined,
                state: addr.state || undefined,
                postal_code: addr.postal_code || undefined,
            },
            service: job.service_name || undefined,
        };

        try {
            const res = await zb.createJob(payload);
            const zbId = res?.job_id ?? res?.id ?? null;
            await db.query(
                `UPDATE jobs SET zenbooker_job_id = $3, zb_sync_status = 'synced', updated_at = now()
                 WHERE id = $1 AND company_id = $2`,
                [jobId, task.company_id, zbId != null ? String(zbId) : null]);
            return { job_id: jobId, status: 'synced', zenbooker_job_id: zbId };
        } catch (err) {
            // Best-effort: record the failure, keep the local job, do NOT fail the task.
            await db.query(
                `UPDATE jobs SET zb_sync_status = 'failed', updated_at = now()
                 WHERE id = $1 AND company_id = $2`, [jobId, task.company_id]);
            return { job_id: jobId, status: 'failed', error: (err.message || '').slice(0, 200) };
        }
    },

    // YELP-LEAD-AUTORESPONDER-002: send the single Yelp new-lead greeting for a
    // detector-enqueued task. Idempotent / retry-safe: threadAlreadyGreeted is
    // checked FIRST (a re-run never double-sends — Yelp rejects a 2nd reply), and
    // ONLY sendEmail throwing propagates (drives the worker's opt-in retry).
    async yelp_lead(task) {
        const input = task.agent_input || {};
        const yelpLeadQueries = require('../db/yelpLeadQueries');

        // (1) Nothing to reply to → close as handled_no_send (NOT a retryable error;
        //     must not loop into a stuck task). Lead stays for manual follow-up.
        if (!input.reply_to) {
            try {
                await yelpLeadQueries.markGreeted(input.claim_id, {
                    leadId: input.lead_id,
                    threadToken: input.thread_token,
                    status: 'handled_no_send',
                });
            } catch (e) {
                console.error('[yelp_lead] markGreeted(handled_no_send) failed (non-fatal):', e && e.message);
            }
            return { skipped: 'no_reply_to', lead_id: input.lead_id };
        }

        // (2) One-reply-per-thread guard FIRST → a retry after a prior successful send
        //     short-circuits here (no 2nd send). This is what makes retry safe.
        if (await yelpLeadQueries.threadAlreadyGreeted(task.company_id, input.thread_token)) {
            return { skipped: 'already_greeted', lead_id: input.lead_id };
        }

        // (3) Build the greeting (never throws; Gemini + static fallback).
        const body = await require('./yelpGreetingService').buildGreeting({
            name: input.customer_name,
            service: input.service_type,
            problem: input.problem_text,
        });

        // (4) Send via the company mailbox back through the Yelp relay. THE ONLY
        //     throw that reaches the worker → drives the retry (nothing sent yet).
        //     Yelp's reply-by-email parser needs BOTH the threading headers
        //     (In-Reply-To/References + the Gmail thread) AND the Gmail-style quoted
        //     original under multipart/alternative — a bare single-part body bounces
        //     with cant_parse ("email client we do not yet support"). Best-effort: a
        //     lookup miss degrades to an unquoted send (a late greeting beats none).
        let subject = `Re: ${input.service_type || 'your'} request`;
        let threading = {};
        let quote = null;
        try {
            const row = await require('../db/emailQueries')
                .getThreadingByProviderMessageId(input.provider_message_id, task.company_id);
            if (row && row.message_id_header) {
                threading = {
                    inReplyTo: row.message_id_header,
                    references: row.message_id_header,
                    threadId: row.provider_thread_id || undefined,
                };
                quote = row;
                if (row.subject) subject = /^\s*re:/i.test(row.subject) ? row.subject : `Re: ${row.subject}`;
            }
        } catch (e) {
            console.error('[yelp_lead] threading lookup failed (send unthreaded):', e && e.message);
        }
        const bodies = require('./yelpReplyFormat').buildReplyBodies(body, quote);
        const sent = await require('./emailService').sendEmail(task.company_id, {
            to: input.reply_to,
            subject,
            body: bodies.html,
            textBody: bodies.text,
            ...threading,
        });

        // (5) Finalize the ledger — best-effort ONLY. A throw here AFTER a successful
        //     send would make the worker retry and double-send, so we swallow it (the
        //     email is the source of truth).
        try {
            await yelpLeadQueries.markGreeted(input.claim_id, {
                leadId: input.lead_id,
                threadToken: input.thread_token,
                greetingProviderMessageId: (sent && sent.provider_message_id) || null,
                status: 'greeted',
            });
        } catch (e) {
            console.error('[yelp_lead] markGreeted failed (non-fatal, not re-sent):', e && e.message);
        }

        // (5b) Link the sent greeting onto the conv-id timeline — best-effort and
        //      independent of the post-send ledger marker above. A link fault must
        //      never re-queue this task after the email is already out.
        const timelineId = quote && quote.timeline_id != null ? quote.timeline_id : null;
        let linkOutcome = 'resolve_miss';
        if (timelineId != null) {
            try {
                const linkResult = await require('./email/emailTimelineService').linkYelpAgentSend(
                    task.company_id,
                    {
                        providerMessageId: sent && sent.provider_message_id,
                        providerThreadId: sent && sent.provider_thread_id,
                        timelineId,
                    }
                );
                linkOutcome = (linkResult && linkResult.outcome) || 'error';
            } catch (_) {
                linkOutcome = 'error';
            }
        }
        console.log(
            '[yelp_lead] send-link company=%s msg=%s timeline=%s outcome=%s',
            task.company_id,
            sent && sent.provider_message_id,
            timelineId,
            linkOutcome
        );

        return {
            greeted: true,
            to: input.reply_to,
            lead_id: input.lead_id,
            provider_message_id: (sent && sent.provider_message_id) || null,
        };
    },

    // YELP-CONVO-BOOKING-001 — `yelp_convo` turn handler. Order MIRRORS yelp_lead:
    // guard (per-inbound claim) FIRST → at-most-once per inbound message (a poll
    // re-scan or a worker retry of the SAME inbound never double-runs).
    //   • YELP_CONVO_ENABLED OFF (Phase A) → a thin durable ACK: record the turn on the
    //     conversation (no LLM, no send). No sendEmail throw-surface → never retried.
    //   • YELP_CONVO_ENABLED ON (Phase B) → the real brain: yelpConvoAgentService.runTurn
    //     runs the bounded JSON-action loop, sends the ONE email, and books/hands-off +
    //     persists conversation state itself. The ONLY throw that reaches the worker is a
    //     sendEmail fault (drives the opt-in retry; the inbound is NOT markReplied so the
    //     retry actually re-attempts the send). markReplied is the POST-SEND best-effort
    //     marker (a throw after the email is out is swallowed — the email is the truth).
    async yelp_convo(task) {
        const input = task.agent_input || {};
        const companyId = task.company_id;
        const convId = input.conversation_id;
        const pmid = input.inbound_provider_message_id;
        const yelpLeadQueries = require('../db/yelpLeadQueries');
        const yelpConversationQueries = require('../db/yelpConversationQueries');

        // (1) Load state. No row (a race, or a conversation gone) → soft no-op, done.
        let conv = null;
        try {
            conv = await yelpConversationQueries.getByConvId(companyId, convId);
        } catch (e) {
            console.error('[yelp_convo] getByConvId failed (non-fatal):', e && e.message);
        }
        if (!conv) {
            return { skipped: 'no_conversation', conversation_id: convId };
        }

        // (2) Per-inbound claim FIRST — the durable at-most-once gate (reuses the
        //     yelp_lead_events ledger). Not claimed ⇒ this inbound was already handled
        //     (push+poll overlap, or a retry) ⇒ skip WITHOUT throwing (a throw would
        //     re-queue and loop). This is what SAB-IDEM-DROP-CLAIM removes.
        let claim;
        try {
            claim = await yelpLeadQueries.claimYelpLead(companyId, pmid);
        } catch (e) {
            console.error('[yelp_convo] claim failed (non-fatal, no double-ack):', e && e.message);
            return { skipped: 'claim_error', conversation_id: convId };
        }
        if (!claim || !claim.claimed) {
            return { skipped: 'already_handled_inbound', conversation_id: convId };
        }

        if (!input.greeting && !String(input.inbound_body_text || '').trim()) {
            return { skipped: 'no_reply_content', conversation_id: convId };
        }

        // (3a) Phase A (brain OFF): record the turn (bump turn_count, stamp inbound).
        //      No LLM, no send. Best-effort — a post-claim persist failure is non-fatal.
        const convoEnabled = /^(1|true|yes|on)$/i.test(String(process.env.YELP_CONVO_ENABLED || '').trim());
        if (!convoEnabled) {
            const nextTurn = (conv.turn_count || 0) + 1;
            try {
                await yelpConversationQueries.updateState(companyId, convId, {
                    turn_count: nextTurn,
                    last_inbound_message_id: pmid,
                });
            } catch (e) {
                console.error('[yelp_convo] updateState failed (non-fatal):', e && e.message);
            }
            return { acked: true, phase_a: true, conversation_id: convId, turn_count: nextTurn };
        }

        // (3b) Phase B (brain ON): run the bounded tool-loop. runTurn sends the one email
        //      and persists conversation state; it throws ONLY on a sendEmail fault, which
        //      we deliberately let propagate (worker retry re-attempts the send).
        const inbound = { provider_message_id: pmid, body_text: input.inbound_body_text };
        const result = await require('./yelpConvoAgentService').runTurn(companyId, conv, inbound);

        // (4) POST-SEND marker (best-effort; swallowed — the email is already out, so a
        //     throw here must NOT re-queue/double-send). Mirrors yelp_lead markGreeted.
        //     TURN-0 GREETING (input.greeting): stamp the SAME thread_token greeted-marker
        //     that threadAlreadyGreeted() reads — via markGreeted on THIS inbound's claim
        //     row — so a later lost-lead-claim reconcile that falls to the yelp_lead greeter
        //     sees threadAlreadyGreeted(thread_token)===true and SUPPRESSES (unified dedup
        //     namespace; never a double customer greeting). A reply turn keeps the lighter
        //     markReplied status marker.
        try {
            if (input.greeting && claim && claim.id != null) {
                await yelpLeadQueries.markGreeted(claim.id, {
                    leadId: input.lead_id,
                    threadToken: input.thread_token,
                    status: 'greeted',
                });
            } else {
                await yelpLeadQueries.markReplied(companyId, pmid);
            }
        } catch (e) {
            console.error('[yelp_convo] post-send marker failed (non-fatal, not re-sent):', e && e.message);
        }
        try {
            await yelpConversationQueries.updateState(companyId, convId, { last_inbound_message_id: pmid });
        } catch (e) {
            console.error('[yelp_convo] updateState(last_inbound) failed (non-fatal):', e && e.message);
        }

        return { handled: true, conversation_id: convId, outcome: result && result.outcome };
    },

    // Summarize a conversation thread (heuristic; LLM provider optional).
    async summarize_thread(task) {
        const input = task.agent_input || {};
        const timelineId = input.timeline_id || task.thread_id;
        if (!timelineId) throw new Error('summarize_thread requires a timeline_id');
        const { rows } = await db.query(
            `SELECT m.author, m.direction, m.body, m.created_at
             FROM sms_messages m
             JOIN sms_conversations c ON c.id = m.conversation_id AND c.company_id = $2
             JOIN timelines t ON regexp_replace(t.phone_e164, '\\D', '', 'g') = regexp_replace(c.customer_e164, '\\D', '', 'g')
             WHERE t.id = $1
             ORDER BY m.created_at DESC LIMIT 20`,
            [timelineId, task.company_id]
        );
        const lines = rows.reverse().map(r => `${r.direction === 'inbound' ? 'Customer' : 'Us'}: ${(r.body || '').slice(0, 120)}`);
        const summary = lines.length
            ? `Last ${lines.length} messages. ${lines.slice(-3).join(' | ')}`
            : 'No messages in this thread.';
        return { timeline_id: timelineId, message_count: rows.length, summary };
    },
};

async function run(task) {
    const handler = HANDLERS[task.agent_type];
    if (!handler) throw new Error(`Unknown agent_type: ${task.agent_type}`);
    return handler(task);
}

module.exports = { run, HANDLERS };
