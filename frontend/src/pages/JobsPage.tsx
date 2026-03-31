import { useJobsPage } from '../hooks/useJobsPage';
import { JobsHeader, JobsFieldsButton } from '../components/jobs/JobsHeader';
import { JobsFilters } from '../components/jobs/JobsFilters';
import { JobsTable } from '../components/jobs/JobsTable';
import { JobDetailPanel } from '../components/jobs/JobDetailPanel';

// ─── Jobs Page ───────────────────────────────────────────────────────────────

export function JobsPage() {
    const page = useJobsPage();

    return (
        <div className="blanc-page-wrapper">
            <div className="blanc-page-header">
                <JobsHeader
                    loading={page.loading}
                    exporting={page.exporting}
                    filteredJobsCount={page.filteredJobs.length}
                    visibleFields={page.visibleFields}
                    allColumns={page.allColumns}
                    allFieldKeys={page.allFieldKeys}
                    onRefresh={() => page.loadJobs(page.offset)}
                    onExportCSV={page.handleExportCSV}
                    onSaveFields={page.saveVisibleFields}
                />
            </div>
            <div className="blanc-page-toolbar" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ flex: 1 }}>
                    <JobsFilters
                        searchQuery={page.searchQuery}
                        onSearchChange={page.setSearchQuery}
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
                        onlyOpen={page.onlyOpen}
                        onOnlyOpenChange={page.setOnlyOpen}
                        tagFilter={page.tagFilter}
                        onTagFilterChange={page.setTagFilter}
                        allTags={page.allTags}
                        jobs={page.jobs}
                    />
                </div>
                <JobsFieldsButton
                    visibleFields={page.visibleFields}
                    allColumns={page.allColumns}
                    allFieldKeys={page.allFieldKeys}
                    onSaveFields={page.saveVisibleFields}
                />
            </div>
            <div className="blanc-page-card">
                {/* ── Left: Jobs List ─────────────────────────────────────── */}
                <div className={`flex flex-col overflow-hidden ${page.selectedJob ? 'hidden md:flex md:w-[340px] md:flex-shrink-0' : 'flex flex-1'}`}>
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
                    />
                </div>

                {/* ── Right: Detail Panel ─────────────────────────────────── */}
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
                    />
                )}
            </div>
        </div>
    );
}

export default JobsPage;
