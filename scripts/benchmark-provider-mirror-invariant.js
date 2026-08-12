#!/usr/bin/env node
'use strict';

// Reproducible local-only benchmark for PROVIDER-MIRROR-INVARIANT-001.
// It creates and removes isolated schemas; no application or production rows
// are read or changed.

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/twilio_calls';
const JOB_COUNT = Number(process.env.PROVIDER_MIRROR_BENCH_JOBS || 1602);
const ITERATIONS = Number(process.env.PROVIDER_MIRROR_BENCH_ITERATIONS || 6);
const migration = fs.readFileSync(path.join(
  __dirname,
  '..',
  'backend',
  'db',
  'migrations',
  '258_provider_mirror_invariant.sql'
), 'utf8');

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function explainStats(result) {
  const report = result.rows[0]['QUERY PLAN'][0];
  const plan = report.Plan;
  const triggerMs = (report.Triggers || []).reduce(
    (total, trigger) => total + Number(trigger.Time || 0),
    0
  );
  return {
    execution_ms: Number(report['Execution Time']),
    planning_ms: Number(report['Planning Time']),
    shared_hit_blocks: Number(plan['Shared Hit Blocks'] || 0),
    shared_read_blocks: Number(plan['Shared Read Blocks'] || 0),
    dirtied_blocks: Number(plan['Shared Dirtied Blocks'] || 0),
    written_blocks: Number(plan['Shared Written Blocks'] || 0),
    trigger_ms: triggerMs,
  };
}

function summarize(samples) {
  // The first iteration warms relation/function caches; report the median of
  // the remaining samples so both variants receive the same treatment.
  const measured = samples.slice(1);
  const keys = Object.keys(measured[0]);
  return Object.fromEntries(keys.map(key => [
    key,
    Number(median(measured.map(sample => sample[key])).toFixed(3)),
  ]));
}

async function createTables(client) {
  await client.query(`
    CREATE TABLE company_memberships (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      company_id UUID NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, company_id)
    );
    CREATE TABLE technicians (
      id UUID PRIMARY KEY,
      company_id UUID NOT NULL,
      display_name TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      crm_user_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (company_id, id)
    );
    CREATE UNIQUE INDEX uq_bench_technicians_company_crm_user
      ON technicians (company_id, crm_user_id)
      WHERE crm_user_id IS NOT NULL;
    CREATE TABLE technician_external_identities (
      company_id UUID NOT NULL,
      source TEXT NOT NULL,
      external_id TEXT NOT NULL,
      technician_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (company_id, source, external_id)
    );
    CREATE INDEX idx_bench_external_identity_technician
      ON technician_external_identities (company_id, technician_id, source);
    CREATE TABLE jobs (
      id BIGSERIAL PRIMARY KEY,
      company_id UUID NOT NULL,
      assigned_techs JSONB NOT NULL DEFAULT '[]'::jsonb,
      assigned_provider_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX idx_bench_jobs_company ON jobs (company_id);
    CREATE INDEX idx_bench_jobs_provider_mirror
      ON jobs USING gin (assigned_provider_user_ids jsonb_path_ops);
  `);
}

