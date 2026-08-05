import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AppSetup } from './AppSetup';
import type { AppSettingField, AppSecretStatus } from '../../services/appViewsApi';

const fields: AppSettingField[] = [
    { key: 'supplier_email', label: 'Supplier email', type: 'email', required: true },
    { key: 'auto_order', label: 'Order automatically', type: 'boolean' },
];
const secrets: AppSecretStatus[] = [
    { connection: 'supplier', status: 'set' },
    { connection: 'backup', status: 'not_set' },
];

function render(node: React.ReactNode) {
    return renderToStaticMarkup(<>{node}</>);
}

describe('APP-PLATFORM setup panel', () => {
    it('renders declared fields and secret status, with the key entered as a password', () => {
        const markup = render(
            <AppSetup
                fields={fields}
                values={{ supplier_email: 'parts@supplier.com' }}
                secrets={secrets}
                savingSettings={false}
                onSaveSettings={vi.fn()}
                onSaveSecret={vi.fn()}
                savingSecret={null}
            />
        );
        expect(markup).toContain('Supplier email');
        expect(markup).toContain('parts@supplier.com');
        expect(markup).toContain('supplier');
        expect(markup).toContain('Set');
        expect(markup).toContain('Not set');
        // A key is entered blind — never a text field.
        expect(markup).toContain('type="password"');
        // The stored value is never rendered back.
        expect(markup).not.toContain('supplier-secret');
    });

    it('says so when an app needs no configuration', () => {
        const markup = render(
            <AppSetup
                fields={[]}
                values={{}}
                secrets={[]}
                savingSettings={false}
                onSaveSettings={vi.fn()}
                onSaveSecret={vi.fn()}
                savingSecret={null}
            />
        );
        expect(markup).toContain('needs no configuration');
    });
});
