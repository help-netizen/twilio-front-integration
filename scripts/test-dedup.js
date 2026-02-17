#!/usr/bin/env node
const http = require('http');

function fetchApi() {
    return new Promise((resolve, reject) => {
        http.get('http://localhost:3000/api/calls/by-contact?limit=100', (res) => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

async function main() {
    const j = await fetchApi();
    const convs = j.conversations || [];
    console.log('Total conversations:', convs.length);

    // Check for duplicates by phone digits
    const byDigits = {};
    convs.forEach((c, i) => {
        const phone = c.contact?.phone_e164 || c.from_number || '';
        const digits = phone.replace(/\D/g, '');
        if (!byDigits[digits]) byDigits[digits] = [];
        byDigits[digits].push(i);
    });

    const dups = Object.entries(byDigits).filter(([k, v]) => v.length > 1);
    if (dups.length > 0) {
        console.log('DUPLICATES FOUND:');
        dups.forEach(([digits, indices]) => {
            console.log('  Phone digits:', digits, 'appears', indices.length, 'times at indices:', indices);
            indices.forEach(idx => {
                const c = convs[idx];
                console.log('    idx:', idx, 'contact_id:', c.contact?.id, 'phone:', c.contact?.phone_e164 || c.from_number,
                    'calls:', c.call_count, 'sms:', c.sms_count, 'type:', c.last_interaction_type,
                    'last:', c.last_interaction_at);
            });
        });
    } else {
        console.log('NO DUPLICATES');
    }

    // Show top 10
    console.log('\nTop 10:');
    convs.slice(0, 10).forEach((c, i) => {
        console.log(i, c.contact?.phone_e164 || c.from_number,
            'calls:', c.call_count, 'sms:', c.sms_count,
            'unread:', c.has_unread, 'type:', c.last_interaction_type,
            'last:', c.last_interaction_at);
    });
}

main().catch(e => console.error(e));
