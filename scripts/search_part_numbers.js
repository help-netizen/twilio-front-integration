#!/usr/bin/env node
/**
 * Search Zenbooker jobs (April 2026) for part number mentions in notes.
 * Usage: node scripts/search_part_numbers.js
 */

const axios = require('axios');

const ZB_API_KEY = process.env.ZENBOOKER_API_KEY || 'zbk_Ofy4Jlkv6WC5bcBVKrjiQyAV-ynzBoX9Z7gUCQGm1Wpnid86E5soDfs1Y';
const ZB_BASE = 'https://api.zenbooker.com/v1';

const PART_NUMBERS = ['WR60X31522', 'PS12741350', 'AP6977246', '4959523', 'SM10141'];

// April 2026 window
const START_DATE = '2026-04-01T00:00:00Z';
const END_DATE   = '2026-04-30T23:59:59Z';

const client = axios.create({
  baseURL: ZB_BASE,
  headers: { 'Authorization': `Bearer ${ZB_API_KEY}` },
  timeout: 30000,
});

function searchInText(text) {
  if (!text) return [];
  const upper = text.toUpperCase();
  return PART_NUMBERS.filter(pn => upper.includes(pn.toUpperCase()));
}

async function main() {
  console.log(`\n🔍 Searching Zenbooker jobs for part numbers: ${PART_NUMBERS.join(', ')}`);
  console.log(`📅 Date range: ${START_DATE} → ${END_DATE}\n`);

  let cursor = 0;
  const limit = 100;
  let totalJobs = 0;
  const matches = [];
  const seenIds = new Set();

  while (true) {
    try {
      const res = await client.get('/jobs', {
        params: {
          limit,
          cursor,
          sort_by: 'start_date',
          sort_order: 'desc',
          start_date_from: START_DATE,
          start_date_to: END_DATE,
        }
      });

      const data = res.data;
      const jobs = data.results || [];
      if (jobs.length === 0) break;

      for (const job of jobs) {
        // Deduplicate
        if (seenIds.has(job.id)) continue;
        seenIds.add(job.id);
        totalJobs++;

        // Fetch full job details (notes are often only in detail view)
        let fullJob = job;
        try {
          const detailRes = await client.get(`/jobs/${job.id}`);
          fullJob = detailRes.data;
        } catch (e) {
          // use list data
        }

        const notes = fullJob.notes || [];
        for (const note of notes) {
          const noteText = note.text || note.content || (typeof note === 'string' ? note : '');
          const found = searchInText(noteText);
          if (found.length > 0) {
            matches.push({
              jobId: fullJob.id,
              serviceName: fullJob.service_name || fullJob.service?.name || '—',
              customerName: fullJob.customer_name || [fullJob.customer?.first_name, fullJob.customer?.last_name].filter(Boolean).join(' ') || '—',
              startDate: fullJob.start_date || '—',
              noteId: note.id || null,
              noteText: noteText.substring(0, 500),
              noteCreated: note.created || note.created_at || '—',
              partNumbers: found,
            });
          }
        }

        // Also search in job description / custom fields
        const descText = fullJob.description || fullJob.customer_notes || '';
        const descFound = searchInText(descText);
        if (descFound.length > 0) {
          matches.push({
            jobId: fullJob.id,
            serviceName: fullJob.service_name || fullJob.service?.name || '—',
            customerName: fullJob.customer_name || [fullJob.customer?.first_name, fullJob.customer?.last_name].filter(Boolean).join(' ') || '—',
            startDate: fullJob.start_date || '—',
            noteId: 'description/customer_notes',
            noteText: descText.substring(0, 500),
            noteCreated: '—',
            partNumbers: descFound,
          });
        }

        // Search in custom form answers
        const answers = fullJob.form_answers || fullJob.custom_fields || [];
        for (const ans of (Array.isArray(answers) ? answers : [])) {
          const val = ans.value || ans.answer || '';
          const ansFound = searchInText(typeof val === 'string' ? val : JSON.stringify(val));
          if (ansFound.length > 0) {
            matches.push({
              jobId: fullJob.id,
              serviceName: fullJob.service_name || fullJob.service?.name || '—',
              customerName: fullJob.customer_name || [fullJob.customer?.first_name, fullJob.customer?.last_name].filter(Boolean).join(' ') || '—',
              startDate: fullJob.start_date || '—',
              noteId: `form_field: ${ans.label || ans.question || 'custom'}`,
              noteText: (typeof val === 'string' ? val : JSON.stringify(val)).substring(0, 500),
              noteCreated: '—',
              partNumbers: ansFound,
            });
          }
        }
      }

      console.log(`  📦 Batch processed: ${jobs.length} jobs (cursor=${cursor}, total unique: ${totalJobs})`);

      // Fix pagination: use next_cursor from API response
      if (!data.has_more) break;
      const nextCursor = data.next_cursor ?? data.cursor;
      if (nextCursor != null && nextCursor !== cursor) {
        cursor = nextCursor;
      } else {
        // Fallback: offset-based
        cursor = cursor + jobs.length;
      }
    } catch (err) {
      console.error(`❌ API error at cursor=${cursor}:`, err.response?.data || err.message);
      break;
    }
  }

  console.log(`\n✅ Scanned ${totalJobs} unique jobs total.\n`);

  if (matches.length === 0) {
    console.log('❌ No part numbers found in any job notes for April 2026.');
  } else {
    console.log(`🎯 Found ${matches.length} match(es):\n`);
    for (const m of matches) {
      console.log('─'.repeat(70));
      console.log(`  Job ID:        ${m.jobId}`);
      console.log(`  Service:       ${m.serviceName}`);
      console.log(`  Customer:      ${m.customerName}`);
      console.log(`  Start Date:    ${m.startDate}`);
      console.log(`  Part Numbers:  ${m.partNumbers.join(', ')}`);
      console.log(`  Note Source:   ${m.noteId}`);
      console.log(`  Note Created:  ${m.noteCreated}`);
      console.log(`  Note Text:     ${m.noteText}`);
    }
    console.log('─'.repeat(70));

    // Summary: unique part numbers found
    const allFound = [...new Set(matches.flatMap(m => m.partNumbers))];
    const notFound = PART_NUMBERS.filter(pn => !allFound.includes(pn));
    console.log(`\n📋 Summary:`);
    console.log(`  ✅ Found:     ${allFound.join(', ') || 'none'}`);
    console.log(`  ❌ Not found: ${notFound.join(', ') || 'none'}`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
