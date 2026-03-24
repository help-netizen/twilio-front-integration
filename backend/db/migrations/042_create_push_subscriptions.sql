-- =============================================================================
-- 042: Create push_subscriptions table for browser Web Push notifications.
-- Each row = one browser/device subscription for one user.
-- =============================================================================

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES crm_users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  browser_name TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  is_active BOOLEAN DEFAULT true
);

-- Fast lookup: all active subscriptions for a company (used during push broadcast)
CREATE INDEX IF NOT EXISTS idx_push_subs_company_active
  ON push_subscriptions(company_id, is_active)
  WHERE is_active = true;

-- Lookup by user (settings page status check)
CREATE INDEX IF NOT EXISTS idx_push_subs_user
  ON push_subscriptions(user_id)
  WHERE is_active = true;

COMMENT ON TABLE push_subscriptions IS 'Browser Web Push subscriptions per user/device';
COMMENT ON COLUMN push_subscriptions.endpoint IS 'Push service endpoint URL from PushSubscription';
COMMENT ON COLUMN push_subscriptions.p256dh IS 'Client public key for payload encryption';
COMMENT ON COLUMN push_subscriptions.auth IS 'Auth secret for payload encryption';
COMMENT ON COLUMN push_subscriptions.is_active IS 'False when subscription is revoked or expired (410 Gone)';
