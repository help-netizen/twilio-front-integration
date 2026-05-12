const pg = require('pg');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const sql = `
SELECT json_agg(row_to_json(t)) AS results FROM (
  SELECT 'jobs' AS src, j.id, j.service_name,
         substring(note_elem->>'text' from 1 for 500) AS note_text,
         note_elem->>'created' AS note_created
  FROM jobs j, jsonb_array_elements(j.notes) AS note_elem
  WHERE j.updated_at >= NOW() - INTERVAL '7 days'
    AND (note_elem->>'text' ILIKE '%WR60X31522%'
      OR note_elem->>'text' ILIKE '%PS12741350%'
      OR note_elem->>'text' ILIKE '%AP6977246%'
      OR note_elem->>'text' ILIKE '%4959523%'
      OR note_elem->>'text' ILIKE '%SM10141%')
  UNION ALL
  SELECT 'leads' AS src, l.id, l.job_type AS service_name,
         substring(note_elem->>'text' from 1 for 500) AS note_text,
         note_elem->>'created' AS note_created
  FROM leads l, jsonb_array_elements(l.structured_notes) AS note_elem
  WHERE l.updated_at >= NOW() - INTERVAL '7 days'
    AND (note_elem->>'text' ILIKE '%WR60X31522%'
      OR note_elem->>'text' ILIKE '%PS12741350%'
      OR note_elem->>'text' ILIKE '%AP6977246%'
      OR note_elem->>'text' ILIKE '%4959523%'
      OR note_elem->>'text' ILIKE '%SM10141%')
  UNION ALL
  SELECT 'contacts' AS src, c.id, c.first_name || ' ' || c.last_name AS service_name,
         substring(note_elem->>'text' from 1 for 500) AS note_text,
         note_elem->>'created' AS note_created
  FROM contacts c, jsonb_array_elements(c.structured_notes) AS note_elem
  WHERE c.updated_at >= NOW() - INTERVAL '7 days'
    AND (note_elem->>'text' ILIKE '%WR60X31522%'
      OR note_elem->>'text' ILIKE '%PS12741350%'
      OR note_elem->>'text' ILIKE '%AP6977246%'
      OR note_elem->>'text' ILIKE '%4959523%'
      OR note_elem->>'text' ILIKE '%SM10141%')
) t;
`;

pool.query(sql).then(r => {
  const results = r.rows[0]?.results;
  if (!results || results.length === 0) {
    console.log('NO_MATCHES');
  } else {
    console.log(JSON.stringify(results, null, 2));
  }
  pool.end();
}).catch(e => {
  console.error('ERROR:', e.message);
  pool.end();
  process.exit(1);
});
