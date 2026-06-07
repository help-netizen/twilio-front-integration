const { validateArguments } = require('../../backend/src/services/crmMcpSchemaValidator');
const registry = require('../../backend/src/services/crmMcpToolRegistry');

describe('crmMcpSchemaValidator', () => {
    test('rejects missing required field', () => {
        expect(() => validateArguments(registry.getTool('crm.get_deal'), {}))
            .toThrow(/deal_id is required/);
    });

    test('rejects enum value outside schema', () => {
        expect(() => validateArguments(registry.getTool('crm.update_deal_field'), {
            deal_id: 1,
            field: 'owner_user_id',
            value: 'user-2',
        })).toThrow(/field must be one of/);
    });

    test('accepts valid write arguments including null value', () => {
        expect(() => validateArguments(registry.getTool('crm.update_deal_field'), {
            deal_id: 1,
            field: 'next_step',
            value: null,
        })).not.toThrow();
    });

    test('rejects null for required typed fields', () => {
        expect(() => validateArguments(registry.getTool('crm.get_last_customer_facing_activity'), {
            entity_type: 'deal',
            entity_id: null,
        })).toThrow(/entity_id is required/);
        expect(() => validateArguments(registry.getTool('crm.get_pipeline_by_owner'), {
            owner_user_id: null,
        })).toThrow(/owner_user_id is required/);
    });

    test('validates CRM date fields as YYYY-MM-DD calendar dates', () => {
        const tool = registry.getTool('crm.find_deals_closing_between');

        expect(() => validateArguments(tool, {
            from_date: '2026-06-01',
            to_date: '2026-06-30',
        })).not.toThrow();
        expect(() => validateArguments(tool, {
            from_date: '2026-02-30',
            to_date: '2026-06-30',
        })).toThrow(/from_date must be a valid YYYY-MM-DD date/);
        expect(() => validateArguments(tool, {
            from_date: '2026-06-01T00:00:00Z',
            to_date: '2026-06-30',
        })).toThrow(/from_date must be a valid YYYY-MM-DD date/);
    });

    test('validates typed deal write tools before dispatch', () => {
        expect(() => validateArguments(registry.getTool('crm.update_deal_amount'), {
            deal_id: 1,
            value: 25000,
        })).not.toThrow();
        expect(() => validateArguments(registry.getTool('crm.update_deal_amount'), {
            deal_id: 1,
            value: -1,
        })).toThrow(/value must be >= 0/);
        expect(() => validateArguments(registry.getTool('crm.update_deal_amount'), {
            deal_id: 1,
            value: '25000',
        })).toThrow(/value must be a number/);
        expect(() => validateArguments(registry.getTool('crm.update_deal_close_date'), {
            deal_id: 1,
            value: '2026-06-30',
        })).not.toThrow();
        expect(() => validateArguments(registry.getTool('crm.update_deal_close_date'), {
            deal_id: 1,
            value: '2026-06-31',
        })).toThrow(/value must be a valid YYYY-MM-DD date/);
        expect(() => validateArguments(registry.getTool('crm.update_deal_close_date'), {
            deal_id: 1,
            value: null,
        })).not.toThrow();
        expect(() => validateArguments(registry.getTool('crm.update_deal_stage'), {
            deal_id: 1,
            value: null,
        })).toThrow(/value is required/);
    });

    test('validates pipeline since as an ISO 8601 timestamp', () => {
        const tool = registry.getTool('crm.get_pipeline_changes');

        expect(() => validateArguments(tool, {
            since: '2026-05-27T00:00:00.000Z',
        })).not.toThrow();
        expect(() => validateArguments(tool, {
            since: '2026-05-27',
        })).toThrow(/since must be a valid ISO 8601 timestamp/);
        expect(() => validateArguments(tool, {
            since: 'not-a-date',
        })).toThrow(/since must be a valid ISO 8601 timestamp/);
    });
});
