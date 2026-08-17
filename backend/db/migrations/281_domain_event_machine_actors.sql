-- Activity actors already distinguish AI and integration writes. Keep the
-- canonical domain-event stream compatible with that established vocabulary.

ALTER TABLE domain_events
    DROP CONSTRAINT IF EXISTS domain_events_actor_type_check;

ALTER TABLE domain_events
    ADD CONSTRAINT domain_events_actor_type_check
    CHECK (actor_type IN (
        'user', 'system', 'client', 'webhook', 'ai', 'integration'
    ));

