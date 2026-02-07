# Database Migrations

## Overview

This directory contains database migrations for the Twilio Call Viewer real-time architecture.

## Migration Files

Migrations should be applied in numerical order:

1. **001_create_webhook_inbox.sql** - Webhook ingestion queue
2. **002_create_call_events.sql** - Immutable event log
3. **003_create_sync_state.sql** - Reconciliation job cursors
4. **004_alter_messages.sql** - Add event-driven update fields

## How to Apply Migrations

### Using psql

```bash
# Apply all migrations
psql twilio_calls < backend/db/migrations/001_create_webhook_inbox.sql
psql twilio_calls < backend/db/migrations/002_create_call_events.sql
psql twilio_calls < backend/db/migrations/003_create_sync_state.sql
psql twilio_calls < backend/db/migrations/004_alter_messages.sql
```

### Using Node.js script

```bash
# Create migration runner script
node backend/db/migrate.js
```

## Rollback

To roll back migrations in reverse order:

```bash
psql twilio_calls < backend/db/migrations/rollback_004_alter_messages.sql
psql twilio_calls < backend/db/migrations/rollback_003_sync_state.sql
psql twilio_calls < backend/db/migrations/rollback_002_call_events.sql
psql twilio_calls < backend/db/migrations/rollback_001_webhook_inbox.sql
```

## Verification

After applying migrations, verify with:

```sql
-- Check new tables exist
SELECT table_name FROM information_schema.tables 
WHERE table_schema = 'public' 
  AND table_name IN ('twilio_webhook_inbox', 'call_events', 'sync_state');

-- Check new columns in messages
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'messages' 
  AND column_name IN ('updated_at', 'last_event_time', 'is_final', 'finalized_at', 'sync_state');

-- Check indexes
SELECT indexname FROM pg_indexes 
WHERE tablename IN ('messages', 'twilio_webhook_inbox', 'call_events');
```

## Safety Notes

- ⚠️ **Backup database before applying migrations**
- ⚠️ **Test migrations on staging environment first**
- ⚠️ **Run EXPLAIN ANALYZE on new indexes to verify performance**
- ⚠️ **Monitor database size after adding new tables**

## Schema Changes

### New Tables

- `twilio_webhook_inbox`: Webhook ingestion with deduplication
- `call_events`: Immutable event log for audit trail
- `sync_state`: Reconciliation job state tracking

### Modified Tables

- `messages`: Added 5 new columns for event-driven architecture
  - `updated_at`: Auto-updated timestamp
  - `last_event_time`: Last event timestamp (out-of-order guard)
  - `is_final`: Boolean flag for terminal status
  - `finalized_at`: When call reached final status
  - `sync_state`: Lifecycle state (active/frozen)
