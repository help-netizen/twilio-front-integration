const pg = require('pg');
const p = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// Search ALL text columns + JSONB for part numbers across ALL April data
const sql = `
SELECT 'jobs_notes_jsonb' AS src, id::text, service_name AS name, substring(notes::text from 1 for 500) AS txt
FROM jobs WHERE updated_at >= '2026-04-01' AND updated_at < '2026-05-01'
  AND (notes::text ILIKE '%WR60X31522%' OR notes::text ILIKE '%PS12741350%' OR notes::text ILIKE '%AP6977246%' OR notes::text ILIKE '%4959523%' OR notes::text ILIKE '%SM10141%')
UNION ALL
SELECT 'jobs_desc', id::text, service_name, substring(description from 1 for 500)
FROM jobs WHERE updated_at >= '2026-04-01' AND updated_at < '2026-05-01'
  AND (description ILIKE '%WR60X31522%' OR description ILIKE '%PS12741350%' OR description ILIKE '%AP6977246%' OR description ILIKE '%4959523%' OR description ILIKE '%SM10141%')
UNION ALL
SELECT 'leads_all_text', id::text, first_name||' '||last_name, substring(coalesce(comments,'')||' '||coalesce(lead_notes,'')||' '||coalesce(structured_notes::text,'') from 1 for 500)
FROM leads WHERE updated_at >= '2026-04-01' AND updated_at < '2026-05-01'
  AND (comments ILIKE '%WR60X31522%' OR comments ILIKE '%PS12741350%' OR comments ILIKE '%AP6977246%' OR comments ILIKE '%4959523%' OR comments ILIKE '%SM10141%'
    OR lead_notes ILIKE '%WR60X31522%' OR lead_notes ILIKE '%PS12741350%' OR lead_notes ILIKE '%AP6977246%' OR lead_notes ILIKE '%4959523%' OR lead_notes ILIKE '%SM10141%'
    OR structured_notes::text ILIKE '%WR60X31522%' OR structured_notes::text ILIKE '%PS12741350%' OR structured_notes::text ILIKE '%AP6977246%' OR structured_notes::text ILIKE '%4959523%' OR structured_notes::text ILIKE '%SM10141%')
UNION ALL
SELECT 'contacts_all', id::text, first_name||' '||last_name, substring(coalesce(notes,'')||' '||coalesce(structured_notes::text,'') from 1 for 500)
FROM contacts WHERE updated_at >= '2026-04-01' AND updated_at < '2026-05-01'
  AND (notes ILIKE '%WR60X31522%' OR notes ILIKE '%PS12741350%' OR notes ILIKE '%AP6977246%' OR notes ILIKE '%4959523%' OR notes ILIKE '%SM10141%'
    OR structured_notes::text ILIKE '%WR60X31522%' OR structured_notes::text ILIKE '%PS12741350%' OR structured_notes::text ILIKE '%AP6977246%' OR structured_notes::text ILIKE '%4959523%' OR structured_notes::text ILIKE '%SM10141%')
UNION ALL
SELECT 'leads_metadata', id::text, first_name||' '||last_name, substring(metadata::text from 1 for 500)
FROM leads WHERE updated_at >= '2026-04-01' AND updated_at < '2026-05-01' AND metadata IS NOT NULL
  AND (metadata::text ILIKE '%WR60X31522%' OR metadata::text ILIKE '%PS12741350%' OR metadata::text ILIKE '%AP6977246%' OR metadata::text ILIKE '%4959523%' OR metadata::text ILIKE '%SM10141%')
`;

p.query(sql).then(r => {
  if (r.rows.length === 0) console.log('NO_MATCHES_APRIL');
  else console.log(JSON.stringify(r.rows, null, 2));
  p.end();
}).catch(e => { console.error('ERR:', e.message); p.end(); });
