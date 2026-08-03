'use strict';

const db = require('../db/connection');
const {
    APP_EVENT_TYPES,
    projectAppEventPayload,
    validateSyntheticEvent,
} = require('./appEventCatalog');

const SUBSCRIBER_NAME = 'app-event-outbox';

function createAppEventSubscriber({ database = db } = {}) {
    async function onEvent(event) {
        if (!event?.company_id || !APP_EVENT_TYPES.includes(event.event_type)) return 0;
        const payload = projectAppEventPayload(event.event_type, event.payload);
        if (!payload) return 0;
        validateSyntheticEvent({ type: event.event_type, payload });
        const { rows } = await database.query(
            `INSERT INTO app_event_deliveries
                (company_id, installation_id, event_type, payload,
                 status, attempts, coalesced_count, next_attempt_at,
                 last_error, created_at, updated_at)
             SELECT installation.company_id, installation.id, $2, $3::jsonb,
                    'pending', 0, 0, NOW(), NULL, NOW(), NOW()
             FROM marketplace_installations installation
             JOIN app_versions version
               ON version.app_id = installation.app_id
              AND version.id::text = installation.metadata->'app_runtime'->>'version_id'
              AND version.status = 'published'
             WHERE installation.company_id = $1
               AND installation.status = 'connected'
               AND COALESCE(version.scanner_report->'subscribes', '[]'::jsonb) ? $2
             ON CONFLICT (company_id, installation_id, event_type)
                 WHERE status IN ('pending', 'running')
             DO UPDATE
             SET payload = EXCLUDED.payload,
                 coalesced_count = app_event_deliveries.coalesced_count + 1,
                 updated_at = NOW()
             RETURNING id`,
            [event.company_id, event.event_type, JSON.stringify(payload)]
        );
        return rows.length;
    }

    function register(eventBus) {
        eventBus.subscribe(SUBSCRIBER_NAME, APP_EVENT_TYPES, onEvent);
    }

    return { onEvent, register };
}

const singleton = createAppEventSubscriber();

module.exports = {
    SUBSCRIBER_NAME,
    createAppEventSubscriber,
    onEvent: singleton.onEvent,
    register: singleton.register,
};
