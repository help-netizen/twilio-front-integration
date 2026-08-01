'use strict';

const fs = require('fs');
const path = require('path');

function jsFiles(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const target = path.join(directory, entry.name);
        return entry.isDirectory() ? jsFiles(target) : (entry.name.endsWith('.js') ? [target] : []);
    });
}

describe('APP-RUN-001 standalone package boundary', () => {
    test('runtime source imports no CRM backend module', () => {
        const sourceRoot = path.join(__dirname, '../src');
        for (const filename of jsFiles(sourceRoot)) {
            const source = fs.readFileSync(filename, 'utf8');
            expect(source).not.toMatch(/(?:require\s*\(|from\s+)[^\n]*backend/);
        }
    });

    test('isolated-vm is declared only by apps-runtime, not the CRM package', () => {
        const runtimePackage = require('../package.json');
        const crmPackage = require('../../package.json');
        expect(runtimePackage.dependencies).toEqual({ 'isolated-vm': '6.0.2' });
        expect(crmPackage.dependencies?.['isolated-vm']).toBeUndefined();
        expect(crmPackage.devDependencies?.['isolated-vm']).toBeUndefined();
    });
});
