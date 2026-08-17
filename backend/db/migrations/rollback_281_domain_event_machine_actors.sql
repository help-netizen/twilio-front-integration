DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM domain_events
        WHERE actor_type IN ('ai', 'integration')
    ) THEN
        RAISE EXCEPTION
            'DOMAIN_EVENT_MACHINE_ACTORS_ROLLBACK_BLOCKED: preserve machine-authored events first';
    END IF;
END $$;

ALTER TABLE domain_events
    DROP CONSTRAINT IF EXISTS domain_events_actor_type_check;

ALTER TABLE domain_events
    ADD CONSTRAINT domain_events_actor_type_check
    CHECK (actor_type IN ('user', 'system', 'client', 'webhook'));

