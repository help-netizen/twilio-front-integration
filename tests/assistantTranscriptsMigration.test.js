'use strict';

const fs = require('fs');
const path = require('path');

const migrationDir = path.join(__dirname, '..', 'backend', 'db', 'migrations');

describe('migration 174 assistant storage', () => {
    test('creates an identity-free transcript table and operational quota table', () => {
        const source = fs.readFileSync(
            path.join(migrationDir, '174_assistant_transcripts.sql'),
            'utf8'
        );
        const transcript = source.match(
            /CREATE TABLE IF NOT EXISTS assistant_transcripts \(([\s\S]*?)\n\);/
        )?.[1];

        expect(transcript).toBeTruthy();
        for (const column of [
            'id', 'session_key', 'turn_index', 'role', 'text', 'tools_used',
            'model', 'latency_ms', 'token_usage', 'created_at',
        ]) {
            expect(transcript).toMatch(new RegExp(`\\b${column}\\b`));
        }
        expect(transcript).not.toMatch(/\bcompany_id\b|\buser_id\b|\buser_email\b|\bemail\b/i);
        expect(transcript).toContain("CHECK (role IN ('user', 'assistant'))");
        expect(transcript).toContain('CHECK (turn_index >= 0)');
        expect(source).toMatch(/CREATE TABLE IF NOT EXISTS assistant_usage_counters/);
        expect(source).toMatch(/PRIMARY KEY \(company_id, usage_date\)/);
    });

    test('rollback drops both A3 tables', () => {
        const source = fs.readFileSync(
            path.join(migrationDir, 'rollback_174_assistant_transcripts.sql'),
            'utf8'
        );
        expect(source).toContain('DROP TABLE IF EXISTS assistant_usage_counters;');
        expect(source).toContain('DROP TABLE IF EXISTS assistant_transcripts;');
        expect(source.indexOf('assistant_usage_counters'))
            .toBeLessThan(source.indexOf('assistant_transcripts'));
    });
});
