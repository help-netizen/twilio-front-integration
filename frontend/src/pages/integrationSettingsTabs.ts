export type IntegrationSettingsTab = 'marketplace' | 'api-keys';

export const INTEGRATION_TAB_COPY: Record<IntegrationSettingsTab, { title: string; description: string }> = {
    marketplace: { title: 'Marketplace', description: 'Connect and manage apps that extend Albusto.' },
    'api-keys': { title: 'API access', description: 'Manage credentials for custom and private integrations.' },
};

export function integrationTabFromSearchParams(params: URLSearchParams): IntegrationSettingsTab {
    const tab = params.get('tab');
    return tab === 'api-keys' || tab === 'marketplace' ? tab : 'marketplace';
}
