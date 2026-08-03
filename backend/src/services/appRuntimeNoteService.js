'use strict';

const db = require('../db/connection');
const { requireCompanyId } = require('../db/crmUtils');
const { resolveProviderScope } = require('../middleware/providerScope');
const crmNotesService = require('./crmNotesService');
const { appRuntimeError } = require('./appRuntimeErrors');

const DAILY_NOTE_LIMIT = 100;
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;
const PARENTS = Object.freeze({
    job: Object.freeze({ table: 'jobs', notesColumn: 'notes' }),
    lead: Object.freeze({ table: 'leads', notesColumn: 'structured_notes' }),
});

function requireActiveContext(context) {
    const companyId = context?.company_id;
    requireCompanyId(companyId);
    if (!context.installation_id || !context.app_id || !context.agent_user_id) {
        throw appRuntimeError(
            'APP_RUNTIME_INACTIVE',
            'App runtime authorization is not active.',
            403
        );
    }
    return companyId;
}

function matchingRecentNote(notes, installationId, text, nowMs = Date.now()) {
    const cutoff = nowMs - DEDUP_WINDOW_MS;
    return (Array.isArray(notes) ? notes : []).find(note => {
        if (!note || note.deleted_at || note.text !== text || note.source !== 'app') return false;
        const noteInstallationId = note.installation_id
            || note.agent_input?.installation_id;
        const createdMs = Date.parse(note.created || note.created_at);
        return String(noteInstallationId || '') === String(installationId)
            && Number.isFinite(createdMs)
            && createdMs >= cutoff
            && createdMs <= nowMs;
    }) || null;
}

async function countAppNotesCreatedToday(companyId, installationId, client) {
    const { rows } = await client.query(
        `SELECT COUNT(*)::integer AS count
         FROM (
             SELECT note
             FROM jobs parent
             CROSS JOIN LATERAL jsonb_array_elements(
                 CASE WHEN jsonb_typeof(parent.notes) = 'array'
                      THEN parent.notes ELSE '[]'::jsonb END
             ) note
             WHERE parent.company_id = $1
             UNION ALL
             SELECT note
             FROM leads parent
             CROSS JOIN LATERAL jsonb_array_elements(
                 CASE WHEN jsonb_typeof(parent.structured_notes) = 'array'
                      THEN parent.structured_notes ELSE '[]'::jsonb END
             ) note
             WHERE parent.company_id = $1
         ) app_note
         WHERE note->>'source' = 'app'
           AND COALESCE(
                note->>'installation_id',
                note->'agent_input'->>'installation_id'
           ) = $2
           AND CASE
                WHEN COALESCE(note->>'created', note->>'created_at', '')
                     ~ '^\\d{4}-\\d{2}-\\d{2}T'
                THEN COALESCE(note->>'created', note->>'created_at')::timestamptz
                ELSE NULL
           END >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
        [companyId, String(installationId)]
    );
    return Number(rows[0]?.count || 0);
}

async function addNoteInTransaction(context, args, client, authorization) {
    const companyId = requireActiveContext(context);
    const parent = PARENTS[args.parent_type];
    const parentId = Number(args.parent_id);
    const text = String(args.text || '').trim();
    if (!parent
        || !Number.isSafeInteger(parentId)
        || parentId < 1
        || !text
        || text.length > 1000) {
        throw appRuntimeError('INVALID_ARGUMENTS', 'Tool arguments are invalid.', 422);
    }

    const installation = await client.query(
        `SELECT id
         FROM marketplace_installations
         WHERE company_id = $1
           AND app_id = $2
           AND id = $3
           AND status = 'connected'
         FOR UPDATE`,
        [companyId, context.app_id, context.installation_id]
    );
    if (installation.rows.length !== 1) {
        throw appRuntimeError(
            'APP_RUNTIME_INACTIVE',
            'App runtime authorization is not active.',
            403
        );
    }

    const providerScope = resolveProviderScope(
        authorization?.ownerScopes,
        authorization?.ownerUserId
    );
    const parentParams = [parentId, companyId];
    let jobScopeSql = '';
    if (args.parent_type === 'job' && providerScope.assignedOnly) {
        if (!providerScope.userId) {
            throw appRuntimeError('NOT_FOUND', 'Resource not found.', 404);
        }
        parentParams.push(JSON.stringify([providerScope.userId]));
        jobScopeSql = `
           AND COALESCE(assigned_provider_user_ids, '[]'::jsonb) @> $3::jsonb`;
    }
    const locked = await client.query(
        `SELECT id, COALESCE(${parent.notesColumn}, '[]'::jsonb) AS notes
         FROM ${parent.table}
         WHERE id = $1 AND company_id = $2
         ${jobScopeSql}
         FOR UPDATE`,
        parentParams
    );
    if (locked.rows.length !== 1) {
        throw appRuntimeError('NOT_FOUND', 'Resource not found.', 404);
    }

    const now = new Date();
    const existing = matchingRecentNote(
        locked.rows[0].notes,
        context.installation_id,
        text,
        now.getTime()
    );
    if (existing) return { note: existing, deduplicated: true };

    const createdToday = await countAppNotesCreatedToday(
        companyId,
        context.installation_id,
        client
    );
    if (createdToday >= DAILY_NOTE_LIMIT) {
        throw appRuntimeError(
            'NOTE_DAILY_LIMIT',
            'Daily note creation limit of 100 reached.',
            429
        );
    }

    const created = await crmNotesService.createNote(companyId, {
        entity_type: args.parent_type,
        entity_id: parentId,
        text,
        source: 'app',
    }, {
        actorId: context.agent_user_id,
        actorEmail: context.agent_email,
        actorName: context.agent_full_name || context.agent_email || 'App',
        installationId: context.installation_id,
        source: 'App Studio',
        createdAt: now.toISOString(),
        client,
    });
    return { note: created.note, deduplicated: false };
}

async function addNote(context, args, authorization) {
    const client = await db.pool.connect();
    let result;
    try {
        await client.query('BEGIN');
        result = await addNoteInTransaction(context, args, client, authorization);
        await client.query('COMMIT');
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
        throw error;
    } finally {
        client.release();
    }
    return {
        note_id: result.note.id,
        ...(result.deduplicated ? { deduplicated: true } : {}),
    };
}

module.exports = {
    DAILY_NOTE_LIMIT,
    DEDUP_WINDOW_MS,
    matchingRecentNote,
    countAppNotesCreatedToday,
    addNote,
    addNoteInTransaction,
};
