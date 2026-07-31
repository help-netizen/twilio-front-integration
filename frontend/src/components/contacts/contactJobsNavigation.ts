export function buildContactJobsUrl(displayName: string, contactId?: number | null): string {
    const search = `search=${encodeURIComponent(displayName)}`;
    return contactId == null
        ? `/jobs?${search}`
        : `/jobs?${search}&contact_id=${encodeURIComponent(String(contactId))}`;
}
