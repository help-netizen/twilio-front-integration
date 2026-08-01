'use strict';

/**
 * Company-wide SSE is an invalidation channel, never a record delivery channel.
 * Consumers must refetch through company- and record-scoped REST endpoints.
 */
const INVALIDATION_RESOURCES = Object.freeze({
    'agent.status.changed': 'agents',
    'call.created': 'calls',
    'call.updated': 'calls',
    'contact.read': 'contacts',
    'contact.unread': 'contacts',
    'conversation.updated': 'conversations',
    'group.call.accepted': 'calls',
    'group.call.queued': 'calls',
    'group.call.voicemail': 'calls',
    'job.updated': 'jobs',
    'lead.created': 'leads',
    'lead.updated': 'leads',
    'message.added': 'messages',
    'message.delivery': 'messages',
    'recording.ready': 'recordings',
    'thread.action_required': 'conversations',
    'thread.assigned': 'conversations',
    'thread.handled': 'conversations',
    'thread.snoozed': 'conversations',
    'thread.unsnoozed': 'conversations',
    'timeline.read': 'conversations',
    'timeline.unread': 'conversations',
    'transcript.delta': 'transcripts',
    'transcript.finalized': 'transcripts',
    'transcript.ready': 'transcripts',
});

// This producer already emits only a company-scoped cache invalidation. Keep
// its established payload contract while rejecting all other unregistered
// company broadcasts.
const SAFE_COMPANY_EVENTS = Object.freeze({
    'task.changed': true,
});

function projectRealtimePayload(eventType, companyId) {
    const resource = INVALIDATION_RESOURCES[eventType];
    if (resource) {
        return {
            type: eventType,
            company_id: String(companyId),
            resource,
            invalidate: true,
        };
    }

    if (SAFE_COMPANY_EVENTS[eventType]) {
        return {
            company_id: String(companyId),
        };
    }

    return null;
}

module.exports = {
    INVALIDATION_RESOURCES,
    SAFE_COMPANY_EVENTS,
    projectRealtimePayload,
};
