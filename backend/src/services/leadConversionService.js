'use strict';

const { logJobActivity } = require('./jobActivityService');
const {
    logLeadContactActivity,
    systemActor,
} = require('./leadContactActivityService');
const { withTransaction } = require('./transactionService');

const ALLOWED_LEAD_UPDATE_COLUMNS = new Set([
    'contact_id',
    'zenbooker_job_id',
    'job_type',
    'lead_notes',
    'address',
    'unit',
    'city',
    'state',
    'postal_code',
    'phone',
    'email',
]);

function conversionError(code, message, httpStatus) {
    return Object.assign(new Error(message), { code, httpStatus });
}

/**
 * Canonical company-scoped Lead -> Job conversion transaction.
 *
 * The caller supplies the local job create/reuse operation because convertLead
 * and jobsService.createJob have different job payloads. The invariant-bearing
 * sequence lives here: lock Lead, reject Lost, create/reuse a linked Job, write
 * both conversion fields, and record both History activities before commit.
 */
async function convertLeadWithJob({
    companyId,
    leadId,
    activityActor = null,
    leadUpdates = {},
    createOrReuseJob,
}) {
    if (!companyId) {
        throw conversionError('TENANT_CONTEXT_REQUIRED', 'Company context is required', 403);
    }
    if (!leadId) {
        throw conversionError('LEAD_ID_REQUIRED', 'Lead id is required', 400);
    }
    if (typeof createOrReuseJob !== 'function') {
        throw new Error('createOrReuseJob is required');
    }

    const actor = activityActor || systemActor('Albusto', 'crm');

    return withTransaction(async (client) => {
        const { rows: leadRows } = await client.query(
            `SELECT *
             FROM leads
             WHERE id = $1 AND company_id = $2
             FOR UPDATE`,
            [leadId, companyId]
        );
        if (leadRows.length === 0) {
            throw conversionError('LEAD_NOT_FOUND', `Lead #${leadId} not found`, 404);
        }

        const lead = leadRows[0];
        if (lead.lead_lost === true || String(lead.status || '').toLowerCase() === 'lost') {
            throw conversionError('LEAD_LOST', 'A lost lead cannot be converted', 409);
        }

        const jobResult = await createOrReuseJob({ client, lead });
        const jobId = jobResult?.jobId;
        if (!jobId) {
            throw new Error('Lead conversion requires a created or linked job');
        }

        const linkedJob = await client.query(
            `SELECT id
             FROM jobs
             WHERE id = $1 AND lead_id = $2 AND company_id = $3`,
            [jobId, lead.id, companyId]
        );
        if (linkedJob.rows.length === 0) {
            throw new Error('Lead conversion job is not linked to the lead in this company');
        }

        const mergedLeadUpdates = {
            ...leadUpdates,
            ...(jobResult.leadUpdates || {}),
        };
        const setClauses = [
            "status = 'Converted'",
            'converted_to_job = true',
        ];
        const values = [lead.id, companyId];
        for (const [column, value] of Object.entries(mergedLeadUpdates)) {
            if (!ALLOWED_LEAD_UPDATE_COLUMNS.has(column) || value === undefined) continue;
            values.push(value);
            setClauses.push(`${column} = $${values.length}`);
        }

        const { rows: updatedRows } = await client.query(
            `UPDATE leads
             SET ${setClauses.join(', ')}
             WHERE id = $1 AND company_id = $2
             RETURNING id, uuid, status, converted_to_job`,
            values
        );
        if (updatedRows.length === 0) {
            throw conversionError('LEAD_NOT_FOUND', `Lead #${leadId} not found`, 404);
        }

        const conversionChanged = lead.status !== 'Converted' || lead.converted_to_job !== true;
        if (conversionChanged) {
            const summary = {
                job_id: jobId,
                status: 'Converted',
                previous_status: lead.status,
            };
            await logLeadContactActivity({
                companyId,
                entityType: 'lead',
                action: 'lead.converted',
                entityId: lead.id,
                actor,
                summary,
            }, { client });
            await logLeadContactActivity({
                companyId,
                entityType: 'lead',
                action: 'lead.status_changed',
                entityId: lead.id,
                actor,
                summary,
            }, { client });
        }

        if (jobResult.jobCreated) {
            await logJobActivity({
                companyId,
                action: 'job.created',
                jobId,
                actor,
                summary: { status: jobResult.jobStatus || 'Submitted' },
            }, { client });
        }

        return {
            lead: updatedRows[0],
            previousLead: lead,
            conversionChanged,
            ...jobResult,
        };
    });
}

module.exports = { convertLeadWithJob };
