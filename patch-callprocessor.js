#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'backend/src/services/callProcessor.js');
const content = fs.readFileSync(filePath, 'utf8');

// Step 1: Add OWNED_NUMBERS and isOwnedNumber after line 9
const lines = content.split('\n');
const insertAfter = 9; // After the closing comment

const ownedNumbersCode = `
// Get owned phone numbers from environment
const OWNED_NUMBERS = process.env.OWNED_PHONE_NUMBERS 
    ? process.env.OWNED_PHONE_NUMBERS.split(',').map(n => n.trim().replace(/[^\\d+]/g, ''))
    : [];

/**
 * Check if a number is an owned Twilio number
 * @param {string} number - Phone number to check
 * @returns {boolean}
 */
function isOwnedNumber(number) {
    if (!number) return false;
    // Normalize number for comparison (remove formatting)
    const normalized = number.replace(/[^\\d+]/g, '');
    return OWNED_NUMBERS.some(owned => {
        const ownedNormalized = owned.replace(/[^\\d+]/g, '');
        // Compare with and without + prefix
        return normalized === ownedNormalized || 
               normalized === ownedNormalized.replace('+', '') ||
               normalized.replace('+', '') === ownedNormalized.replace('+', '');
    });
}
`;

lines.splice(insertAfter, 0, ...ownedNumbersCode.split('\n'));

// Step 2: Find and replace the 'else' block in getExternalParty
let newContent = lines.join('\n');

const oldElseBlock = `        } else {
            // Fallback: use FROM
            externalNumber = callData.from;
            externalFormatted = callData.fromFormatted;
        }`;

const newElseBlock = `        } else {
            // 'external' direction: check which number is NOT owned
            // This handles outbound-dial calls where neither number is SIP
            const fromIsOwned = isOwnedNumber(callData.from);
            const toIsOwned = isOwnedNumber(callData.to);
            
            if (fromIsOwned && !toIsOwned) {
                // FROM is our number, TO is external → use TO (outbound call)
                externalNumber = callData.to;
                externalFormatted = callData.toFormatted;
            } else if (!fromIsOwned && toIsOwned) {
                // TO is our number, FROM is external → use FROM (inbound call)
                externalNumber = callData.from;
                externalFormatted = callData.fromFormatted;
            } else if (!fromIsOwned && !toIsOwned) {
                // Neither is owned (unusual) → default to FROM
                externalNumber = callData.from;
                externalFormatted = callData.fromFormatted;
            } else {
                // Both are owned (internal call) → use TO
                externalNumber = callData.to;
                externalFormatted = callData.toFormatted;
            }
        }`;

newContent = newContent.replace(oldElseBlock, newElseBlock);

// Write back
fs.writeFileSync(filePath, newContent, 'utf8');
console.log('✅ Successfully patched callProcessor.js');
console.log('Added OWNED_NUMBERS constant and isOwnedNumber function');
console.log('Updated getExternalParty to use owned number filtering');
