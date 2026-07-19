const registry = require('../../backend/src/services/crmMcpToolRegistry');

describe('crmMcpToolRegistry', () => {
    test('lists read and write tools with stable metadata', () => {
        const tools = registry.listTools();
        const requiredReadTools = [
            'crm.search_accounts',
            'crm.get_account',
            'crm.find_stale_accounts',
            'crm.search_contacts',
            'crm.get_contact',
            'crm.get_key_contacts',
            'crm.search_deals',
            'crm.get_deal',
            'crm.get_attention_deals',
            'crm.get_pipeline',
            'crm.get_pipeline_by_owner',
            'crm.get_pipeline_by_team',
            'crm.get_pipeline_by_period',
            'crm.group_pipeline_by_stage',
            'crm.group_pipeline_by_forecast_category',
            'crm.get_forecast_totals',
            'crm.get_pipeline_changes',
            'crm.get_pipeline_risky_deals',
            'crm.get_pipeline_slippage',
            'crm.list_activities',
            'crm.list_tasks',
            'crm.list_notes',
            'crm.get_metadata',
            'crm.list_sales_workflows',
            'crm.get_sales_list',
            'crm.list_my_open_deals',
            'crm.get_last_customer_facing_activity',
            'crm.find_deals_without_next_step',
            'crm.find_overdue_close_date_deals',
            'crm.find_deals_without_activity',
            'crm.find_deals_closing_between',
            'crm.find_deals_closing_this_month',
            'crm.find_deals_closing_this_quarter',
            'crm.find_risky_deals',
            'crm.top_accounts_by_pipeline',
            'crm.accounts_needing_follow_up',
            'crm.contacts_missing_role_title_email',
            'crm.tasks_due_this_week',
            'crm.find_overdue_tasks',
            'crm.get_deal_history',
        ];

        for (const name of requiredReadTools) {
            const tool = tools.find(candidate => candidate.name === name);
            expect(tool).toMatchObject({
                kind: 'read',
                requiresConfirmation: false,
                requiredPermission: registry.TOOL_PERMISSION_MAP[name][0],
            });
            expect(tool.requiredPermissions).toEqual(registry.TOOL_PERMISSION_MAP[name]);
        }
        const requiredWriteTools = [
            'crm.update_deal_field',
            'crm.update_deal_next_step',
            'crm.update_deal_stage',
            'crm.update_deal_forecast_category',
            'crm.update_deal_close_date',
            'crm.update_deal_amount',
            'crm.update_deal_risk_summary',
            'crm.update_deal_competitor',
            'crm.create_task',
            'crm.update_task_status',
            'crm.create_note',
        ];
        for (const name of requiredWriteTools) {
            const tool = tools.find(candidate => candidate.name === name);
            expect(tool).toMatchObject({
                kind: 'write',
                requiresConfirmation: true,
                requiredPermission: 'sales.crm.write',
                frameworkWritePermission: 'sales.crm.write',
            });
            expect(tool.requiredPermissions).toEqual(['sales.crm.write']);
        }
        expect(tools.every(tool => tool.requiredPermissions.length > 0)).toBe(true);
        expect(tools.map(tool => tool.name)).not.toContain('crm.bulk_update_deals');
        expect(tools.map(tool => tool.name)).not.toContain('crm.delete_deal');
    });

    test('registers every predefined Sales workflow selection as a read tool', () => {
        const tools = registry.listTools({ kind: 'read' });
        const toolNames = tools.map(tool => tool.name);

        expect(toolNames).toEqual(expect.arrayContaining([
            'crm.list_sales_workflows',
            'crm.list_my_open_deals',
            'crm.find_deals_closing_this_month',
            'crm.find_deals_closing_this_quarter',
            'crm.find_deals_without_activity',
            'crm.find_deals_without_next_step',
            'crm.find_risky_deals',
            'crm.top_accounts_by_pipeline',
            'crm.accounts_needing_follow_up',
            'crm.contacts_missing_role_title_email',
            'crm.tasks_due_this_week',
        ]));

        for (const name of toolNames.filter(name => name.startsWith('crm.find_') || name.startsWith('crm.top_') || name.startsWith('crm.accounts_') || name.startsWith('crm.contacts_') || name.startsWith('crm.tasks_') || name === 'crm.list_my_open_deals' || name === 'crm.list_sales_workflows')) {
            const tool = registry.getTool(name);
            expect(tool.kind).toBe('read');
            expect(tool.requiresConfirmation).toBe(false);
        }

        expect(registry.getTool('crm.find_deals_without_activity').inputSchema.required).toEqual([]);
    });

    test('filters tool list by kind', () => {
        const readTools = registry.listTools({ kind: 'read' });
        const writeTools = registry.listTools({ kind: 'write' });

        expect(readTools.length).toBeGreaterThan(0);
        expect(readTools.every(tool => tool.kind === 'read')).toBe(true);
        expect(readTools.map(tool => tool.name)).not.toContain('crm.update_deal_field');
        expect(writeTools.length).toBeGreaterThan(0);
        expect(writeTools.every(tool => tool.kind === 'write')).toBe(true);
    });
});
