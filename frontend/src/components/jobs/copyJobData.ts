/**
 * copyJobData — build the pre-fill payload for the "Copy job" feature.
 *
 * Given an existing LocalJob, produce a CopyJobData snapshot that the New Job
 * dialog consumes to pre-populate every field EXCEPT the timeslot. The
 * technician is carried over as a preferred (pre-selected) tech; the contact is
 * linked by id; the address is parsed back into structured fields.
 */
import type { LocalJob } from '../../services/jobsApi';
import { parseDescription, type AddressFields } from '../addressAutoHelpers';

export interface CopyJobData {
    contact?: { id: number; name: string };
    address: AddressFields;
    jobType: string;
    description: string;
    techId?: string;
}

export function buildCopyJobData(job: LocalJob): CopyJobData {
    return {
        contact: job.contact_id
            ? { id: job.contact_id, name: job.customer_name || `Contact #${job.contact_id}` }
            : undefined,
        address: { ...parseDescription(job.address || ''), lat: job.lat ?? null, lng: job.lng ?? null },
        jobType: job.job_type || '',
        description: job.description || '',
        techId: job.assigned_techs?.[0]?.id,
    };
}
