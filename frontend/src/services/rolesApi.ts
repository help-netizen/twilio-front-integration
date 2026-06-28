import { authedFetch } from './apiClient';

const API_BASE = '/api/settings/roles';

/** One permission row in the catalog (key + human label). */
export interface CatalogItem {
    key: string;
    label: string;
}

/** A category group of permissions in the catalog. */
export interface CatalogGroup {
    category: string;
    items: CatalogItem[];
}

/** A role's row in the matrix: role_key, display name, lock flag, and key→bool map. */
export interface RoleMatrixRole {
    role_key: string;
    display_name: string;
    is_locked: boolean;
    permissions: Record<string, boolean>;
}

/** Full payload from GET /api/settings/roles. */
export interface RoleMatrix {
    catalog: CatalogGroup[];
    mandatoryAdminPermissions: string[];
    roles: RoleMatrixRole[];
}

export type OverrideMode = 'allow' | 'deny';

/** A company member for the overrides ("People") tab. */
export interface RoleMember {
    membership_id: string;
    user_id: string;
    name: string;
    email: string;
    role_key: string;
    role_name: string;
    status: string;
    overrides: Record<string, OverrideMode>;
}

/** Unwrap a `{ ok, data }` envelope, throwing the server message on failure. */
async function unwrap<T>(res: Response): Promise<T> {
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || json.ok === false) {
        throw new Error(json?.error?.message || json?.message || `Request failed: ${res.status}`);
    }
    return json.data as T;
}

/** GET the full role permission matrix for the company. */
export async function getRoleMatrix(): Promise<RoleMatrix> {
    const res = await authedFetch(API_BASE);
    return unwrap<RoleMatrix>(res);
}

/** Toggle a single permission on a role. Returns the role's updated permission map. */
export async function setRolePermission(
    roleKey: string,
    permissionKey: string,
    isAllowed: boolean,
): Promise<{ permissions: Record<string, boolean> }> {
    const res = await authedFetch(`${API_BASE}/${encodeURIComponent(roleKey)}/permissions`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permission_key: permissionKey, is_allowed: isAllowed }),
    });
    return unwrap<{ permissions: Record<string, boolean> }>(res);
}

/** GET company members + their per-permission overrides. */
export async function getMembers(): Promise<RoleMember[]> {
    const res = await authedFetch(`${API_BASE}/members`);
    return unwrap<RoleMember[]>(res);
}

/** Set or clear (mode = null) a single member override. Returns the member's updated override map. */
export async function setMemberOverride(
    membershipId: string,
    permissionKey: string,
    mode: OverrideMode | null,
): Promise<{ overrides: Record<string, OverrideMode> }> {
    const res = await authedFetch(`${API_BASE}/members/${encodeURIComponent(membershipId)}/overrides`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permission_key: permissionKey, override_mode: mode }),
    });
    return unwrap<{ overrides: Record<string, OverrideMode> }>(res);
}
