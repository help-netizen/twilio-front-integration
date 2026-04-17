/**
 * eventService.js — Domain event logging and entity history.
 *
 * Uses the `domain_events` table (migration 069) to store business events.
 * Provides `logEvent()` (fire-and-forget) and `getEntityHistory()` (merged timeline).
 */

const db = require('../db/connection');

// ─── Log Event (fire-and-forget) ─────────────────────────────────────────────

/**
 * @param {string} companyId - UUID
 * @param {string} aggregateType - 'job' | 'lead' | 'contact'
 * @param {string|number} aggregateId - entity ID
 * @param {string} eventType - e.g. 'status_changed', 'created', 'note_added'
 * @param {object} eventData - { description, from, to, actor_name, ... }
 * @param {string} actorType - 'user' | 'system' | 'webhook'
 * @param {string|null} actorId - user sub or null
 */
function logEvent(companyId, aggregateType, aggregateId, eventType, eventData = {}, actorType = 'system', actorId = null) {
    if (!companyId) return;
    db.query(
        `INSERT INTO domain_events (company_id, aggregate_type, aggregate_id, event_type, event_data, actor_type, actor_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [companyId, aggregateType, String(aggregateId), eventType, JSON.stringify(eventData), actorType, actorId]
    ).catch(err => {
        console.error('[EventService] logEvent failed:', err.message);
    });
}

// ─── Helper: build actor display name ────────────────────────────────────────

function actorName(req) {
    if (!req?.user) return 'Unknown';
    return req.user.name?.split(' ')[0] || req.user.email || 'Unknown';
}

// ─── Helper: build description for event type ────────────────────────────────

function describeEvent(eventType, data) {
    switch (eventType) {
        case 'status_changed': return `Status: ${data.from || '?'} → ${data.to || '?'}`;
        case 'created': return data.description || 'Created';
        case 'canceled': return 'Canceled';
        case 'rescheduled': return 'Rescheduled';
        case 'marked_lost': return 'Marked as Lost';
        case 'reactivated': return 'Reactivated';
        case 'converted': return data.job_id ? `Converted to Job #${data.job_id}` : 'Converted to Job';
        case 'team_assigned': return `Assigned: ${data.user_name || 'team member'}`;
        case 'team_unassigned': return `Unassigned: ${data.user_name || 'team member'}`;
        case 'tags_changed': return 'Tags updated';
        case 'synced': return 'Synced from Zenbooker';
        case 'updated': return data.fields ? `Updated: ${data.fields.join(', ')}` : 'Updated';
        case 'note_added': return 'Note added';
        default: return eventType.replace(/_/g, ' ');
    }
}

// ─── Get Entity History (events + notes merged) ──────────────────────────────

async function getEntityHistory(companyId, aggregateType, aggregateId, entityNotes = []) {
    // 1. Fetch domain events
    const { rows: events } = await db.query(
        `SELECT id, event_type, event_data, actor_type, actor_id, created_at
         FROM domain_events
         WHERE company_id = $1 AND aggregate_type = $2 AND aggregate_id = $3
         ORDER BY created_at DESC`,
        [companyId, aggregateType, String(aggregateId)]
    );

    // 2. Convert events to history items
    const historyItems = events
        .filter(e => e.event_type !== 'note_added') // notes come from entity JSONB
        .map(e => ({
            id: `evt_${e.id}`,
            type: 'event',
            event_type: e.event_type,
            description: describeEvent(e.event_type, e.event_data || {}),
            actor: e.event_data?.actor_name || (e.actor_type === 'system' || e.actor_type === 'webhook' ? 'Blanc' : 'Unknown'),
            created_at: e.created_at.toISOString(),
            data: e.event_data || {},
        }));

    // 3. Convert notes to history items
    const noteItems = (entityNotes || []).map((note, i) => ({
        id: `note_${i}`,
        type: 'note',
        event_type: 'note',
        text: note.text || '',
        author: note.author || (note.migrated ? 'Blanc' : null),
        attachments: note.attachments || [],
        actor: note.author || (note.migrated ? 'Blanc' : ''),
        created_at: note.created || new Date().toISOString(),
        data: {},
    }));

    // 4. Merge and sort by created_at DESC
    const merged = [...historyItems, ...noteItems].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );

    return merged;
}

module.exports = { logEvent, actorName, getEntityHistory };
