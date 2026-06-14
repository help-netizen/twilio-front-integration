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
            authz: { permissions: ['tenant.company.manage'], company: {} },
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
