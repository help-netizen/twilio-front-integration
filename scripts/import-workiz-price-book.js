#!/usr/bin/env node

/**
 * PRICEBOOK-NESTED-001 Workiz XLSX importer.
 *
 * Default mode is a read-only dry run. Apply is one company-scoped transaction.
 * The source workbooks are read through unzip + fast-xml-parser so no dependency
 * is added merely for this one controlled import.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { XMLParser } = require('fast-xml-parser');

const DEFAULT_ITEMS = path.join(os.homedir(), 'Downloads', 'workiz_items_v8_SKU_category_prefix_PLUS_missing_items.xlsx');
const DEFAULT_GROUPS = path.join(os.homedir(), 'Downloads', 'workiz_groups_v8_category_prefix_PARTS_filled_STRICT.xlsx');
const SKIPPED_SKU = '0003';
const SKIPPED_FULL_NAME = '0003 - Service call fee paid';
const EXPECTED = Object.freeze({ sourceItems: 394, groups: 121, sourceLinks: 396, droppedLinks: 121, items: 393, links: 275 });
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseTagValue: false, trimValues: false });

const array = value => value == null ? [] : (Array.isArray(value) ? value : [value]);
const clean = value => value == null ? '' : String(value).trim();
const lower = value => clean(value).toLocaleLowerCase('en-US');
const isBlank = value => clean(value) === '';

function xmlText(value) {
    if (value == null) return '';
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.map(xmlText).join('');
    if (Object.prototype.hasOwnProperty.call(value, '#text')) return String(value['#text']);
    if (Object.prototype.hasOwnProperty.call(value, 't')) return xmlText(value.t);
    if (Object.prototype.hasOwnProperty.call(value, 'r')) return array(value.r).map(xmlText).join('');
    return '';
}

function unzipXml(file, entry, { optional = false } = {}) {
    try {
        return execFileSync('/usr/bin/unzip', ['-p', file, entry], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
        if (optional) return '';
        throw new Error(`Cannot read ${entry} from ${file}: ${err.message}`);
    }
}

function columnIndex(ref) {
    const letters = String(ref || '').match(/^[A-Z]+/i)?.[0]?.toUpperCase() || '';
    let index = 0;
    for (const char of letters) index = index * 26 + char.charCodeAt(0) - 64;
    return index - 1;
}

function readXlsxRows(file) {
    if (!fs.existsSync(file)) throw new Error(`Workbook not found: ${file}`);
    const sharedXml = unzipXml(file, 'xl/sharedStrings.xml', { optional: true });
    const shared = sharedXml
        ? array(parser.parse(sharedXml)?.sst?.si).map(xmlText)
        : [];
    const sheetXml = unzipXml(file, 'xl/worksheets/sheet1.xml');
    const rowNodes = array(parser.parse(sheetXml)?.worksheet?.sheetData?.row);
    const matrix = rowNodes.map(row => {
        const values = [];
        for (const cell of array(row.c)) {
            const idx = columnIndex(cell.r);
            const raw = cell.t === 'inlineStr' ? xmlText(cell.is) : xmlText(cell.v);
            values[idx] = cell.t === 's' ? (shared[Number(raw)] ?? '') : raw;
        }
        return values.map(value => value ?? '');
    });
    if (!matrix.length) throw new Error(`Workbook has no rows: ${file}`);
    const headers = matrix[0].map(clean);
    return matrix.slice(1)
        .filter(row => row.some(value => !isBlank(value)))
        .map((row, index) => Object.fromEntries(headers.map((header, column) => [header, row[column] ?? ''])))
        .map((row, index) => ({ ...row, __row: index + 2 }));
}

function requireHeaders(rows, headers, label) {
    if (!rows.length) throw new Error(`${label} workbook has no data rows`);
    const actual = new Set(Object.keys(rows[0]));
    const missing = headers.filter(header => !actual.has(header));
    if (missing.length) throw new Error(`${label} workbook is missing headers: ${missing.join(', ')}`);
}

function parseSkuName(value, label) {
    const fullName = clean(value);
    const match = fullName.match(/^([0-9]+)\s+-\s+(.+)$/);
    if (!match) throw new Error(`${label} must be "SKU - Name": ${fullName || '(blank)'}`);
    return { sku: match[1], name: match[2].trim(), fullName };
}

function numeric(value, label) {
    if (isBlank(value)) throw new Error(`${label} is required`);
    const result = Number(value);
    if (!Number.isFinite(result)) throw new Error(`${label} must be numeric`);
    return result;
}

function assertUnique(values, label) {
    const seen = new Set();
    for (const value of values) {
        const key = lower(value);
        if (seen.has(key)) throw new Error(`Duplicate ${label}: ${value}`);
        seen.add(key);
    }
}

function countsBy(values) {
    return values.reduce((counts, value) => { counts[value] = (counts[value] || 0) + 1; return counts; }, {});
}

function assertCounts(actual, expected, label) {
    const canonical = value => JSON.stringify(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
    if (canonical(actual) !== canonical(expected)) {
        throw new Error(`${label} counts changed: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`);
    }
}

function pathKey(parts) { return parts.map(lower).join('\u001f'); }

function buildImportData(itemRows, groupRows, { enforceEstablishedCounts = true } = {}) {
    requireHeaders(itemRows, ['Item name', 'Price', 'Cost', 'Item type', 'Description', 'Taxability', 'Category 1', 'Category 2', 'Category 3'], 'Items');
    requireHeaders(groupRows, [
        'Group name', 'Group type', 'Category 1',
        ...Array.from({ length: 10 }, (_, index) => index + 1).flatMap(number => [
            `Part ${number} name`, `Part ${number} price`, `Part ${number} cost`, `Part ${number} quantity`,
        ]),
    ], 'Groups');

    const allItems = itemRows.map(row => {
        const parsed = parseSkuName(row['Item name'], `Items row ${row.__row} Item name`);
        const price = numeric(row.Price, `Items row ${row.__row} Price`);
        if (!isBlank(row.Cost)) throw new Error(`Items row ${row.__row} Cost is nonempty; no destination cost field exists`);
        const itemType = clean(row['Item type']);
        if (!['Service', 'Product'].includes(itemType)) throw new Error(`Items row ${row.__row} has unsupported Item type: ${itemType}`);
        const taxability = numeric(row.Taxability, `Items row ${row.__row} Taxability`);
        if (![0, 1].includes(taxability)) throw new Error(`Items row ${row.__row} has unsupported Taxability: ${row.Taxability}`);
        const categories = [clean(row['Category 1']), clean(row['Category 2']), clean(row['Category 3'])];
        if (!categories[0]) throw new Error(`Items row ${row.__row} Category 1 is required`);
        if (categories[2] && !categories[1]) throw new Error(`Items row ${row.__row} has Category 3 without Category 2`);
        return {
            source_row: row.__row,
            ...parsed,
            price,
            item_type: itemType,
            description: clean(row.Description) || null,
            taxable: taxability === 1,
            categories: categories.filter(Boolean),
        };
    });
    assertUnique(allItems.map(item => item.sku), 'item SKU');
    assertUnique(allItems.map(item => item.fullName), 'full item name');

    const skippedSource = allItems.filter(item => item.sku === SKIPPED_SKU);
    if (skippedSource.length !== 1 || skippedSource[0].fullName !== SKIPPED_FULL_NAME || skippedSource[0].price !== -95) {
        throw new Error(`Expected exactly ${SKIPPED_FULL_NAME} at -95; source decision cannot be applied safely`);
    }
    const unexpectedNegative = allItems.find(item => item.price < 0 && item.sku !== SKIPPED_SKU);
    if (unexpectedNegative) throw new Error(`Unexpected negative item price at row ${unexpectedNegative.source_row}: ${unexpectedNegative.fullName}`);
    const items = allItems.filter(item => item.sku !== SKIPPED_SKU);
    const byFullName = new Map(allItems.map(item => [item.fullName, item]));

    const groups = groupRows.map(row => {
        const parsed = parseSkuName(row['Group name'], `Groups row ${row.__row} Group name`);
        if (clean(row['Group type']) !== 'Individual items') throw new Error(`Groups row ${row.__row} has unsupported Group type`);
        const root = clean(row['Category 1']);
        if (!root) throw new Error(`Groups row ${row.__row} Category 1 is required`);
        const links = [];
        for (let n = 1; n <= 10; n++) {
            const fullItemName = clean(row[`Part ${n} name`]);
            const price = row[`Part ${n} price`];
            const cost = row[`Part ${n} cost`];
            const quantityValue = row[`Part ${n} quantity`];
            if (!fullItemName) {
                if (![price, cost, quantityValue].every(isBlank)) throw new Error(`Groups row ${row.__row} Part ${n} has values without a name`);
                continue;
            }
            if (!isBlank(price) || !isBlank(cost)) throw new Error(`Groups row ${row.__row} Part ${n} price/cost is nonempty; importer will not discard it`);
            const item = byFullName.get(fullItemName);
            if (!item) throw new Error(`Groups row ${row.__row} Part ${n} is orphaned: ${fullItemName}`);
            const quantity = numeric(quantityValue, `Groups row ${row.__row} Part ${n} quantity`);
            if (quantity <= 0) throw new Error(`Groups row ${row.__row} Part ${n} quantity must be > 0`);
            links.push({ source_part: n, item_sku: item.sku, item_full_name: fullItemName, quantity, dropped: item.sku === SKIPPED_SKU });
        }
        assertUnique(links.map(link => link.item_full_name), `membership in group ${parsed.fullName}`);
        const keptLinks = links.filter(link => !link.dropped);
        if (!keptLinks.length) throw new Error(`Group ${parsed.fullName} would have zero parts after dropping ${SKIPPED_SKU}`);
        return {
            source_row: row.__row,
            ...parsed,
            name: parsed.fullName,
            description: clean(row.Description) || null,
            category: root,
            source_links: links,
            links: keptLinks.map((link, sort_order) => ({ ...link, sort_order })),
        };
    });
    assertUnique(groups.map(group => group.fullName), 'full group name');
    assertUnique(groups.map(group => group.sku), 'group SKU');

    const sourceLinks = groups.flatMap(group => group.source_links);
    const droppedLinks = sourceLinks.filter(link => link.dropped);
    const links = groups.flatMap(group => group.links.map(link => ({ ...link, group_name: group.name })));
    if (enforceEstablishedCounts && droppedLinks.length !== EXPECTED.droppedLinks) {
        throw new Error(`Expected exactly ${EXPECTED.droppedLinks} dropped ${SKIPPED_SKU} links, found ${droppedLinks.length}; stopping`);
    }
    if (droppedLinks.some(link => link.quantity !== 1)) {
        throw new Error(`Every dropped ${SKIPPED_SKU} link must have quantity 1 for the accepted $95 group-total impact`);
    }

    const categoryPaths = new Map();
    const addPath = parts => {
        for (let depth = 1; depth <= parts.length; depth++) {
            const current = parts.slice(0, depth);
            categoryPaths.set(pathKey(current), { path: current, level: depth, name: current[depth - 1], sort_order: 0 });
        }
    };
    items.forEach(item => addPath(item.categories));
    groups.forEach(group => addPath([group.category]));
    const categories = [...categoryPaths.values()].sort((a, b) => a.level - b.level || pathKey(a.path).localeCompare(pathKey(b.path)));
    for (const level of [1, 2, 3]) {
        const nodes = categories.filter(category => category.level === level);
        const siblings = new Map();
        for (const node of nodes) {
            const parent = pathKey(node.path.slice(0, -1));
            const next = siblings.get(parent) || 0;
            node.sort_order = next;
            siblings.set(parent, next + 1);
        }
    }

    if (enforceEstablishedCounts) {
        const actual = { sourceItems: allItems.length, groups: groups.length, sourceLinks: sourceLinks.length, items: items.length, links: links.length };
        for (const [key, expected] of Object.entries(EXPECTED)) {
            if (key === 'droppedLinks') continue;
            if (actual[key] !== expected) throw new Error(`Expected ${expected} ${key}, found ${actual[key]}`);
        }
        const byLevel = [1, 2, 3].map(level => categories.filter(category => category.level === level).length);
        if (categories.length !== 45 || byLevel.join('/') !== '9/6/30') throw new Error(`Expected category tree 45 (9/6/30), found ${categories.length} (${byLevel.join('/')})`);
        assertCounts(countsBy(allItems.map(item => item.item_type)), { Service: 305, Product: 89 }, 'source Item type');
        if (allItems.some(item => item.taxable)) throw new Error('Expected Taxability 0 on all 394 source items');
        assertCounts(countsBy(allItems.map(item => item.categories[0])), {
            '0 General fees': 4,
            '1 Cooktop Repair': 12,
            '2 Dishwasher Repair': 39,
            '3 Dryer Repair': 29,
            '4 Microwave Repair': 4,
            '5 Range/Oven Repair': 14,
            '6 Refrigerator Repair': 44,
            '7 Washer Repair': 39,
            '8 Education': 209,
        }, 'Category 1');
        const education = allItems.filter(item => item.categories[0] === '8 Education');
        if (allItems.some(item => item.categories.length > 1 && item.categories[0] !== '8 Education')) {
            throw new Error('Only 8 Education may use Category 2/3 in the established source');
        }
        assertCounts(countsBy(education.map(item => item.categories[1])), {
            Refrigerator: 59, Dishwasher: 30, Dryer: 30, Oven: 30, 'Stove,Range,Cooktop': 30, Washer: 30,
        }, 'Education Category 2');
        assertCounts(countsBy(education.map(item => item.categories[2])), {
            Commercial: 42, Economy: 42, 'Etc...': 41, 'High End': 42, Standard: 42,
        }, 'Education Category 3');
        if (groups.some(group => group.category === '8 Education' || group.source_links.length === 0)) {
            throw new Error('Established groups must be nonempty and must not use 8 Education');
        }
    }

    return {
        source: { items: allItems.length, groups: groups.length, links: sourceLinks.length },
        import: { items: items.length, groups: groups.length, links: links.length, categories: categories.length },
        categories,
        items,
        groups,
        links,
        skipped_rows: [{ workbook: 'items', row: skippedSource[0].source_row, sku: SKIPPED_SKU, full_name: SKIPPED_FULL_NAME, price: -95, reason: 'Owner decided to import without this negative-price row' }],
        dropped_links: { count: droppedLinks.length, sku: SKIPPED_SKU, unit_credit_removed: 95, group_total_impact: '+$95 per imported group' },
        groups_zero_after_drop: groups.filter(group => group.links.length === 0).length,
    };
}

function sameValue(left, right) {
    if (left == null && right == null) return true;
    if (typeof right === 'boolean') return Boolean(left) === right;
    if (typeof right === 'number') return Number(left) === right;
    return String(left) === String(right);
}

function itemFields(item, categoryId) {
    return {
        name: item.name,
        description: item.description,
        default_quantity: 1,
        default_unit_price: item.price,
        default_taxable: item.taxable,
        category_id: categoryId,
        code: item.sku,
        unit: null,
        item_type: item.item_type,
    };
}

function groupFields(group, categoryId) {
    return { name: group.name, description: group.description, category_id: categoryId, sort_order: 0 };
}

async function inspectTarget(client, companyId, data) {
    const { rows: companyRows } = await client.query('SELECT id FROM companies WHERE id = $1', [companyId]);
    if (companyRows.length !== 1) throw new Error(`Company not found: ${companyId}`);
    const [{ rows: categoryRows }, { rows: itemRows }, { rows: groupRows }, { rows: linkRows }] = await Promise.all([
        client.query('SELECT id, parent_id, name, description, sort_order FROM price_book_categories WHERE company_id = $1 AND archived_at IS NULL ORDER BY id', [companyId]),
        client.query('SELECT id, name, description, default_quantity, default_unit_price, default_taxable, category_id, code, unit, item_type FROM estimate_item_presets WHERE company_id = $1 AND archived_at IS NULL ORDER BY id', [companyId]),
        client.query('SELECT id, name, description, category_id, sort_order FROM price_book_groups WHERE company_id = $1 AND archived_at IS NULL ORDER BY id', [companyId]),
        client.query('SELECT group_id, item_id, quantity, sort_order FROM price_book_group_items WHERE company_id = $1 ORDER BY group_id, item_id', [companyId]),
    ]);

    const categoryById = new Map(categoryRows.map(row => [Number(row.id), row]));
    const categoryPath = row => {
        const parts = [];
        const seen = new Set();
        let current = row;
        while (current) {
            if (seen.has(Number(current.id))) throw new Error(`Existing category cycle at ${current.id}`);
            seen.add(Number(current.id));
            parts.unshift(current.name);
            current = current.parent_id == null ? null : categoryById.get(Number(current.parent_id));
        }
        return parts;
    };
    const categoryByPath = new Map();
    for (const row of categoryRows) {
        const key = pathKey(categoryPath(row));
        if (categoryByPath.has(key)) throw new Error(`Duplicate active target category path: ${categoryPath(row).join(' > ')}`);
        categoryByPath.set(key, row);
    }

    const itemsByCode = new Map();
    for (const row of itemRows) {
        if (!clean(row.code)) continue;
        const key = lower(row.code);
        if (itemsByCode.has(key)) throw new Error(`Duplicate active target item SKU: ${row.code}`);
        itemsByCode.set(key, row);
    }
    const groupsByName = new Map();
    for (const row of groupRows) {
        const key = lower(row.name);
        if (groupsByName.has(key)) throw new Error(`Duplicate active target group name: ${row.name}`);
        groupsByName.set(key, row);
    }
    const linksByKey = new Map(linkRows.map(row => [`${row.group_id}:${row.item_id}`, row]));

    const categories = data.categories.map(category => {
        const existing = categoryByPath.get(pathKey(category.path));
        const changed = existing && Number(existing.sort_order) !== category.sort_order;
        return { ...category, id: existing ? Number(existing.id) : null, status: !existing ? 'create' : changed ? 'update' : 'unchanged' };
    });
    const plannedCategoryId = new Map(categories.filter(category => category.id != null).map(category => [pathKey(category.path), category.id]));
    const items = data.items.map(item => {
        const existing = itemsByCode.get(lower(item.sku));
        const category_id = plannedCategoryId.get(pathKey(item.categories)) ?? null;
        const fields = itemFields(item, category_id);
        const changed = existing && Object.entries(fields).some(([key, value]) => key !== 'category_id' && !sameValue(existing[key], value));
        const categoryPending = existing && (category_id == null || Number(existing.category_id) !== Number(category_id));
        return { sku: item.sku, name: item.name, category_path: item.categories, price: item.price, item_type: item.item_type, id: existing ? Number(existing.id) : null, status: !existing ? 'create' : changed || categoryPending ? 'update' : 'unchanged' };
    });
    const groups = data.groups.map(group => {
        const existing = groupsByName.get(lower(group.name));
        const category_id = plannedCategoryId.get(pathKey([group.category])) ?? null;
        const fields = groupFields(group, category_id);
        const changed = existing && (category_id == null || Object.entries(fields).some(([key, value]) => !sameValue(existing[key], value)));
        return { name: group.name, category_path: [group.category], id: existing ? Number(existing.id) : null, status: !existing ? 'create' : changed ? 'update' : 'unchanged' };
    });
    const itemId = new Map(items.filter(item => item.id != null).map(item => [item.sku, item.id]));
    const groupId = new Map(groups.filter(group => group.id != null).map(group => [group.name, group.id]));
    const links = data.links.map(link => {
        const iid = itemId.get(link.item_sku);
        const gid = groupId.get(link.group_name);
        const existing = iid && gid ? linksByKey.get(`${gid}:${iid}`) : null;
        const changed = existing && (Number(existing.quantity) !== link.quantity || Number(existing.sort_order) !== link.sort_order);
        return { group_name: link.group_name, item_sku: link.item_sku, quantity: link.quantity, sort_order: link.sort_order, status: !existing ? 'create' : changed ? 'update' : 'unchanged' };
    });
    return { categories, items, groups, links };
}

function summarizeStatuses(entries) {
    return entries.reduce((out, entry) => { out[entry.status] = (out[entry.status] || 0) + 1; return out; }, { create: 0, update: 0, unchanged: 0 });
}

async function applyImport(client, companyId, data) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 193))', [companyId]);
    const importedCodes = data.items.map(item => lower(item.sku));
    const { rows: legacyBefore } = await client.query(
        `SELECT to_jsonb(p) AS snapshot FROM estimate_item_presets p
         WHERE p.company_id = $1 AND NOT (lower(btrim(coalesce(p.code, ''))) = ANY($2::text[]))
         ORDER BY p.id`,
        [companyId, importedCodes],
    );
    const categoryIds = new Map();
    const counts = { categories: { created: 0, updated: 0 }, items: { created: 0, updated: 0 }, groups: { created: 0, updated: 0 }, links: { created: 0, updated: 0, removed_skipped: 0 } };

    for (const category of data.categories) {
        const parentId = category.level === 1 ? null : categoryIds.get(pathKey(category.path.slice(0, -1)));
        const { rows: matches } = await client.query(
            `SELECT id, sort_order FROM price_book_categories
             WHERE company_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND lower(name) = lower($3) AND archived_at IS NULL
             FOR UPDATE`,
            [companyId, parentId, category.name],
        );
        if (matches.length > 1) throw new Error(`Duplicate active category path: ${category.path.join(' > ')}`);
        let id;
        if (!matches.length) {
            const { rows: inserted } = await client.query(
                `INSERT INTO price_book_categories (company_id, parent_id, name, sort_order)
                 VALUES ($1,$2,$3,$4) RETURNING id`,
                [companyId, parentId, category.name, category.sort_order],
            );
            id = Number(inserted[0].id); counts.categories.created++;
        } else {
            id = Number(matches[0].id);
            if (Number(matches[0].sort_order) !== category.sort_order) {
                await client.query('UPDATE price_book_categories SET sort_order = $1, updated_at = NOW() WHERE id = $2 AND company_id = $3', [category.sort_order, id, companyId]);
                counts.categories.updated++;
            }
        }
        categoryIds.set(pathKey(category.path), id);
    }

    const itemIds = new Map();
    for (const item of data.items) {
        const fields = itemFields(item, categoryIds.get(pathKey(item.categories)));
        const { rows: matches } = await client.query(
            `SELECT id, name, description, default_quantity, default_unit_price, default_taxable, category_id, code, unit, item_type
             FROM estimate_item_presets
             WHERE company_id = $1 AND lower(btrim(code)) = $2 AND archived_at IS NULL FOR UPDATE`,
            [companyId, lower(item.sku)],
        );
        if (matches.length > 1) throw new Error(`Duplicate active target item SKU: ${item.sku}`);
        let id;
        if (!matches.length) {
            const { rows: inserted } = await client.query(
                `INSERT INTO estimate_item_presets
                    (company_id, name, description, default_quantity, default_unit_price, default_taxable, category_id, code, unit, item_type)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
                [companyId, fields.name, fields.description, fields.default_quantity, fields.default_unit_price, fields.default_taxable, fields.category_id, fields.code, fields.unit, fields.item_type],
            );
            id = Number(inserted[0].id); counts.items.created++;
        } else {
            id = Number(matches[0].id);
            if (Object.entries(fields).some(([key, value]) => !sameValue(matches[0][key], value))) {
                await client.query(
                    `UPDATE estimate_item_presets SET name=$1, description=$2, default_quantity=$3, default_unit_price=$4,
                        default_taxable=$5, category_id=$6, code=$7, unit=$8, item_type=$9, updated_at=NOW()
                     WHERE id=$10 AND company_id=$11`,
                    [fields.name, fields.description, fields.default_quantity, fields.default_unit_price, fields.default_taxable, fields.category_id, fields.code, fields.unit, fields.item_type, id, companyId],
                );
                counts.items.updated++;
            }
        }
        itemIds.set(item.sku, id);
    }

    const groupIds = new Map();
    for (const group of data.groups) {
        const fields = groupFields(group, categoryIds.get(pathKey([group.category])));
        const { rows: matches } = await client.query(
            `SELECT id, name, description, category_id, sort_order FROM price_book_groups
             WHERE company_id = $1 AND lower(name) = lower($2) AND archived_at IS NULL FOR UPDATE`,
            [companyId, group.name],
        );
        if (matches.length > 1) throw new Error(`Duplicate active target group name: ${group.name}`);
        let id;
        if (!matches.length) {
            const { rows: inserted } = await client.query(
                `INSERT INTO price_book_groups (company_id, name, description, category_id, sort_order)
                 VALUES ($1,$2,$3,$4,$5) RETURNING id`,
                [companyId, fields.name, fields.description, fields.category_id, fields.sort_order],
            );
            id = Number(inserted[0].id); counts.groups.created++;
        } else {
            id = Number(matches[0].id);
            if (Object.entries(fields).some(([key, value]) => !sameValue(matches[0][key], value))) {
                await client.query(
                    `UPDATE price_book_groups SET name=$1, description=$2, category_id=$3, sort_order=$4, updated_at=NOW()
                     WHERE id=$5 AND company_id=$6`,
                    [fields.name, fields.description, fields.category_id, fields.sort_order, id, companyId],
                );
                counts.groups.updated++;
            }
        }
        groupIds.set(group.name, id);
    }

    const { rows: skippedItems } = await client.query(
        `SELECT id FROM estimate_item_presets
         WHERE company_id = $1 AND lower(btrim(code)) = lower($2) AND archived_at IS NULL`,
        [companyId, SKIPPED_SKU],
    );
    if (skippedItems.length > 1) throw new Error(`Duplicate active target item SKU: ${SKIPPED_SKU}`);
    if (skippedItems.length === 1) {
        const importedGroupIds = [...groupIds.values()];
        const removed = await client.query(
            `DELETE FROM price_book_group_items
             WHERE company_id = $1 AND item_id = $2 AND group_id = ANY($3::bigint[])`,
            [companyId, skippedItems[0].id, importedGroupIds],
        );
        counts.links.removed_skipped = removed.rowCount;
    }

    for (const link of data.links) {
        const { rows } = await client.query(
            `INSERT INTO price_book_group_items (company_id, group_id, item_id, quantity, sort_order)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (group_id, item_id) DO UPDATE
                SET quantity = EXCLUDED.quantity, sort_order = EXCLUDED.sort_order
             WHERE price_book_group_items.company_id = $1
               AND (price_book_group_items.quantity, price_book_group_items.sort_order)
                   IS DISTINCT FROM (EXCLUDED.quantity, EXCLUDED.sort_order)
             RETURNING (xmax = 0) AS inserted`,
            [companyId, groupIds.get(link.group_name), itemIds.get(link.item_sku), link.quantity, link.sort_order],
        );
        if (rows[0]?.inserted) counts.links.created++;
        else if (rows.length) counts.links.updated++;
    }

    const { rows: legacyAfter } = await client.query(
        `SELECT to_jsonb(p) AS snapshot FROM estimate_item_presets p
         WHERE p.company_id = $1 AND NOT (lower(btrim(coalesce(p.code, ''))) = ANY($2::text[]))
         ORDER BY p.id`,
        [companyId, importedCodes],
    );
    if (JSON.stringify(legacyAfter) !== JSON.stringify(legacyBefore)) {
        throw new Error('Legacy/unmatched estimate_item_presets changed during import; rolling back');
    }
    return { counts, legacy_presets_preserved: legacyBefore.length };
}

function parseArgs(argv) {
    const args = { dryRun: false, apply: false, items: DEFAULT_ITEMS, groups: DEFAULT_GROUPS, companyId: null };
    for (const arg of argv) {
        if (arg === '--dry-run') args.dryRun = true;
        else if (arg === '--apply') args.apply = true;
        else if (arg.startsWith('--company-id=')) args.companyId = arg.slice('--company-id='.length);
        else if (arg.startsWith('--items=')) args.items = arg.slice('--items='.length);
        else if (arg.startsWith('--groups=')) args.groups = arg.slice('--groups='.length);
        else throw new Error(`Unknown argument: ${arg}`);
    }
    if (args.apply && args.dryRun) throw new Error('--apply and --dry-run are mutually exclusive');
    if (!args.apply) args.dryRun = true;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(args.companyId || '')) {
        throw new Error('--company-id=<uuid> is required');
    }
    return args;
}

async function run(argv = process.argv.slice(2), dependencies = {}) {
    const args = parseArgs(argv);
    const data = buildImportData(readXlsxRows(args.items), readXlsxRows(args.groups));
    const db = dependencies.db || require('../backend/src/db/connection');
    const client = await db.getClient();
    let began = false;
    try {
        await client.query('BEGIN'); began = true;
        if (args.apply) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 193))', [args.companyId]);
        const target = await inspectTarget(client, args.companyId, data);
        const plan = {
            mode: args.apply ? 'apply' : 'dry-run',
            company_id: args.companyId,
            source_files: { items: args.items, groups: args.groups },
            source: data.source,
            import: data.import,
            categories_per_level: Object.fromEntries([1, 2, 3].map(level => [level, target.categories.filter(category => category.level === level)])),
            items: target.items,
            groups: target.groups,
            links: target.links,
            skipped_rows: data.skipped_rows,
            dropped_links: data.dropped_links,
            groups_zero_after_drop: data.groups_zero_after_drop,
            changes: {
                categories: summarizeStatuses(target.categories),
                items: summarizeStatuses(target.items),
                groups: summarizeStatuses(target.groups),
                links: summarizeStatuses(target.links),
            },
            writes: false,
        };
        if (args.dryRun) {
            await client.query('ROLLBACK'); began = false;
            process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
            return plan;
        }
        const applied = await applyImport(client, args.companyId, data);
        await client.query('COMMIT'); began = false;
        const result = { ...plan, writes: true, applied };
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return result;
    } catch (err) {
        if (began) {
            try { await client.query('ROLLBACK'); } catch (_) { /* preserve original error */ }
        }
        throw err;
    } finally {
        client.release();
        if (!dependencies.db && db.pool?.end) await db.pool.end();
    }
}

if (require.main === module) {
    run().catch(err => {
        process.stderr.write(`Workiz Price Book import failed: ${err.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { DEFAULT_ITEMS, DEFAULT_GROUPS, SKIPPED_SKU, readXlsxRows, buildImportData, inspectTarget, applyImport, parseArgs, run };
