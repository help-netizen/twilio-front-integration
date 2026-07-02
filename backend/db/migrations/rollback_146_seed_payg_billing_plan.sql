-- =============================================================================
-- Rollback 146: deactivate the "Pay as you go" plan.
-- Deliberately NOT a DELETE — billing_subscriptions.plan_id may already
-- reference 'payg' (FK). Deactivating removes it from plan lists
-- (SELECT … WHERE is_active) while existing subscriptions keep working.
-- Idempotent.
-- =============================================================================

UPDATE billing_plans SET is_active = false WHERE id = 'payg';
