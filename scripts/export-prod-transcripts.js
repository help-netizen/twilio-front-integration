// export-prod-transcripts.js
//
// Run against prod without copying database credentials locally:
//   ssh deploy@108.61.87.117 'cd /opt/albusto && docker compose exec -T app node -' < scripts/export-prod-transcripts.js > exports/prod-transcripts.jsonl
//
// Output:
//   JSONL by default: one JSON object per transcript row with non-empty text.
//   Set EXPORT_FORMAT=json to emit a JSON array instead.

const { Pool } = require('pg');

const DEFAULT_COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const companyId = process.env.COMPANY_ID || DEFAULT_COMPANY_ID;
const allCompanies = String(process.env.ALL_COMPANIES || '').toLowerCase() === 'true';
const exportFormat = String(process.env.EXPORT_FORMAT || 'jsonl').toLowerCase();

function safeJson(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function parseUtterances(text, fallbackSpeaker = null, fallbackRawPayload = {}) {
  if (!text || typeof text !== 'string') return [];

  const chunks = text
    .split(/\n{2,}|\n(?=(?:Customer|Agent|Speaker\s+[^:]+):)/g)
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  return chunks.map((chunk, index) => {
    const timed = chunk.match(/^\[(\d+)ms\]\s*Speaker\s+([^:]+):\s*([\s\S]*)$/i);
    if (timed) {
      return {
        index,
        start_ms: Number(timed[1]),
        end_ms: null,
        speaker: `Speaker ${timed[2].trim()}`,
        text: timed[3].trim(),
      };
    }

    const role = chunk.match(/^(Customer|Agent|Speaker\s+[^:]+):\s*([\s\S]*)$/i);
    if (role) {
      return {
        index,
        start_ms: fallbackRawPayload.startMs ?? null,
        end_ms: fallbackRawPayload.endMs ?? null,
        speaker: role[1].trim(),
        text: role[2].trim(),
      };
    }

    return {
      index,
      start_ms: fallbackRawPayload.startMs ?? null,
      end_ms: fallbackRawPayload.endMs ?? null,
      speaker: fallbackSpeaker,
      text: chunk,
    };
  });
}

function rowToExport(row) {
  const rawPayload = safeJson(row.raw_payload);
  const utterances = parseUtterances(row.text, row.speaker, rawPayload);

  return {
    export_schema_version: 'prod-transcripts-v1',
    company: {
      id: row.company_id,
      name: row.company_name || null,
      slug: row.company_slug || null,
    },
    call: {
      call_sid: row.call_sid,
      parent_call_sid: row.parent_call_sid || null,
      direction: row.call_direction || null,
      status: row.call_status || null,
      started_at: row.call_started_at || null,
      answered_at: row.call_answered_at || null,
      ended_at: row.call_ended_at || null,
      duration_sec: row.call_duration_sec == null ? null : Number(row.call_duration_sec),
    },
    recording: {
      recording_sid: row.recording_sid || null,
      status: row.recording_status || null,
      duration_sec: row.recording_duration_sec == null ? null : Number(row.recording_duration_sec),
      channels: row.recording_channels == null ? null : Number(row.recording_channels),
      track: row.recording_track || null,
      source: row.recording_source || null,
      started_at: row.recording_started_at || null,
      completed_at: row.recording_completed_at || null,
    },
    transcript: {
      id: row.transcript_id == null ? null : Number(row.transcript_id),
      transcription_sid: row.transcription_sid || null,
      mode: row.mode,
      status: row.transcript_status,
      language_code: row.language_code || null,
      confidence: row.confidence == null ? null : Number(row.confidence),
      is_final: row.is_final,
      sequence_no: row.sequence_no == null ? null : Number(row.sequence_no),
      speaker: row.speaker || null,
      track: row.track || null,
      created_at: row.transcript_created_at,
      updated_at: row.transcript_updated_at,
      text: row.text,
      utterances,
      summary: {
        text: rawPayload.gemini_summary || null,
        entities: rawPayload.gemini_entities || [],
        sentiment_score: rawPayload.sentimentScore ?? null,
      },
      raw_payload: rawPayload,
    },
  };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set');
  }
  if (!['jsonl', 'json'].includes(exportFormat)) {
    throw new Error(`Unsupported EXPORT_FORMAT=${exportFormat}. Use jsonl or json.`);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const transcriptColumnResult = await pool.query(
      `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'transcripts'
          AND column_name IN ('speaker', 'track')
      `
    );
    const transcriptColumns = new Set(transcriptColumnResult.rows.map((row) => row.column_name));
    const transcriptSpeakerSql = transcriptColumns.has('speaker') ? 't.speaker' : 'NULL::text';
    const transcriptTrackSql = transcriptColumns.has('track') ? 't.track' : 'NULL::text';

    const params = [];
    let companyFilter = '';
    if (!allCompanies) {
      params.push(companyId);
      companyFilter = `AND t.company_id = $${params.length}`;
    }

    const result = await pool.query(
      `
        SELECT
          t.id AS transcript_id,
          t.transcription_sid,
          t.call_sid,
          t.recording_sid,
          t.company_id,
          t.mode,
          t.status AS transcript_status,
          t.language_code,
          t.confidence,
          t.text,
          t.is_final,
          t.sequence_no,
          ${transcriptSpeakerSql} AS speaker,
          ${transcriptTrackSql} AS track,
          t.created_at AS transcript_created_at,
          t.updated_at AS transcript_updated_at,
          t.raw_payload,
          c.parent_call_sid,
          c.direction AS call_direction,
          c.status AS call_status,
          c.started_at AS call_started_at,
          c.answered_at AS call_answered_at,
          c.ended_at AS call_ended_at,
          c.duration_sec AS call_duration_sec,
          r.status AS recording_status,
          r.duration_sec AS recording_duration_sec,
          r.channels AS recording_channels,
          r.track AS recording_track,
          r.source AS recording_source,
          r.started_at AS recording_started_at,
          r.completed_at AS recording_completed_at,
          co.name AS company_name,
          co.slug AS company_slug
        FROM transcripts t
        LEFT JOIN calls c
          ON c.call_sid = t.call_sid
         AND c.company_id = t.company_id
        LEFT JOIN recordings r
          ON r.recording_sid = t.recording_sid
         AND r.company_id = t.company_id
        LEFT JOIN companies co
          ON co.id = t.company_id
        WHERE t.text IS NOT NULL
          AND btrim(t.text) <> ''
          ${companyFilter}
        ORDER BY
          COALESCE(c.started_at, t.created_at) ASC NULLS LAST,
          t.call_sid ASC NULLS LAST,
          t.sequence_no ASC NULLS LAST,
          t.id ASC
      `,
      params
    );

    const rows = result.rows.map(rowToExport);

    if (exportFormat === 'json') {
      process.stdout.write(JSON.stringify(rows, null, 2));
      process.stdout.write('\n');
    } else {
      for (const row of rows) {
        process.stdout.write(JSON.stringify(row));
        process.stdout.write('\n');
      }
    }

    const companies = new Set(rows.map((row) => row.company.id).filter(Boolean));
    const calls = new Set(rows.map((row) => row.call.call_sid).filter(Boolean));
    process.stderr.write(`exported_transcripts=${rows.length}\n`);
    process.stderr.write(`unique_calls=${calls.size}\n`);
    process.stderr.write(`companies=${companies.size}\n`);
    process.stderr.write(`format=${exportFormat}\n`);
    process.stderr.write(`company_filter=${allCompanies ? 'ALL' : companyId}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`ERROR: ${error.message}\n`);
  process.exit(1);
});
