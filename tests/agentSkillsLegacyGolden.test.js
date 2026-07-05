/**
 * agentSkillsLegacyGolden.test.js — AGENT-SKILLS-001 T9 (G3 byte-compat gate)
 *
 * The 5 relocated L0 legacy tools (checkServiceArea / validateAddress /
 * checkAvailability / recommendSlots / createLead) under
 * `backend/src/services/agentSkills/skills/` must stay BYTE-IDENTICAL to the
 * recorded golden (spec §7.3, AC-11) — the regression bar for the thin
 * `vapi-tools.js` refactor.
 *
 * WHY A CHILD-PROCESS SPAWN (not a re-import of capture-golden.js):
 *   `tests/agentSkills/golden/capture-golden.js` installs a `Module._load` override
 *   to inject deterministic service stubs (symlink/cwd-proof). Under jest that
 *   override fights jest's own module system — the stubs miss, the REAL services
 *   load (random lead UUIDs / live schedule rows / a broadcast that logs after
 *   teardown), and `require()`-ing the module even RUNS its `main()` (no `--check`
 *   in jest's argv), overwriting golden.json. So the authoritative byte-gate is the
 *   STANDALONE script run under plain node, which we spawn here and assert exits 0.
 *   `capture-golden.js --check` is the durable byte-gate (also consumed by
 *   scripts/verify-agent-skills-001.js for the real-DB byte-compat proof, ASK-INT-14…17).
 *
 * Plus a plain require + shape check on the recorded golden.json: the FROZEN-shape
 * invariant (no `ok`/`speak` key leaks onto any of the 5 L0 legacy tools — byte-compat
 * wins over the generic resultShapes envelope) and the spec-critical byte values.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const GOLDEN_SCRIPT = path.join(__dirname, 'agentSkills/golden/capture-golden.js');
const GOLDEN_PATH = path.join(__dirname, 'agentSkills/golden/golden.json');

describe('AGENT-SKILLS-001 G3 — 5 relocated L0 tools byte-compat (golden gate)', () => {
    test('the standalone `capture-golden.js --check` exits 0 (modules byte-match golden.json)', () => {
        // Spawn under plain node so the Module._load stub override works (it does NOT
        // under jest). This is the authoritative byte-gate. A single byte of drift in
        // any relocated module → the script prints DRIFT and exits 1 → this fails.
        const res = spawnSync(process.execPath, [GOLDEN_SCRIPT, '--check'], {
            cwd: path.resolve(__dirname, '..'),
            encoding: 'utf8',
            timeout: 60000,
        });
        // Surface the script's own diff on failure for a readable message.
        const detail = `exit=${res.status} signal=${res.signal || 'none'}\nstdout:\n${res.stdout || ''}\nstderr:\n${res.stderr || ''}`;
        expect(`status=${res.status}\n${res.status === 0 ? '' : detail}`).toBe('status=0\n');
        expect(res.stdout).toMatch(/--check OK — all \d+ cases byte-match/);
    });

    describe('recorded golden.json — frozen shape + spec-critical values (plain require + shape check)', () => {
        /** @type {Record<string,string>} */
        let recorded;
        beforeAll(() => {
            expect(fs.existsSync(GOLDEN_PATH)).toBe(true); // capture must have run
            recorded = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
        });

        test('FROZEN shape — no ok/speak key on any of the 5 L0 legacy tool outputs', () => {
            for (const [key, bytes] of Object.entries(recorded)) {
                const obj = JSON.parse(bytes);
                expect(`${key} has ok: ${Object.prototype.hasOwnProperty.call(obj, 'ok')}`).toBe(`${key} has ok: false`);
                expect(`${key} has speak: ${Object.prototype.hasOwnProperty.call(obj, 'speak')}`).toBe(`${key} has speak: false`);
            }
        });

        test('golden covers all 5 relocated tools', () => {
            const tools = new Set(Object.keys(recorded).map((k) => k.split('.')[0]));
            for (const t of ['checkServiceArea', 'validateAddress', 'checkAvailability', 'recommendSlots', 'createLead']) {
                expect(tools.has(t)).toBe(true);
            }
        });

        test('the spec-critical shapes are present and correct', () => {
            expect(recorded['checkServiceArea.in_area']).toBe(
                '{"inServiceArea":true,"area":"Boston","city":"Boston","state":"MA","zip":"02101"}');
            expect(recorded['checkServiceArea.missing_zip']).toBe(
                '{"inServiceArea":false,"error":"zip is required"}');
            expect(recorded['validateAddress.valid']).toBe(
                '{"valid":true,"standardized":"45 Tremont St Apt 3, Boston, MA 02108","correctedZip":"02108","lat":42.357,"lng":-71.059}');
            expect(recorded['recommendSlots.not_connected']).toBe(
                '{"available":false,"slots":[],"fallback":true}');
            expect(recorded['recommendSlots.happy']).toBe(
                '{"available":true,"slots":[{"key":"2026-07-08|10:00|13:00","date":"2026-07-08","start":"10:00","end":"13:00","label":"Wed Jul 8, 10:00–13:00","techName":"Alex","confidence":"high"}]}');
            expect(recorded['createLead.no_phone']).toBe(
                '{"success":false,"error":"Phone number is required to create lead"}');
        });
    });
});
