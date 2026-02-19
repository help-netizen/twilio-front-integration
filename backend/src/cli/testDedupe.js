#!/usr/bin/env node
/**
 * Test the contact deduplication service against the 8 test cases from the spec.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });
const dedupe = require('../services/contactDedupeService');
const db = require('../db/connection');

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';

async function cleanup() {
    // Clean up test contacts/emails created during this test
    await db.query("DELETE FROM contact_emails WHERE contact_id IN (SELECT id FROM contacts WHERE first_name = 'TestDedupe')");
    await db.query("DELETE FROM leads WHERE first_name = 'TestDedupe'");
    await db.query("DELETE FROM contacts WHERE first_name = 'TestDedupe'");
}

async function createTestContact(firstName, lastName, phone, email) {
    const fullName = `${firstName} ${lastName}`;
    const { rows } = await db.query(
        `INSERT INTO contacts (full_name, first_name, last_name, phone_e164, email, company_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [fullName, firstName, lastName, phone, email, COMPANY_ID]
    );
    const contactId = rows[0].id;
    if (email) {
        await db.query(
            `INSERT INTO contact_emails (contact_id, email, email_normalized, is_primary)
             VALUES ($1, $2, $3, true) ON CONFLICT DO NOTHING`,
            [contactId, email, email.toLowerCase().trim()]
        );
    }
    return contactId;
}

async function addAdditionalEmail(contactId, email) {
    await db.query(
        `INSERT INTO contact_emails (contact_id, email, email_normalized, is_primary)
         VALUES ($1, $2, $3, false) ON CONFLICT DO NOTHING`,
        [contactId, email, email.toLowerCase().trim()]
    );
}

let passed = 0;
let failed = 0;

function assert(condition, testName, details) {
    if (condition) {
        console.log(`  ✅ ${testName}`);
        passed++;
    } else {
        console.log(`  ❌ ${testName} — ${details || ''}`);
        failed++;
    }
}

async function run() {
    await cleanup();
    console.log('=== Contact Deduplication Tests ===\n');

    // Setup: create a base contact
    const baseId = await createTestContact('TestDedupe', 'Smith', '+15551234567', 'test@example.com');
    console.log(`Base contact ID: ${baseId}\n`);

    // Test 1: Same name + same phone → reused contact
    console.log('Test 1: Same name + same phone → reused contact');
    const r1 = await dedupe.resolveContact(
        { first_name: 'TestDedupe', last_name: 'Smith', phone: '+15551234567', email: 'test@example.com' },
        COMPANY_ID
    );
    assert(r1.status === 'matched', 'Status is matched', `Got: ${r1.status}`);
    assert(r1.contact_id === baseId, 'Same contact_id', `Got: ${r1.contact_id}, expected: ${baseId}`);
    assert(r1.matched_by === 'phone', 'Matched by phone', `Got: ${r1.matched_by}`);

    // Test 2: Same name + phone missing + same email (primary) → reused
    console.log('\nTest 2: Same name + no phone + same primary email → reused');
    const r2 = await dedupe.resolveContact(
        { first_name: 'TestDedupe', last_name: 'Smith', phone: null, email: 'test@example.com' },
        COMPANY_ID
    );
    assert(r2.status === 'matched', 'Status is matched', `Got: ${r2.status}`);
    assert(r2.contact_id === baseId, 'Same contact_id', `Got: ${r2.contact_id}`);
    assert(r2.matched_by === 'email', 'Matched by email', `Got: ${r2.matched_by}`);

    // Test 3: Same name + phone missing + same email (additional) → reused
    console.log('\nTest 3: Same name + no phone + additional email match → reused');
    await addAdditionalEmail(baseId, 'alt@example.com');
    const r3 = await dedupe.resolveContact(
        { first_name: 'TestDedupe', last_name: 'Smith', phone: null, email: 'alt@example.com' },
        COMPANY_ID
    );
    assert(r3.status === 'matched', 'Status is matched', `Got: ${r3.status}`);
    assert(r3.contact_id === baseId, 'Same contact_id', `Got: ${r3.contact_id}`);

    // Test 4: Same name + same phone + different email → reused + email enriched
    console.log('\nTest 4: Same name + same phone + different email → reused + enriched');
    const r4 = await dedupe.resolveContact(
        { first_name: 'TestDedupe', last_name: 'Smith', phone: '+15551234567', email: 'new@example.com' },
        COMPANY_ID
    );
    assert(r4.status === 'matched', 'Status is matched', `Got: ${r4.status}`);
    assert(r4.email_enriched === true, 'Email was enriched', `Got: ${r4.email_enriched}`);

    // Verify email was added
    const { rows: emails } = await db.query(
        'SELECT email FROM contact_emails WHERE contact_id = $1 ORDER BY created_at',
        [baseId]
    );
    const emailList = emails.map(e => e.email);
    assert(emailList.includes('new@example.com'), 'new@example.com in contact_emails', `Emails: ${emailList}`);

    // Test 5: Same request repeated → no duplicate emails
    console.log('\nTest 5: Repeated same email → no duplicate');
    const r5 = await dedupe.resolveContact(
        { first_name: 'TestDedupe', last_name: 'Smith', phone: '+15551234567', email: 'new@example.com' },
        COMPANY_ID
    );
    assert(r5.email_enriched === false, 'Email NOT enriched again', `Got: ${r5.email_enriched}`);

    const { rows: emails2 } = await db.query(
        'SELECT count(*) as n FROM contact_emails WHERE contact_id = $1 AND email_normalized = $2',
        [baseId, 'new@example.com']
    );
    assert(Number(emails2[0].n) === 1, 'Only 1 row for new@example.com', `Got: ${emails2[0].n}`);

    // Test 6: Multiple contacts with same name (different phones) + no phone/email provided → ambiguous
    console.log('\nTest 6: Multiple contacts same name, no phone/email → ambiguous');
    const dupeId = await createTestContact('TestDedupe', 'Smith', '+15559876543', 'dupe@example.com');
    const r6 = await dedupe.resolveContact(
        { first_name: 'TestDedupe', last_name: 'Smith', phone: null, email: null },
        COMPANY_ID
    );
    assert(r6.status === 'ambiguous', 'Status is ambiguous', `Got: ${r6.status}`);
    assert(Array.isArray(r6.candidates) && r6.candidates.length >= 2, 'Has candidates', `Got: ${r6.candidates?.length}`);

    // Test 7: Name matches but phone and email differ → create new
    console.log('\nTest 7: Name matches, phone+email differ → create new');
    const r7 = await dedupe.resolveContact(
        { first_name: 'TestDedupe', last_name: 'Smith', phone: '+15558888888', email: 'different@other.com' },
        COMPANY_ID
    );
    assert(r7.status === 'created', 'Status is created', `Got: ${r7.status}`);
    assert(r7.contact_id !== baseId, 'Different contact_id', `Got: ${r7.contact_id}`);
    // Cleanup
    await db.query("DELETE FROM contact_emails WHERE contact_id = $1", [r7.contact_id]);
    await db.query("DELETE FROM contacts WHERE id = $1", [r7.contact_id]);

    // Test 8: No phone/email, name matches multiple → ambiguous
    console.log('\nTest 8: No phone/email, name matches multiple → ambiguous');
    const r8 = await dedupe.resolveContact(
        { first_name: 'TestDedupe', last_name: 'Smith', phone: null, email: null },
        COMPANY_ID
    );
    assert(r8.status === 'ambiguous', 'Status is ambiguous', `Got: ${r8.status}`);

    // Cleanup
    await cleanup();

    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
    await db.pool.end();
    process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