async function runVariant(pool, withInvariant) {
  const client = await pool.connect();
  const schema = `provider_mirror_bench_${withInvariant ? 'after' : 'before'}_${randomUUID().replaceAll('-', '')}`;
  const companyId = randomUUID();
  const userId = randomUUID();
  const technicianId = randomUUID();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await createTables(client);
    await client.query(
      `INSERT INTO company_memberships (user_id, company_id, status)
       VALUES ($1, $2, 'active')`,
      [userId, companyId]
    );
    await client.query(
      `INSERT INTO technicians
          (id, company_id, display_name, active, crm_user_id)
       VALUES ($1, $2, 'Benchmark technician', TRUE, $3)`,
      [technicianId, companyId, userId]
    );
    if (withInvariant) await client.query(migration);

    await client.query(
      `INSERT INTO jobs (company_id)
       SELECT $1 FROM generate_series(1, $2::int)`,
      [companyId, JOB_COUNT]
    );
    await client.query('ANALYZE jobs');

    const assignedTechs = JSON.stringify([{ id: technicianId, name: 'Benchmark technician' }]);
    const providerIds = JSON.stringify([userId]);
    const bulkSamples = [];
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      await client.query(
        `UPDATE jobs
         SET assigned_techs = '[]'::jsonb,
             assigned_provider_user_ids = '[]'::jsonb
         WHERE company_id = $1`,
        [companyId]
      );
      const explained = await client.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
         UPDATE jobs
         SET assigned_techs = $2::jsonb,
             assigned_provider_user_ids = $3::jsonb,
             updated_at = NOW()
         WHERE company_id = $1`,
        [companyId, assignedTechs, providerIds]
      );
      bulkSamples.push(explainStats(explained));
    }

    await client.query('TRUNCATE jobs RESTART IDENTITY');
    const importSamples = [];
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      await client.query('TRUNCATE jobs RESTART IDENTITY');
      await client.query('ALTER TABLE jobs DISABLE TRIGGER ALL');
      const insertExplained = await client.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
         INSERT INTO jobs
             (company_id, assigned_techs, assigned_provider_user_ids)
         SELECT $1, $3::jsonb, '[]'::jsonb
         FROM generate_series(1, $2::int)`,
        [companyId, JOB_COUNT, assignedTechs]
      );
      await client.query('ALTER TABLE jobs ENABLE TRIGGER ALL');

      let refresh = {
        execution_ms: 0,
        planning_ms: 0,
        shared_hit_blocks: 0,
        shared_read_blocks: 0,
        dirtied_blocks: 0,
        written_blocks: 0,
        trigger_ms: 0,
      };
      if (withInvariant) {
        await client.query(
          'ALTER TABLE jobs ENABLE ALWAYS TRIGGER trg_jobs_provider_mirror_insert'
        );
        await client.query(
          'ALTER TABLE jobs ENABLE ALWAYS TRIGGER trg_jobs_provider_mirror_update'
        );
        const refreshExplained = await client.query(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
           SELECT refresh_job_provider_mirrors(
             ARRAY[$1]::uuid[], NULL, NULL, TRUE
           )`,
          [companyId]
        );
        refresh = explainStats(refreshExplained);
      }
      const insert = explainStats(insertExplained);
      importSamples.push({
        execution_ms: insert.execution_ms + refresh.execution_ms,
        planning_ms: insert.planning_ms + refresh.planning_ms,
        shared_hit_blocks: insert.shared_hit_blocks + refresh.shared_hit_blocks,
        shared_read_blocks: insert.shared_read_blocks + refresh.shared_read_blocks,
        dirtied_blocks: insert.dirtied_blocks + refresh.dirtied_blocks,
        written_blocks: insert.written_blocks + refresh.written_blocks,
        trigger_ms: insert.trigger_ms + refresh.trigger_ms,
        insert_ms: insert.execution_ms,
        recompute_ms: refresh.execution_ms,
      });
    }

    const { rows: drift } = await client.query(
      `SELECT COUNT(*)::int AS count
       FROM jobs
       WHERE company_id = $1
         AND assigned_provider_user_ids IS DISTINCT FROM $2::jsonb`,
      [companyId, providerIds]
    );

    return {
      bulk_reassign: summarize(bulkSamples),
      trigger_disabled_import: summarize(importSamples),
      final_drift_rows: drift[0].count,
    };
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    client.release();
  }
}

(async () => {
  if (!Number.isInteger(JOB_COUNT) || JOB_COUNT < 1) {
    throw new Error('PROVIDER_MIRROR_BENCH_JOBS must be a positive integer');
  }
  if (!Number.isInteger(ITERATIONS) || ITERATIONS < 2) {
    throw new Error('PROVIDER_MIRROR_BENCH_ITERATIONS must be an integer >= 2');
  }

  const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
  try {
    const before = await runVariant(pool, false);
    const after = await runVariant(pool, true);
    const ratio = (afterValue, beforeValue) => Number(
      (afterValue / beforeValue).toFixed(2)
    );
    console.log(JSON.stringify({
      database: 'local isolated PostgreSQL schemas',
      job_count: JOB_COUNT,
      iterations: ITERATIONS,
      reported_statistic: `median of ${ITERATIONS - 1} runs after one warm-up`,
      before,
      after,
      ratios: {
        bulk_reassign_execution: ratio(
          after.bulk_reassign.execution_ms,
          before.bulk_reassign.execution_ms
        ),
        trigger_disabled_import_total: ratio(
          after.trigger_disabled_import.execution_ms,
          before.trigger_disabled_import.execution_ms
        ),
      },
    }, null, 2));
  } finally {
    await pool.end();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
