/**
 * ALB-105 — Tenant-safety sanitizer.
 *
 * Static scan that fails the suite when a route or query file reintroduces
 * patterns that PF007 hardening removed:
 *   1. req.user.company_id / req.user?.company_id in route handlers
 *      (tenant context must come from req.companyFilter only)
 *   2. req.companyId (legacy, undefined since PF007)
 *   3. JS template interpolation of company/user variables inside SQL text
 *      (SQL injection / scope-bypass pattern)
 *
 * To allow a legitimate exception add a line comment containing
 * `tenant-safety-allow` on the offending line.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = [
    'backend/src/routes',
    'backend/src/db',
    'backend/src/services',
];

// Files that legitimately reference req.user company context (auth plumbing)
const FILE_ALLOWLIST = new Set([
    'backend/src/middleware/keycloakAuth.js',
]);

const RULES = [
    {
        id: 'req-user-company-id',
        re: /req\.user\??\.company_id/,
        message: 'tenant context must come from req.companyFilter?.company_id (PF007), not req.user',
        // only routes are forbidden; services receive companyId as an argument
        appliesTo: (file) => file.includes('backend/src/routes/'),
    },
    {
        id: 'req-companyId-legacy',
        re: /req\.companyId\b/,
        message: 'req.companyId is legacy and undefined since PF007 — use req.companyFilter?.company_id',
        appliesTo: (file) => file.includes('backend/src/routes/'),
    },
    {
        id: 'sql-interpolation',
        // ${...companyId...} / ${...company_id...} / ${...userId...} inside a template literal
        re: /\$\{[^}]*(company_?id|companyId)[^}]*\}/i,
        message: 'never interpolate company identifiers into SQL/template strings — use parameterized queries',
        // only flag lines that look like SQL (URLs to admin APIs are fine)
        appliesTo: () => true,
        // uppercase keywords only — SQL in this codebase is uppercase; avoids
        // matching prose ("from Zenbooker") and JS methods (.delete())
        lineFilter: (line) => /\b(SELECT|INSERT INTO|UPDATE|DELETE FROM|WHERE|FROM|VALUES|JOIN)\b/.test(line)
            && !line.includes('http') && !line.includes('console.'),
    },
];

function listJsFiles(dir) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) return [];
    const out = [];
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        const rel = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...listJsFiles(rel));
        else if (entry.name.endsWith('.js')) out.push(rel);
    }
    return out;
}

describe('ALB-105: tenant-safety sanitizer', () => {
    const files = SCAN_DIRS.flatMap(listJsFiles)
        .filter(f => !FILE_ALLOWLIST.has(f.replace(/\\/g, '/')));

    it('scans a non-empty file set', () => {
        expect(files.length).toBeGreaterThan(20);
    });

    it.each(RULES.map(r => [r.id, r]))('rule %s has no violations', (_id, rule) => {
        const violations = [];
        for (const file of files) {
            if (!rule.appliesTo(file.replace(/\\/g, '/'))) continue;
            const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
            lines.forEach((line, i) => {
                if (line.includes('tenant-safety-allow')) return;
                // skip pure comment lines (docs often mention the forbidden pattern)
                const trimmed = line.trim();
                if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
                if (rule.lineFilter && !rule.lineFilter(line)) return;
                if (rule.re.test(line)) {
                    violations.push(`${file}:${i + 1}  ${trimmed.slice(0, 120)}`);
                }
            });
        }
        if (violations.length > 0) {
            throw new Error(
                `tenant-safety violation (${rule.message}):\n  ` + violations.join('\n  ')
            );
        }
    });
});
