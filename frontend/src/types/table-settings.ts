// Table column settings types

export interface TableColumn {
    id: string;
    label: string;
    visible: boolean;
    order: number;
    locked?: boolean; // locked columns cannot be hidden
}

export type ColumnId =
    | 'status'
    | 'name'
    | 'phone'
    | 'email'
    | 'location'
    | 'jobType'
    | 'jobSource'
    | 'created'
    | 'serialId';

export const DEFAULT_COLUMNS: TableColumn[] = [
    { id: 'status', label: 'Status', visible: true, order: 0 },
    { id: 'name', label: 'Name', visible: true, order: 1 },
    { id: 'phone', label: 'Phone', visible: true, order: 2 },
    { id: 'email', label: 'Email', visible: true, order: 3 },
    { id: 'location', label: 'Location', visible: true, order: 4 },
    { id: 'jobType', label: 'Job Type', visible: true, order: 5 },
    { id: 'jobSource', label: 'Source', visible: true, order: 6 },
    { id: 'created', label: 'Created', visible: true, order: 7 },
    { id: 'serialId', label: 'ID', visible: true, order: 8 },
];
