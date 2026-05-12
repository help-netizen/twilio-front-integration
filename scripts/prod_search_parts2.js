const pg = require('pg');
const p = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const sql = `
SELECT 'leads_comments' AS src, id::text, first_name||' '||last_name AS name, substring(comments from 1 for 300) AS txt
FROM leads WHERE updated_at >= NOW() - INTERVAL '7 days'
  AND (comments ILIKE '%WR60X31522%' OR comments ILIKE '%PS12741350%' OR comments ILIKE '%AP6977246%' OR comments ILIKE '%4959523%' OR comments ILIKE '%SM10141%')
UNION ALL
SELECT 'leads_notes', id::text, first_name||' '||last_name, substring(lead_notes from 1 for 300)
FROM leads WHERE updated_at >= NOW() - INTERVAL '7 days'
  AND (lead_notes ILIKE '%WR60X31522%' OR lead_notes ILIKE '%PS12741350%' OR lead_notes ILIKE '%AP6977246%' OR lead_notes ILIKE '%4959523%' OR lead_notes ILIKE '%SM10141%')
UNION ALL
SELECT 'jobs_desc', id::text, service_name, substring(description from 1 for 300)
FROM jobs WHERE updated_at >= NOW() - INTERVAL '7 days'
  AND (description ILIKE '%WR60X31522%' OR description ILIKE '%PS12741350%' OR description ILIKE '%AP6977246%' OR description ILIKE '%4959523%' OR description ILIKE '%SM10141%')
UNION ALL
SELECT 'contacts_notes_text', id::text, first_name||' '||last_name, substring(notes from 1 for 300)
FROM contacts WHERE updated_at >= NOW() - INTERVAL '7 days'
  AND (notes ILIKE '%WR60X31522%' OR notes ILIKE '%PS12741350%' OR notes ILIKE '%AP6977246%' OR notes ILIKE '%4959523%' OR notes ILIKE '%SM10141%')
`;

p.query(sql).then(r => {
  if (r.rows.length === 0) console.log('NO_MATCHES');
  else console.log(JSON.stringify(r.rows, null, 2));
  p.end();
}).catch(e => { console.error(e.message); p.end(); });
