import { authedFetch } from './apiClient';

export interface Technician {
    tech_id: string;
    name: string | null;
    has_photo: boolean;
}

export const techniciansApi = {
    list: async (): Promise<Technician[]> => {
        const res = await authedFetch('/api/settings/technicians');
        const json = await res.json();
        if (!res.ok || json.ok === false) throw new Error(json.error?.message || `Request failed: ${res.status}`);
        return json.data;
    },
    uploadPhoto: async (techId: string, file: File, name?: string): Promise<{ tech_id: string; has_photo: boolean }> => {
        const fd = new FormData();
        fd.append('photo', file);
        if (name) fd.append('name', name);
        // Note: do NOT set Content-Type — the browser sets the multipart boundary.
        const res = await authedFetch(`/api/settings/technicians/${encodeURIComponent(techId)}/photo`, { method: 'POST', body: fd });
        const json = await res.json();
        if (!res.ok || json.ok === false) throw new Error(json.error?.message || `Upload failed: ${res.status}`);
        return json.data;
    },
};
