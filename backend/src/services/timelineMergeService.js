/**
 * Timeline Merge Service
 *
 * Merges orphan timelines into a contact's main timeline when
 * phone numbers are updated (either via contact edit or lead edit).
 */

const db = require('../db/connection');

/**
 * Merge orphan timelines matching any of the contact's phone digits
 * into the contact's existing timeline (or adopt if none exists).
 *
 * @param {number} contactId
 * @param {string[]} phones - array of phone strings (primary + secondary)
 * @param {string} [logPrefix='[TimelineMerge]'] - for log messages
 */
async function mergeOrphanTimelines(contactId, phones, logPrefix = '[TimelineMerge]') {
    const validPhones = phones.filter(Boolean);
    if (validPhones.length === 0) return;

    const digits = validPhones
        .map(p => p.replace(/\D/g, '').slice(-10))
        .filter(d => d.length === 10);
    if (digits.length === 0) return;

    // Find orphan timelines matching any of the contact's phone digits
    const { rows: orphanTimelines } = await db.query(`
        SELECT id, phone_e164
        FROM timelines
        WHERE contact_id IS NULL
          AND phone_e164 IS NOT NULL
          AND RIGHT(REGEXP_REPLACE(phone_e164, '[^0-9]', '', 'g'), 10) = ANY($1)
    `, [digits]);

    if (orphanTimelines.length === 0) return;

    // Does the contact already have a timeline?
    const { rows: existingTl } = await db.query(
        'SELECT id FROM timelines WHERE contact_id = $1 LIMIT 1', [contactId]
    );

    if (existingTl.length > 0) {
        // Merge: move calls from orphan timelines into the existing one
        const mainTlId = existingTl[0].id;
        for (const orphan of orphanTimelines) {
            const { rowCount } = await db.query(
                'UPDATE calls SET timeline_id = $1, contact_id = $2 WHERE timeline_id = $3',
                [mainTlId, contactId, orphan.id]
            );
            await db.query('DELETE FROM timelines WHERE id = $1', [orphan.id]);
            console.log(`${logPrefix} Merged timeline ${orphan.id} (${orphan.phone_e164}) into ${mainTlId} — ${rowCount} calls moved`);
        }
    } else {
        // Adopt the first orphan timeline, merge the rest into it
        const mainOrphan = orphanTimelines[0];
        await db.query('UPDATE timelines SET contact_id = $1 WHERE id = $2', [contactId, mainOrphan.id]);
        await db.query('UPDATE calls SET contact_id = $1 WHERE timeline_id = $2 AND contact_id IS NULL', [contactId, mainOrphan.id]);
        console.log(`${logPrefix} Adopted timeline ${mainOrphan.id} (${mainOrphan.phone_e164}) for contact ${contactId}`);

        for (let i = 1; i < orphanTimelines.length; i++) {
            const orphan = orphanTimelines[i];
            const { rowCount } = await db.query(
                'UPDATE calls SET timeline_id = $1, contact_id = $2 WHERE timeline_id = $3',
                [mainOrphan.id, contactId, orphan.id]
            );
            await db.query('DELETE FROM timelines WHERE id = $1', [orphan.id]);
            console.log(`${logPrefix} Merged extra timeline ${orphan.id} into ${mainOrphan.id} — ${rowCount} calls`);
        }
    }

    // Also link any unlinked calls matching these phones
    await db.query(`
        UPDATE calls SET contact_id = $1
        WHERE contact_id IS NULL
          AND (
              RIGHT(REGEXP_REPLACE(from_number, '[^0-9]', '', 'g'), 10) = ANY($2)
              OR RIGHT(REGEXP_REPLACE(to_number, '[^0-9]', '', 'g'), 10) = ANY($2)
          )
    `, [contactId, digits]);
}

module.exports = { mergeOrphanTimelines };
