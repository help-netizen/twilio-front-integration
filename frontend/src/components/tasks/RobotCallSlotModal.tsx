import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';
import { CustomTimeModal } from '../conversations/CustomTimeModal';
import { getJob, type LocalJob } from '../../services/jobsApi';
import { runTaskAction } from './tasksApi';

/**
 * OUTBOUND-PARTS-CALL-SLOTPICK-001 — thin wrapper that lets a dispatcher pick the
 * robot call's slot by REUSING the reschedule form `CustomTimeModal` (ranked recs +
 * technician timelines + map). It fetches the linked job for coords/territory, feeds
 * them to the modal, and on the modal's single explicit confirm POSTs the chosen ISO
 * window to `runTaskAction(taskId,'robot_call',{ slot })`. The server converts the
 * instants → company-local `slot_json` — the client label is never trusted.
 *
 * The modal's own `disabled={!selectedSlot}` CTA enforces the explicit pick, so no
 * extra `window.confirm` is needed. A valid slot queues + closes; an invalid slot
 * (400) or a domain refusal keeps the modal open so the dispatcher can re-pick.
 */
export interface RobotCallSlotModalProps {
    open: boolean;
    onClose: () => void;
    /** Task id — the `:id` in `POST /api/tasks/:id/actions/robot_call`. */
    taskId: number;
    /** Linked job id — fetched for the modal's coords / territory / exclusion. */
    jobId: number | string;
    /** Called after the slot is successfully queued (e.g. refetch the surface). */
    onQueued?: () => void;
}

export function RobotCallSlotModal({ open, onClose, taskId, jobId, onQueued }: RobotCallSlotModalProps) {
    const [job, setJob] = useState<LocalJob | null>(null);
    const [loading, setLoading] = useState(false);
    const [queueing, setQueueing] = useState(false);

    // Fetch the linked job on open (coords/territory feed the modal). A hard failure
    // toasts + closes — with no coords the modal can't help the dispatcher.
    useEffect(() => {
        if (!open) { setJob(null); return; }
        let cancelled = false;
        setLoading(true);
        getJob(Number(jobId))
            .then((j) => { if (!cancelled) setJob(j); })
            .catch((err) => {
                if (cancelled) return;
                toast.error(err instanceof Error ? err.message : 'Failed to load the job');
                onClose();
            })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, jobId]);

    if (!open) return null;

    // Queue the dispatcher's chosen window. `runTaskAction` throws on a 400
    // (invalid_slot) / auth / network failure, and returns `{ ok:false, reason }`
    // for a 200 domain refusal (no_phone / not_dialable / disabled / no_slots) — both
    // toast and KEEP the modal open so the dispatcher can re-pick.
    const handleQueue = async (slot: { start: string; end: string }) => {
        if (queueing) return;
        setQueueing(true);
        try {
            const result = await runTaskAction(taskId, 'robot_call', {
                slot: { startIso: slot.start, endIso: slot.end },
            });
            if (result.ok) {
                toast.success('Robot call queued');
                onQueued?.();
                onClose();
            } else {
                toast.error(result.reason || 'The robot could not place the call');
            }
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Could not queue the robot call');
        } finally {
            setQueueing(false);
        }
    };

    if (loading || !job) {
        return (
            <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
                <DialogContent size="sm" aria-describedby={undefined}>
                    <DialogTitle className="sr-only">Schedule the robot call</DialogTitle>
                    <div
                        className="flex items-center justify-center gap-2 py-8"
                        style={{ color: 'var(--blanc-ink-2)', fontSize: 13 }}
                    >
                        <Loader2 className="size-4 animate-spin" /> Loading job…
                    </div>
                </DialogContent>
            </Dialog>
        );
    }

    const coords = job.lat && job.lng ? { lat: job.lat, lng: job.lng } : null;
    const territoryId = job.zb_raw?.territory?.id || job.zb_raw?.service_territory?.id || undefined;

    return (
        <CustomTimeModal
            open
            onClose={onClose}
            newJobCoords={coords}
            newJobAddress={job.address}
            newJobDuration={120}
            territoryId={territoryId}
            excludeJobId={Number(jobId)}
            title="Schedule the robot call"
            confirmLabel="Queue robot call"
            onConfirm={handleQueue}
        />
    );
}
