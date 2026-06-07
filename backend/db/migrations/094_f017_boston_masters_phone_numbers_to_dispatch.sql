-- Migration 094: F017 explicit production phone number assignment.
-- Blanc currently has one tenant, Boston Masters. Assign all existing phone
-- numbers to its Dispatch Team so Phone Numbers, Caller ID validation, and
-- inbound group routing share the same authoritative group mapping.

DO $$
DECLARE
  target_company_id UUID;
  target_group_id TEXT;
BEGIN
  SELECT id
  INTO target_company_id
  FROM companies
  WHERE name = 'Boston Masters'
  ORDER BY created_at NULLS LAST, id
  LIMIT 1;

  IF target_company_id IS NULL THEN
    RAISE NOTICE 'Boston Masters company not found; skipping F017 phone number assignment';
    RETURN;
  END IF;

  SELECT id
  INTO target_group_id
  FROM user_groups
  WHERE company_id = target_company_id::text
    AND name = 'Dispatch Team'
  ORDER BY created_at NULLS LAST, id
  LIMIT 1;

  IF target_group_id IS NULL THEN
    RAISE NOTICE 'Dispatch Team not found for Boston Masters; skipping F017 phone number assignment';
    RETURN;
  END IF;

  UPDATE phone_number_settings
  SET company_id = target_company_id,
      group_id = target_group_id,
      routing_mode = 'client'
  WHERE company_id IS NULL
     OR company_id = target_company_id;

  INSERT INTO user_group_numbers (group_id, phone_number, friendly_name)
  SELECT target_group_id,
         pns.phone_number,
         COALESCE(pns.friendly_name, '')
  FROM phone_number_settings pns
  WHERE pns.company_id = target_company_id
  ON CONFLICT DO NOTHING;
END $$;
