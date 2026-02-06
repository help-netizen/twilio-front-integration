/**
 * Fix Duplicate Conversations
 * 
 * Finds conversations with the same contact/external_id and merges them.
 * This happens when child calls sync before parent calls.
 * 
 * Usage: node backend/src/scripts/fixDuplicateConversations.js
 */

const db = require('../db/connection');

async function fixDuplicates() {
    console.log('🔍 Finding duplicate conversations...\n');

    try {
        // Find contacts with multiple conversations
        const duplicates = await db.query(`
            SELECT contact_id, COUNT(*) as count
            FROM conversations
            GROUP BY contact_id
            HAVING COUNT(*) > 1
        `);

        if (duplicates.rows.length === 0) {
            console.log('✅ No duplicates found!');
            return;
        }

        console.log(`Found ${duplicates.rows.length} contacts with duplicate conversations\n`);

        for (const dup of duplicates.rows) {
            const contactId = dup.contact_id;

            // Get contact info
            const contact = await db.query('SELECT * FROM contacts WHERE id = $1', [contactId]);
            console.log(`\n📞 Contact: ${contact.rows[0].formatted_number} (ID: ${contactId})`);

            // Get all conversations for this contact
            const conversations = await db.query(`
                SELECT id, external_id, created_at,
                       (SELECT COUNT(*) FROM messages WHERE conversation_id = conversations.id) as message_count
                FROM conversations
                WHERE contact_id = $1
                ORDER BY created_at ASC
            `, [contactId]);

            console.log(`   Found ${conversations.rows.length} conversations:`);
            conversations.rows.forEach(c => {
                console.log(`   - Conversation ${c.id}: ${c.message_count} messages (created: ${c.created_at})`);
            });

            // Keep the oldest conversation (first one created)
            const primaryConv = conversations.rows[0];
            const duplicateConvs = conversations.rows.slice(1);

            console.log(`\n   ✅ Keeping conversation ${primaryConv.id} (oldest)`);
            console.log(`   🔄 Merging ${duplicateConvs.length} duplicate(s)...`);

            // Move all messages from duplicates to primary
            for (const dupConv of duplicateConvs) {
                if (dupConv.message_count > 0) {
                    const result = await db.query(
                        'UPDATE messages SET conversation_id = $1 WHERE conversation_id = $2 RETURNING id',
                        [primaryConv.id, dupConv.id]
                    );
                    console.log(`      Moved ${result.rows.length} messages from conversation ${dupConv.id} → ${primaryConv.id}`);
                }

                // Delete empty duplicate conversation
                await db.query('DELETE FROM conversations WHERE id = $1', [dupConv.id]);
                console.log(`      Deleted empty conversation ${dupConv.id}`);
            }

            // Update message count in primary conversation
            const finalCount = await db.query(
                'SELECT COUNT(*) FROM messages WHERE conversation_id = $1',
                [primaryConv.id]
            );

            await db.query(
                `UPDATE conversations 
                 SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{total_calls}', $1::text::jsonb)
                 WHERE id = $2`,
                [finalCount.rows[0].count, primaryConv.id]
            );

            console.log(`   ✅ Conversation ${primaryConv.id} now has ${finalCount.rows[0].count} messages`);
        }

        console.log('\n✅ All duplicates fixed!');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error fixing duplicates:', error);
        process.exit(1);
    }
}

fixDuplicates();
