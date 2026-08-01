import { SettingsPageShell } from '../components/settings/SettingsPageShell';
import NotificationsSection from './NotificationsSection';

/**
 * NOTIF-REWORK-001 — the "Alerts & notifications" settings page.
 *
 * The former "Action triggers" section (inbound SMS / missed call / voicemail →
 * flag + task) was removed from the UI; that behaviour belongs to Automations,
 * which are not surfaced here yet. Its backend (`/api/settings/action-required`,
 * the AR config + workers) is intentionally left intact and untouched.
 */
export default function ActionRequiredSettingsPage() {
    return (
        <SettingsPageShell
            title="Alerts & notifications"
            description="Choose what Albusto notifies you about."
        >
            <NotificationsSection />
        </SettingsPageShell>
    );
}
