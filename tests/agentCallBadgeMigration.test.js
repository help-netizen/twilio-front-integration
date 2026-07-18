const fs = require('fs');
const path = require('path');

const migrationsDir = path.join(__dirname, '..', 'backend', 'db', 'migrations');
const forwardSql = fs.readFileSync(
    path.join(migrationsDir, '180_backfill_ai_answered_inbound_calls.sql'),
    'utf8'
);
const rollbackSql = fs.readFileSync(
    path.join(migrationsDir, 'rollback_180_backfill_ai_answered_inbound_calls.sql'),
    'utf8'
);

describe('AGENT-CALL-BADGE-001 migration 180', () => {
    it('idempotently marks only inbound root parents with completed VAPI child evidence', () => {
        expect(forwardSql).toContain("SET answered_by = 'ai'");
        expect(forwardSql).toContain("parent.answered_by IS DISTINCT FROM 'ai'");
        expect(forwardSql).toContain('parent.parent_call_sid IS NULL');
        expect(forwardSql).toContain("parent.direction = 'inbound'");
        expect(forwardSql).toContain("child.status = 'completed'");
        expect(forwardSql).toContain('child.parent_call_sid = parent.call_sid');
        expect(forwardSql).toContain('child.company_id = parent.company_id');
        expect(forwardSql).toMatch(/child\.to_number\s+~\*[\s\S]*vapi\\\.ai/);
        expect(forwardSql).not.toContain('ai_agent');
    });

    it('documents a non-destructive no-op rollback', () => {
        expect(rollbackSql).toContain('documented no-op');
        expect(rollbackSql).toMatch(/SELECT\s+1\s*;/i);
        expect(rollbackSql).not.toMatch(/\bUPDATE\s+calls\b/i);
        expect(rollbackSql).not.toMatch(/\bDELETE\s+FROM\s+calls\b/i);
    });
});
