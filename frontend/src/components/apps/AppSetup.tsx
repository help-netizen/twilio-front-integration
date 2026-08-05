import { useEffect, useState } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { FloatingField } from '../ui/floating-field';
import { FloatingSelect } from '../ui/floating-select';
import { SelectItem } from '../ui/select';
import type { AppSettingField, AppSecretStatus } from '../../services/appViewsApi';

/**
 * The tenant's side of an app (APP-PLATFORM-001 / APP-EGRESS-001): the declared
 * settings form the app reads as ctx.settings, and the write-only secrets its
 * connections need. A value typed here never leaves as a value — a secret reads
 * back only as "set".
 */

export interface AppSetupProps {
    fields: AppSettingField[];
    values: Record<string, string | number | boolean>;
    secrets: AppSecretStatus[];
    savingSettings: boolean;
    onSaveSettings: (values: Record<string, string | number | boolean>) => void;
    onSaveSecret: (connection: string, value: string) => void;
    savingSecret: string | null;
}

function SettingInput({ field, value, onChange }: {
    field: AppSettingField;
    value: string | number | boolean | undefined;
    onChange: (value: string | number | boolean) => void;
}) {
    if (field.type === 'boolean') {
        return (
            <div className="flex items-center gap-2.5">
                <Checkbox id={`set-${field.key}`} checked={value === true} onCheckedChange={v => onChange(v === true)} />
                <label htmlFor={`set-${field.key}`} className="text-sm font-medium">
                    {field.label}{field.required ? ' *' : ''}
                </label>
            </div>
        );
    }
    if (field.type === 'select') {
        return (
            <FloatingSelect
                id={`set-${field.key}`}
                label={`${field.label}${field.required ? ' *' : ''}`}
                value={value === undefined ? '' : String(value)}
                onValueChange={onChange}
            >
                {(field.options || []).map(option => (
                    <SelectItem key={option} value={option}>{option}</SelectItem>
                ))}
            </FloatingSelect>
        );
    }
    return (
        <FloatingField
            id={`set-${field.key}`}
            label={`${field.label}${field.required ? ' *' : ''}`}
            type={field.type === 'number' ? 'number' : field.type === 'email' ? 'email' : field.type === 'url' ? 'url' : 'text'}
            value={value === undefined ? '' : String(value)}
            onChange={event => onChange(
                field.type === 'number' ? Number(event.target.value) : event.target.value
            )}
        />
    );
}

function SecretRow({ secret, saving, onSave }: {
    secret: AppSecretStatus;
    saving: boolean;
    onSave: (value: string) => void;
}) {
    const [value, setValue] = useState('');
    return (
        <div className="rounded-xl px-3.5 py-3" style={{ border: '1px solid var(--blanc-line)' }}>
            <div className="flex items-center gap-2 text-sm font-medium">
                <KeyRound className="size-3.5" style={{ color: 'var(--blanc-ink-3)' }} />
                {secret.connection}
                <span
                    className="ml-auto rounded-full px-2 py-0.5 text-[11px] font-semibold"
                    style={secret.status === 'set'
                        ? { background: 'var(--blanc-task-soft)', color: 'var(--blanc-success)' }
                        : { background: 'var(--blanc-field)', color: 'var(--blanc-ink-3)' }}
                >
                    {secret.status === 'set' ? 'Set' : 'Not set'}
                </span>
            </div>
            <div className="mt-2.5 flex items-end gap-2">
                <FloatingField
                    id={`secret-${secret.connection}`}
                    label={secret.status === 'set' ? 'Replace key' : 'API key'}
                    type="password"
                    value={value}
                    onChange={event => setValue(event.target.value)}
                />
                <Button
                    onClick={() => { onSave(value); setValue(''); }}
                    disabled={saving || !value.trim()}
                >
                    {saving ? <Loader2 className="size-4 animate-spin" /> : 'Save'}
                </Button>
            </div>
        </div>
    );
}

export function AppSetup({
    fields, values, secrets, savingSettings, onSaveSettings, onSaveSecret, savingSecret,
}: AppSetupProps) {
    const [draft, setDraft] = useState(values);
    useEffect(() => { setDraft(values); }, [values]);

    const set = (key: string, value: string | number | boolean) => setDraft(current => ({ ...current, [key]: value }));

    return (
        <div className="space-y-6">
            {fields.length > 0 && (
                <div className="space-y-3.5">
                    <div className="blanc-eyebrow">Settings</div>
                    {fields.map(field => (
                        <SettingInput key={field.key} field={field} value={draft[field.key]} onChange={value => set(field.key, value)} />
                    ))}
                    <Button onClick={() => onSaveSettings(draft)} disabled={savingSettings}>
                        {savingSettings && <Loader2 className="mr-1.5 size-4 animate-spin" />}
                        Save settings
                    </Button>
                </div>
            )}

            {secrets.length > 0 && (
                <div className="space-y-3">
                    <div className="blanc-eyebrow">Connection keys</div>
                    <p className="text-[13px]" style={{ color: 'var(--blanc-ink-2)' }}>
                        Stored encrypted and never shown again. The app uses them only to reach its declared endpoints.
                    </p>
                    {secrets.map(secret => (
                        <SecretRow
                            key={secret.connection}
                            secret={secret}
                            saving={savingSecret === secret.connection}
                            onSave={value => onSaveSecret(secret.connection, value)}
                        />
                    ))}
                </div>
            )}

            {fields.length === 0 && secrets.length === 0 && (
                <p className="py-8 text-center text-sm" style={{ color: 'var(--blanc-ink-2)' }}>
                    This app needs no configuration.
                </p>
            )}
        </div>
    );
}
