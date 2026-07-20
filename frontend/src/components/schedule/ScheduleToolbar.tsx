/** Schedule desktop page header — follows the shared Jobs header composition. */

import React from 'react';
import { Plus } from 'lucide-react';

interface ScheduleToolbarProps {
    searchValue: string;
    onSearchChange: (value: string) => void;
    onNewJob?: () => void;
}

export const ScheduleToolbar: React.FC<ScheduleToolbarProps> = ({ searchValue, onSearchChange, onNewJob }) => {
    return (
        <div className="blanc-unified-header">
            <h1 className="blanc-header-title">Schedule</h1>

            <div className="blanc-search-wrapper">
                <input
                    type="text"
                    placeholder="type to find anything..."
                    value={searchValue}
                    onChange={(event) => onSearchChange(event.target.value)}
                    className="blanc-search-input"
                />
            </div>

            <div className="blanc-controls-group">
                {onNewJob && (
                    <button
                        type="button"
                        onClick={onNewJob}
                        className="blanc-control-chip"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                    >
                        <Plus className="size-3.5" />
                        New job
                    </button>
                )}
            </div>
        </div>
    );
};
