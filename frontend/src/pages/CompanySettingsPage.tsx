import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { CompanyBaseAddress } from '../components/settings/CompanyBaseAddress';

/**
 * Settings → Company. For now this holds only the company address, which becomes
 * the default base location technicians can point to (Technicians page → "Matches
 * company address"). The same address is editable from the Technicians page too.
 */
export default function CompanySettingsPage() {
    const navigate = useNavigate();
    return (
        <div className="max-w-2xl mx-auto px-6 py-8" style={{ color: 'var(--blanc-ink-1)' }}>
            <button onClick={() => navigate('/settings/integrations')} className="flex items-center gap-1.5 text-sm mb-6" style={{ color: 'var(--blanc-ink-3)' }}>
                <ArrowLeft className="h-4 w-4" /> Settings
            </button>
            <h2 className="text-2xl font-semibold" style={{ fontFamily: 'var(--blanc-font-heading, inherit)' }}>Company</h2>
            <p className="text-sm mt-1 mb-6" style={{ color: 'var(--blanc-ink-3)' }}>
                Your business address. Technicians can use it as their base location so the scheduler can suggest the best arrival times.
            </p>
            <CompanyBaseAddress title="Company address" />
        </div>
    );
}
