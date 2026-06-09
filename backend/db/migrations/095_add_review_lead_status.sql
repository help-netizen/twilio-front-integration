-- Add a Review lead state for AI-created leads that need dispatcher review.
-- The normal initial state remains Submitted; Vapi-created leads are inserted as Review.

DO $$
DECLARE
    rec RECORD;
    new_scxml TEXT;
    new_version_id UUID;
BEGIN
    FOR rec IN
        SELECT
            m.id AS machine_id,
            m.company_id,
            v.scxml_source
        FROM fsm_machines m
        JOIN fsm_versions v ON v.id = m.active_version_id
        WHERE m.machine_key = 'lead'
          AND v.scxml_source NOT LIKE '%id="Review"%'
    LOOP
        new_scxml := replace(
            rec.scxml_source,
            '  <state id="Submitted" blanc:label="Submitted">',
            '  <state id="Review" blanc:label="Review">
    <transition event="TO_SUBMITTED" target="Submitted" blanc:action="true" blanc:label="Reviewed" blanc:order="1" />
    <transition event="TO_CONTACTED" target="Contacted" blanc:action="true" blanc:label="Contacted" blanc:order="2" />
    <transition event="TO_LOST" target="Lost" blanc:action="true" blanc:label="Lost" blanc:order="3" blanc:confirm="true" blanc:confirmText="Are you sure you want to mark this lead as lost?" />
  </state>

  <state id="Submitted" blanc:label="Submitted">'
        );

        IF new_scxml = rec.scxml_source THEN
            RAISE NOTICE 'Lead FSM % was not updated: Submitted state marker not found', rec.machine_id;
            CONTINUE;
        END IF;

        UPDATE fsm_versions
        SET status = 'archived'
        WHERE machine_id = rec.machine_id
          AND status = 'published';

        INSERT INTO fsm_versions (
            machine_id,
            company_id,
            version_number,
            status,
            scxml_source,
            change_note,
            created_by,
            published_by,
            published_at
        )
        SELECT
            rec.machine_id,
            rec.company_id,
            COALESCE(MAX(version_number), 0) + 1,
            'published',
            new_scxml,
            'Add Review status for AI-created leads',
            'system',
            'system',
            NOW()
        FROM fsm_versions
        WHERE machine_id = rec.machine_id
        RETURNING id INTO new_version_id;

        UPDATE fsm_machines
        SET active_version_id = new_version_id,
            updated_at = NOW()
        WHERE id = rec.machine_id;
    END LOOP;
END $$;
