-- Rollback for 289. Drops only what 289 created; no other object is touched.
DROP INDEX IF EXISTS idx_vapi_inbound_call_facts_company_created;
DROP TABLE IF EXISTS vapi_inbound_call_facts;
