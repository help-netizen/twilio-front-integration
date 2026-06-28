import { useState } from 'react';
import { useJobsPage } from '../hooks/useJobsPage';
import { useIsMobile } from '../hooks/useIsMobile';
import { useAuthz } from '../hooks/useAuthz';
import { JobsFieldsButton } from '../components/jobs/JobsHeader';
import { JobsFilters } from '../components/jobs/JobsFilters';
import { JobsTable } from '../components/jobs/JobsTable';
import { JobsMobileBar } from '../components/jobs/JobsMobileBar';
import { JobsMobileList } from '../components/jobs/JobsMobileList';
import { JobDetailPanel } from '../components/jobs/JobDetailPanel';
import { NewJobDialog } from '../components/jobs/NewJobDialog';
import { buildCopyJobData, type CopyJobData } from '../components/jobs/copyJobData';
import { getJob, type LocalJob } from '../services/jobsApi';
import { Download, Loader2, Plus } from 'lucide-react';
import { FloatingDetailPanel } from '../components/ui/FloatingDetailPanel';

// ─── Jobs Page ───────────────────────────────────────────────────────────────

export function JobsPage() {
    const page = useJobsPage();
    const isMobile = useIsMobile();
    const { company, hasPermission } = useAuthz();
    const canCreateJob = hasPermission('jobs.create');
    const [newJobOpen, setNewJobOpen] = useState(false);
    const [copyFrom, setCopyFrom] = useState<CopyJobData | null>(null);

    // List rows may be summary-only, so fetch the full job before copying.
    const handleCopyJob = (job: LocalJob) => {
        getJob(job.id)
            .then(full => setCopyFrom(buildCopyJobData(full)))
            .catch(() => setCopyFrom(buildCopyJobData(job)));
    };

    return (
        <div className="blanc-page-wrapper">
            {!isMobile ? (
                <>
                    <div className="blanc-unified-header">
                        <h1 className="blanc-header-title">Jobs</h1>

                        <div className="blanc-search-wrapper">
                            <input
                                type="text"
                                placeholder="type to find anything..."
                                value={page.searchQuery}
                                onChange={(e) => page.setSearchQuery(e.target.value)}
                                className="blanc-search-input"
                            />
                        </div>

                        <div className="blanc-controls-group">
                            {canCreateJob && (
                                <button
                                    onClick={() => setNewJobOpen(true)}
                                    className="blanc-control-chip"
                                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                                >
                                    <Plus className="size-3.5" />
                                    New Job
                                </button>
                            )}
                            <JobsFilters
                                statusFilter={page.statusFilter}
                                onStatusFilterChange={page.setStatusFilter}
                                providerFilter={page.providerFilter}
                                onProviderFilterChange={page.setProviderFilter}
                                sourceFilter={page.sourceFilter}
                                onSourceFilterChange={page.setSourceFilter}
                                jobTypeFilter={page.jobTypeFilter}
                                onJobTypeFilterChange={page.setJobTypeFilter}
                                startDate={page.startDate}
                                onStartDateChange={page.setStartDate}
                                endDate={page.endDate}
                                onEndDateChange={page.setEndDate}
                                tagFilter={page.tagFilter}
                                onTagFilterChange={page.setTagFilter}
                                allTags={page.allTags}
                                jobs={page.jobs}
                            />
                            <JobsFieldsButton
                                visibleFields={page.visibleFields}
                                allColumns={page.allColumns}
                                allFieldKeys={page.allFieldKeys}
                                onSaveFields={page.saveVisibleFields}
                            />
                            <button
                                onClick={page.handleExportCSV}
                                disabled={page.filteredJobs.length === 0 || page.exporting}
                                className="blanc-control-chip"
                                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: (page.filteredJobs.length === 0 || page.exporting) ? 0.5 : 1 }}
                            >
                                {page.exporting ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                                Export
                            </button>
                        </div>
                    </div>
                    <div className="blanc-page-card">
                        <div className="flex flex-1 flex-col overflow-hidden">
                            <JobsTable
                                jobs={page.filteredJobs}
                                loading={page.loading}
                                selectedJobId={page.selectedJob?.id}
                                visibleFields={page.visibleFields}
                                allColumns={page.allColumns}
                                sortBy={page.sortBy}
                                sortOrder={page.sortOrder}
                                onSortChange={page.handleSortChange}
                                onSelectJob={page.handleSelectJob}
                                offset={page.offset}
                                totalCount={page.totalCount}
                                hasMore={page.hasMore}
                                limit={page.limit}
                                onLoadJobs={page.loadJobs}
                                onCopyJob={handleCopyJob}
                            />
                        </div>
                    </div>
                </>
            ) : (
                <>
                    <JobsMobileBar
                        searchQuery={page.searchQuery}
                        setSearchQuery={page.setSearchQuery}
                        statusFilter={page.statusFilter}
                        onStatusFilterChange={page.setStatusFilter}
                        providerFilter={page.providerFilter}
                        onProviderFilterChange={page.setProviderFilter}
                        sourceFilter={page.sourceFilter}
                        onSourceFilterChange={page.setSourceFilter}
                        jobTypeFilter={page.jobTypeFilter}
                        onJobTypeFilterChange={page.setJobTypeFilter}
                        tagFilter={page.tagFilter}
                        onTagFilterChange={page.setTagFilter}
                        allTags={page.allTags}
                        startDate={page.startDate}
                        onStartDateChange={page.setStartDate}
                        endDate={page.endDate}
                        onEndDateChange={page.setEndDate}
                        sortBy={page.sortBy}
                        sortOrder={page.sortOrder}
                        onSortChange={page.handleSortChange}
                        jobs={page.jobs}
                        onExportCSV={page.handleExportCSV}
                        exporting={page.exporting}
                        canExport={page.filteredJobs.length > 0}
                        onNewJob={() => setNewJobOpen(true)}
                        canCreateJob={canCreateJob}
                    />
                    <div className="flex-1 overflow-y-auto" style={{ minHeight: 0 }}>
                        <JobsMobileList
                            filteredJobs={page.filteredJobs}
                            loading={page.loading}
                            hasMore={page.hasMore}
                            onLoadMore={page.loadMoreJobs}
                            onSelectJob={page.handleSelectJob}
                            timezone={company?.timezone}
                        />
                    </div>
                </>
            )}
            <FloatingDetailPanel open={!!page.selectedJob} onClose={page.handleCloseDetail} wide>
                {page.selectedJob && (
                    <JobDetailPanel
                        job={page.selectedJob}
                        contactInfo={page.contactInfo}
                        detailLoading={page.detailLoading}
                        noteJobId={page.noteJobId}
                        noteText={page.noteText}
                        setNoteText={page.setNoteText}
                        setNoteJobId={page.setNoteJobId}
                        onClose={page.handleCloseDetail}
                        onBlancStatusChange={page.handleBlancStatusChange}
                        onAddNote={page.handleAddNote}
                        onMarkEnroute={page.handleMarkEnroute}
                        onMarkInProgress={page.handleMarkInProgress}
                        onMarkComplete={page.handleMarkComplete}
                        onCancel={page.handleCancel}
                        navigate={page.navigate}
                        allTags={page.allTags}
                        onTagsChange={page.handleTagsChange}
                        onJobUpdated={page.handleJobUpdated}
                        onNotified={page.afterMutation}
                        onCopy={() => page.selectedJob && setCopyFrom(buildCopyJobData(page.selectedJob))}
                    />
                )}
            </FloatingDetailPanel>
            <NewJobDialog open={newJobOpen} onClose={() => setNewJobOpen(false)} />
            <NewJobDialog open={!!copyFrom} copyFrom={copyFrom} onClose={() => setCopyFrom(null)} />
        </div>
    );
}

export default JobsPage;
