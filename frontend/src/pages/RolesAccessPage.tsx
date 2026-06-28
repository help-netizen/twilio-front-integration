import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, ShieldCheck, Lock } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs';
import { Checkbox } from '../components/ui/checkbox';
import { useIsMobile } from '../hooks/useIsMobile';
import {
    getRoleMatrix,
    setRolePermission,
    getMembers,
    setMemberOverride,
    type RoleMatrix,
    type RoleMatrixRole,
    type RoleMember,
    type OverrideMode,
} from '../services/rolesApi';

const LOCKED_ROLE_KEY = 'tenant_admin';

function Eyebrow({ children }: { children: React.ReactNode }) {
    return (
        <div
            className="blanc-eyebrow"
            style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.14em', color: 'var(--blanc-ink-3)' }}
        >
            {children}
        </div>
    );
}

/** A role column is locked if it's the admin role or its config is_locked. */
function isLockedRole(role: RoleMatrixRole): boolean {
    return role.role_key === LOCKED_ROLE_KEY || role.is_locked;
}

// ── Roles tab — permission × role matrix ────────────────────────────────────

function RolesMatrix({ matrix, onMatrixChange }: { matrix: RoleMatrix; onMatrixChange: (m: RoleMatrix) => void }) {
    const { catalog, roles } = matrix;

    const setCell = (roleKey: string, key: string, value: boolean) => {
        onMatrixChange({
            ...matrix,
            roles: matrix.roles.map(r =>
                r.role_key === roleKey ? { ...r, permissions: { ...r.permissions, [key]: value } } : r,
            ),
        });
    };

    const toggle = async (role: RoleMatrixRole, key: string, next: boolean) => {
        const prev = role.permissions[key] ?? false;
        setCell(role.role_key, key, next); // optimistic
        try {
            const { permissions } = await setRolePermission(role.role_key, key, next);
            // Reconcile with the authoritative map from the server.
            onMatrixChange({
                ...matrix,
                roles: matrix.roles.map(r =>
                    r.role_key === role.role_key ? { ...r, permissions } : r,
                ),
            });
        } catch (e: any) {
            setCell(role.role_key, key, prev); // revert
            toast.error(e?.message || 'Could not update permission');
        }
    };

    return (
        <div>
            <p className="text-[13px] mb-4 flex items-start gap-2" style={{ color: 'var(--blanc-ink-2)' }}>
                <ShieldCheck className="size-4 mt-0.5 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
                <span>
                    Admin always has full access; some Admin permissions are mandatory and can't be removed.
                    Changes take effect on the affected person's next sign-in — no logout needed.
                </span>
            </p>

            <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                    <thead>
                        <tr>
                            <th style={{ textAlign: 'left', padding: '8px 12px', position: 'sticky', left: 0, background: 'var(--blanc-bg)', minWidth: 240 }}>
                                <span className="blanc-eyebrow" style={{ fontSize: 11, color: 'var(--blanc-ink-3)' }}>Permission</span>
                            </th>
                            {roles.map(role => (
                                <th key={role.role_key} style={{ padding: '8px 12px', textAlign: 'center', minWidth: 110 }}>
                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                                        <span style={{ fontFamily: 'var(--blanc-font-heading, Manrope), sans-serif', fontWeight: 600, color: 'var(--blanc-ink-1)' }}>
                                            {role.display_name}
                                        </span>
                                        {isLockedRole(role) && (
                                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, color: 'var(--blanc-ink-3)' }}>
                                                <Lock className="size-3" /> Full access
                                            </span>
                                        )}
                                    </div>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {catalog.map(group => (
                            <GroupRows key={group.category} group={group} roles={roles} toggle={toggle} />
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

function GroupRows({
    group,
    roles,
    toggle,
}: {
    group: RoleMatrix['catalog'][number];
    roles: RoleMatrixRole[];
    toggle: (role: RoleMatrixRole, key: string, next: boolean) => void;
}) {
    return (
        <>
            <tr>
                <td colSpan={roles.length + 1} style={{ padding: '16px 12px 6px' }}>
                    <Eyebrow>{group.category}</Eyebrow>
                </td>
            </tr>
            {group.items.map(item => (
                <tr key={item.key} style={{ borderTop: '1px solid var(--blanc-line)' }}>
                    <td style={{ padding: '10px 12px', position: 'sticky', left: 0, background: 'var(--blanc-bg)', color: 'var(--blanc-ink-1)' }}>
                        {item.label}
                    </td>
                    {roles.map(role => {
                        const locked = isLockedRole(role);
                        const checked = locked ? true : (role.permissions[item.key] ?? false);
                        return (
                            <td key={role.role_key} style={{ padding: '10px 12px', textAlign: 'center' }}>
                                <Checkbox
                                    checked={checked}
                                    disabled={locked}
                                    onCheckedChange={(v) => toggle(role, item.key, v === true)}
                                    aria-label={`${role.display_name}: ${item.label}`}
                                />
                            </td>
                        );
                    })}
                </tr>
            ))}
        </>
    );
}

// ── People tab — per-member overrides ───────────────────────────────────────

type EffectiveState = 'inherit' | 'allow' | 'deny';

/** What the member actually gets for a key: override wins, else the role default. */
function effectiveAllowed(roleDefault: boolean, override: OverrideMode | undefined): boolean {
    if (override === 'allow') return true;
    if (override === 'deny') return false;
    return roleDefault;
}

function TriState({
    value,
    onChange,
}: {
    value: EffectiveState;
    onChange: (next: EffectiveState) => void;
}) {
    const options: { v: EffectiveState; label: string }[] = [
        { v: 'inherit', label: 'Inherit' },
        { v: 'allow', label: 'Allow' },
        { v: 'deny', label: 'Deny' },
    ];
    return (
        <div style={{ display: 'inline-flex', borderRadius: 10, overflow: 'hidden', border: '1px solid var(--blanc-line)' }}>
            {options.map((o, i) => {
                const active = value === o.v;
                return (
                    <button
                        key={o.v}
                        onClick={() => onChange(o.v)}
                        style={{
                            padding: '4px 12px',
                            fontSize: 13,
                            cursor: 'pointer',
                            border: 'none',
                            borderLeft: i === 0 ? 'none' : '1px solid var(--blanc-line)',
                            background: active
                                ? (o.v === 'deny' ? '#fdecec' : o.v === 'allow' ? '#eaf6ee' : 'var(--blanc-surface-strong, #fffdf9)')
                                : 'transparent',
                            color: active
                                ? (o.v === 'deny' ? '#b42318' : o.v === 'allow' ? '#27693f' : 'var(--blanc-ink-1)')
                                : 'var(--blanc-ink-3)',
                            fontWeight: active ? 600 : 400,
                        }}
                    >
                        {o.label}
                    </button>
                );
            })}
        </div>
    );
}

function PeoplePanel({ matrix }: { matrix: RoleMatrix }) {
    const [members, setMembers] = useState<RoleMember[] | null>(null);
    const [loadErr, setLoadErr] = useState<string | null>(null);
    const [selectedId, setSelectedId] = useState<string>('');

    useEffect(() => {
        let alive = true;
        getMembers()
            .then(m => {
                if (!alive) return;
                setMembers(m);
                if (m.length && !selectedId) setSelectedId(m[0].membership_id);
            })
            .catch(e => alive && setLoadErr(e?.message || 'Failed to load members'));
        return () => { alive = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const roleByKey = useMemo(() => {
        const map: Record<string, RoleMatrixRole> = {};
        for (const r of matrix.roles) map[r.role_key] = r;
        return map;
    }, [matrix.roles]);

    const selected = members?.find(m => m.membership_id === selectedId) || null;
    const selectedRole = selected ? roleByKey[selected.role_key] : undefined;
    const adminMandatory = new Set(matrix.mandatoryAdminPermissions);
    const isAdminMember = selected?.role_key === LOCKED_ROLE_KEY;

    const applyOverride = async (key: string, next: EffectiveState) => {
        if (!selected) return;
        const mode: OverrideMode | null = next === 'inherit' ? null : next;
        const prevOverrides = selected.overrides;
        // optimistic
        setMembers(prev => prev!.map(m => {
            if (m.membership_id !== selected.membership_id) return m;
            const o = { ...m.overrides };
            if (mode === null) delete o[key]; else o[key] = mode;
            return { ...m, overrides: o };
        }));
        try {
            const { overrides } = await setMemberOverride(selected.membership_id, key, mode);
            setMembers(prev => prev!.map(m =>
                m.membership_id === selected.membership_id ? { ...m, overrides } : m,
            ));
        } catch (e: any) {
            setMembers(prev => prev!.map(m =>
                m.membership_id === selected.membership_id ? { ...m, overrides: prevOverrides } : m,
            ));
            toast.error(e?.message || 'Could not update override');
        }
    };

    if (loadErr) {
        return <p className="text-sm" style={{ color: '#b42318' }}>{loadErr}</p>;
    }
    if (!members) {
        return <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--blanc-ink-3)' }}><Loader2 className="size-4 animate-spin" /> Loading members…</div>;
    }
    if (members.length === 0) {
        return <p className="text-sm" style={{ color: 'var(--blanc-ink-3)' }}>No members in this company yet.</p>;
    }

    return (
        <div>
            <p className="text-[13px] mb-4" style={{ color: 'var(--blanc-ink-2)' }}>
                Overrides change one person's access on top of their role. Leave a permission on
                <strong> Inherit</strong> to follow the role default. Changes apply on the member's next sign-in.
            </p>

            <div className="mb-5" style={{ maxWidth: 360 }}>
                <Eyebrow>Member</Eyebrow>
                <select
                    value={selectedId}
                    onChange={(e) => setSelectedId(e.target.value)}
                    className="mt-1 w-full rounded-xl px-3 py-2 text-sm"
                    style={{ border: '1px solid var(--blanc-line)', background: 'var(--blanc-surface-strong, #fffdf9)', color: 'var(--blanc-ink-1)' }}
                >
                    {members.map(m => (
                        <option key={m.membership_id} value={m.membership_id}>
                            {m.name} — {m.role_name}{m.status !== 'active' ? ' (inactive)' : ''}
                        </option>
                    ))}
                </select>
            </div>

            {selected && selectedRole && (
                <>
                    {isAdminMember && (
                        <p className="text-[13px] mb-4 flex items-start gap-2" style={{ color: 'var(--blanc-ink-2)' }}>
                            <Lock className="size-4 mt-0.5 shrink-0" style={{ color: 'var(--blanc-ink-3)' }} />
                            <span>This member is an Admin. Denying a mandatory Admin permission has no effect — it's re-granted automatically.</span>
                        </p>
                    )}
                    {matrix.catalog.map(group => (
                        <div key={group.category} className="mb-5">
                            <Eyebrow>{group.category}</Eyebrow>
                            <div className="mt-2 flex flex-col">
                                {group.items.map(item => {
                                    const roleDefault = selectedRole.permissions[item.key] ?? false;
                                    const override: OverrideMode | undefined = selected.overrides[item.key];
                                    const state: EffectiveState = override ? override : 'inherit';
                                    const effective = effectiveAllowed(roleDefault, override);
                                    const neutralized = isAdminMember && adminMandatory.has(item.key) && override === 'deny';
                                    return (
                                        <div
                                            key={item.key}
                                            className="flex items-center justify-between gap-4 py-2"
                                            style={{ borderTop: '1px solid var(--blanc-line)' }}
                                        >
                                            <div style={{ color: 'var(--blanc-ink-1)', fontSize: 14 }}>
                                                {item.label}
                                                <span className="ml-2" style={{ fontSize: 12, color: effective ? '#27693f' : 'var(--blanc-ink-3)' }}>
                                                    {effective ? 'Allowed' : 'Not allowed'}
                                                    {state === 'inherit' ? ' (role default)' : ''}
                                                    {neutralized ? ' · mandatory, re-granted' : ''}
                                                </span>
                                            </div>
                                            <TriState value={state} onChange={(next) => applyOverride(item.key, next)} />
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    ))}
                </>
            )}
        </div>
    );
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function RolesAccessPage() {
    const isMobile = useIsMobile();
    const [matrix, setMatrix] = useState<RoleMatrix | null>(null);
    const [err, setErr] = useState<string | null>(null);

    useEffect(() => {
        if (isMobile) return;
        let alive = true;
        getRoleMatrix()
            .then(m => alive && setMatrix(m))
            .catch(e => alive && setErr(e?.message || 'Failed to load roles'));
        return () => { alive = false; };
    }, [isMobile]);

    if (isMobile) {
        return (
            <div className="max-w-6xl mx-auto p-6">
                <div className="blanc-eyebrow">Access</div>
                <h1 className="text-2xl font-semibold" style={{ fontFamily: 'var(--blanc-font-heading, Manrope), sans-serif', color: 'var(--blanc-ink-1)' }}>Roles & Access</h1>
                <p className="text-sm mt-4" style={{ color: 'var(--blanc-ink-2)' }}>
                    The access grid is wide — please manage roles & access on a larger screen.
                </p>
            </div>
        );
    }

    return (
        <div className="max-w-6xl mx-auto p-6 space-y-6">
            <div>
                <div className="blanc-eyebrow">Access</div>
                <h1 className="text-2xl font-semibold" style={{ fontFamily: 'var(--blanc-font-heading, Manrope), sans-serif', color: 'var(--blanc-ink-1)' }}>Roles & Access</h1>
                <p className="text-sm mt-1" style={{ color: 'var(--blanc-ink-2)' }}>
                    Control what each role can do, and fine-tune individual people with overrides.
                </p>
            </div>

            {err && <p className="text-sm" style={{ color: '#b42318' }}>{err}</p>}

            {!matrix && !err && (
                <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--blanc-ink-3)' }}>
                    <Loader2 className="size-4 animate-spin" /> Loading roles…
                </div>
            )}

            {matrix && (
                <Tabs defaultValue="roles">
                    <TabsList>
                        <TabsTrigger value="roles">Roles</TabsTrigger>
                        <TabsTrigger value="people">People</TabsTrigger>
                    </TabsList>
                    <TabsContent value="roles" className="pt-4">
                        <RolesMatrix matrix={matrix} onMatrixChange={setMatrix} />
                    </TabsContent>
                    <TabsContent value="people" className="pt-4">
                        <PeoplePanel matrix={matrix} />
                    </TabsContent>
                </Tabs>
            )}
        </div>
    );
}
