// import-local-data.js — Import JSON data exported from prod into local DB
// Usage: node scripts/import-local-data.js < /tmp/prod-data.json
const { Pool } = require('pg');
const fs = require('fs');

const LOCAL_DB = process.env.DATABASE_URL || 'postgresql://localhost/twilio_calls';

(async () => {
  // Read JSON from stdin
  const input = fs.readFileSync('/dev/stdin', 'utf8');
  const data = JSON.parse(input);

  const pool = new Pool({ connectionString: LOCAL_DB });
  const client = await pool.connect();

  // All tables that we import (in the order they appear in data keys = FK-safe order)
  const allTables = Object.keys(data);

  try {
    await client.query('BEGIN');

    // Truncate all imported tables in reverse FK order
    const reversed = [...allTables].reverse();
    for (const t of reversed) {
      await client.query(`TRUNCATE ${t} CASCADE`);
    }

    // Disable triggers on all tables
    for (const t of allTables) {
      await client.query(`ALTER TABLE ${t} DISABLE TRIGGER ALL`);
    }

    // Import each table
    for (const [tableName, rows] of Object.entries(data)) {
      if (!rows.length) {
        console.log(`  ${tableName}: 0 rows (skipped)`);
        continue;
      }

      // Get actual columns from local DB to skip columns that don't exist locally
      const colRes = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = $1 AND is_generated = 'NEVER' AND generation_expression IS NULL
         ORDER BY ordinal_position`,
        [tableName]
      );
      const localCols = new Set(colRes.rows.map(r => r.column_name));
      const allCols = Object.keys(rows[0]);
      const cols = allCols.filter(c => localCols.has(c));
      const skipped = allCols.filter(c => !localCols.has(c));
      if (skipped.length) {
        console.log(`  ${tableName}: skipping columns: ${skipped.join(', ')}`);
      }
      const colList = cols.map(c => `"${c}"`).join(', ');

      // Batch insert in chunks of 100
      const chunkSize = 100;
      let imported = 0;

      for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        const values = [];
        const placeholders = [];

        for (let ri = 0; ri < chunk.length; ri++) {
          const row = chunk[ri];
          const rowPlaceholders = [];
          for (let ci = 0; ci < cols.length; ci++) {
            values.push(row[cols[ci]]);
            rowPlaceholders.push(`$${ri * cols.length + ci + 1}`);
          }
          placeholders.push(`(${rowPlaceholders.join(', ')})`);
        }

        await client.query(
          `INSERT INTO ${tableName} (${colList}) VALUES ${placeholders.join(', ')} ON CONFLICT DO NOTHING`,
          values
        );
        imported += chunk.length;
      }

      console.log(`  ${tableName}: ${imported} rows`);
    }

    // Re-enable triggers
    for (const t of allTables) {
      await client.query(`ALTER TABLE ${t} ENABLE TRIGGER ALL`);
    }

    // Reset sequences for tables with BIGSERIAL PKs
    const seqTables = ['contacts', 'timelines', 'calls', 'recordings', 'transcripts',
                       'call_events', 'leads', 'jobs', 'estimates', 'estimate_items',
                       'invoices', 'invoice_items', 'payment_transactions'];
    for (const t of seqTables) {
      try {
        await client.query(`SELECT setval('${t}_id_seq', COALESCE((SELECT MAX(id) FROM ${t}), 1))`);
      } catch (_) {
        // Table may use UUID PK — no sequence to reset
      }
    }

    await client.query('COMMIT');
    console.log('\nImport complete!');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Import failed:', e.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
