-- OB-71: what the SERVER established during one inbound Vapi call, so a lead is
-- built from evidence rather than from whatever the model chose to restate.
--
-- The voice model calls createLead with `{}` intermittently (observed on prod
-- 2026-08-19 and again 2026-08-20 after `strict` was enabled — the schema's own
-- `required` is enforced by nobody on this path). Every fact it omits was already
-- handed to us minutes earlier by its OWN earlier tool calls: the address by
-- validateAddress, the town by checkServiceArea, the appliance by recommendSlots.
-- This table keeps those, keyed by the authenticated provider call, so the gaps
-- can be filled at write time.
--
-- Deliberately separate from vapi_recommend_slots_call_audits: that row is
-- evidence of what the slot engine was asked and answered, and the booking guard
-- reads its `invocations` shape. Structure only; no provider or tenant data is
-- discovered or seeded here.

CREATE TABLE IF NOT EXISTS vapi_inbound_call_facts (
    provider_call_id TEXT PRIMARY KEY,
    company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    facts            JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_vapi_inbound_call_facts_object
        CHECK (jsonb_typeof(facts) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_vapi_inbound_call_facts_company_created
    ON vapi_inbound_call_facts(company_id, created_at DESC);

COMMENT ON TABLE vapi_inbound_call_facts IS
    'Server-established facts for one authenticated inbound Vapi call: what our own tools resolved, used to fill the gaps a model-supplied createLead leaves.';
COMMENT ON COLUMN vapi_inbound_call_facts.facts IS
    'Flat object of createLead-shaped keys (street, apt, city, state, zip, unitType, lat, lng, firstName, lastName, contactId). Only values our tools RETURNED are stored; nothing is inferred.';
