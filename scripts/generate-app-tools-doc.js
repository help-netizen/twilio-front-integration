'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { renderAppToolsMarkdown } = require('../backend/src/services/appRuntimeToolDocumentation');

const outputPath = path.resolve(__dirname, '../docs/specs/APP-TOOLS-001.md');
const rendered = renderAppToolsMarkdown();

if (process.argv.includes('--check')) {
    const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : null;
    if (current !== rendered) {
        process.stderr.write('APP-TOOLS-001.md is out of date. Run `npm run gen:app-tools-doc`.\n');
        process.exitCode = 1;
    }
} else {
    fs.writeFileSync(outputPath, rendered, 'utf8');
    process.stdout.write(`Generated ${path.relative(process.cwd(), outputPath)}\n`);
}
