/**
 * stagedAttachmentCleanupScheduler — NOTE-ATTACH-UPLOAD-001.
 * Note attachments are uploaded on attach (staged: note_index IS NULL) before the
 * note is saved. If the user abandons the composer (navigates away without saving),
 * the staged row + S3 object linger. This sweep deletes staged rows older than
 * STALE_HOURS every 6h (idempotent; first tick ~1 min after boot). Explicit removal
 * (the × in the composer) deletes immediately via DELETE /api/note-attachments/:id —
 * this only catches the abandoned ones.
 */
const noteAttachmentsService = require('./noteAttachmentsService');

const INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6h
const FIRST_DELAY_MS = 60 * 1000;       // let boot settle
const STALE_HOURS = 24;
let handle = null;

async function tick() {
    try {
        const n = await noteAttachmentsService.deleteStaleStagedAttachments(STALE_HOURS);
        if (n) console.log(`[StagedAttachmentCleanup] removed ${n} abandoned staged attachment(s)`);
    } catch (e) {
        console.error('[StagedAttachmentCleanup] tick error:', e.message);
    }
}

function start() {
    if (handle) return;
    handle = setInterval(tick, INTERVAL_MS);
    console.log('[StagedAttachmentCleanup] Started (6h tick)');
    setTimeout(tick, FIRST_DELAY_MS);
}

function stop() {
    if (handle) { clearInterval(handle); handle = null; }
}

module.exports = { start, stop, tick };
