import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * TYPE-CANON-001 — the app-wide ratchet.
 *
 * The canon (docs/specs/TYPE-CANON-001.md) is three sizes: 32 for the one thing
 * a screen exists for, 20 for a section heading, 15 for everything below one.
 * The app predates it by 605 hand-written sizes across 29 steps, so this does
 * NOT demand the canon everywhere today — it freezes the pile as a ceiling.
 *
 * New work cannot add to it. Migrating a surface lowers it, in the same commit.
 * These numbers only ever go down; if a change makes one go up, that change is
 * writing a new size instead of using .blanc-l2 / LEVEL_TWO.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));

// Measured at adoption (2026-08-14), payment card already migrated.
const CEILING = {
    occurrences: 605,
    distinctSizes: 29,
    // 9.5 · 10.5 · 11.5 · 12.5 · 13.5 · 14.5 · 15.5 — half-steps nobody can
    // justify. First migration batch: these should reach 0 without any design
    // judgment at all.
    halfSteps: 42,
};

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (entry.endsWith('.tsx') && !entry.includes('.test.')) out.push(full);
    }
    return out;
}

function collect() {
    const sizes: string[] = [];
    for (const file of walk(SRC)) {
        const source = readFileSync(file, 'utf8');
        for (const match of source.matchAll(/text-\[([0-9.]+)px\]/g)) sizes.push(match[1]);
    }
    return sizes;
}

describe('TYPE-CANON-001 ratchet', () => {
    const sizes = collect();

    it('does not add hand-written type sizes', () => {
        // Fails on growth, not on the debt itself. If you migrated a surface,
        // lower CEILING.occurrences here in the same commit.
        expect(sizes.length).toBeLessThanOrEqual(CEILING.occurrences);
    });

    it('does not invent a new step in the scale', () => {
        const distinct = new Set(sizes);
        expect(distinct.size).toBeLessThanOrEqual(CEILING.distinctSizes);
    });

    it('does not add half-steps', () => {
        const halves = sizes.filter(size => size.includes('.'));
        expect(halves.length).toBeLessThanOrEqual(CEILING.halfSteps);
    });

    it('keeps the canon itself defined in exactly one place', () => {
        // Two spellings of one rule (class + style prop) are allowed; a third
        // definition somewhere else is how a canon quietly forks.
        const owners = walk(SRC).filter(file => {
            const source = readFileSync(file, 'utf8');
            return /LEVEL_TWO(_QUIET|_HEADING)?\s*[:=]\s*\{/.test(source);
        });
        expect(owners).toEqual([]);  // only styles/levelTwo.ts, and that is a .ts
    });
});
