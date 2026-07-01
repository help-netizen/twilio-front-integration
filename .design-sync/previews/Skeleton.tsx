import { Skeleton } from 'albusto-ui';

const line: React.CSSProperties = { border: '1px solid var(--blanc-line)', borderRadius: 16, padding: 16 };

// A job-card placeholder: avatar circle + title + two meta lines + a button bar.
// Mirrors the real job card's layout so the loading state reads as "a job is coming".
export const JobCardLoading = () => (
  <div style={{ ...line, maxWidth: 420, display: 'grid', gap: 12 }}>
    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
      <Skeleton style={{ height: 40, width: 40, borderRadius: 9999 }} />
      <div style={{ display: 'grid', gap: 8, flex: 1 }}>
        <Skeleton style={{ height: 16, width: '70%' }} />
        <Skeleton style={{ height: 12, width: '45%' }} />
      </div>
    </div>
    <Skeleton style={{ height: 12, width: '90%' }} />
    <Skeleton style={{ height: 12, width: '60%' }} />
    <div style={{ display: 'flex', gap: 8, paddingTop: 4 }}>
      <Skeleton style={{ height: 32, width: 96, borderRadius: 10 }} />
      <Skeleton style={{ height: 32, width: 96, borderRadius: 10 }} />
    </div>
  </div>
);

// A list placeholder — three stacked rows, the Jobs/Leads table loading state.
export const ListLoading = () => (
  <div style={{ maxWidth: 460, display: 'grid', gap: 12 }}>
    {[0, 1, 2].map((i) => (
      <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <Skeleton style={{ height: 10, width: 10, borderRadius: 9999 }} />
        <Skeleton style={{ height: 14, width: '50%' }} />
        <Skeleton style={{ height: 14, width: 72, marginLeft: 'auto', borderRadius: 8 }} />
      </div>
    ))}
  </div>
);
