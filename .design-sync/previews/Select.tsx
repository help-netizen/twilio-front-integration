import {
  Select, SelectTrigger, SelectValue, SelectContent,
  SelectGroup, SelectLabel, SelectItem, SelectSeparator, Label,
} from 'albusto-ui';

// Closed trigger showing a chosen value — the common form-field state.
export const Field = () => (
  <div style={{ display: 'grid', gap: 6, maxWidth: 280 }}>
    <Label>Job status</Label>
    <Select defaultValue="scheduled">
      <SelectTrigger>
        <SelectValue placeholder="Select a status" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="new">New</SelectItem>
        <SelectItem value="scheduled">Scheduled</SelectItem>
        <SelectItem value="in_progress">In progress</SelectItem>
        <SelectItem value="done">Done</SelectItem>
      </SelectContent>
    </Select>
  </div>
);

// Placeholder / empty state, with a grouped + separated option list.
export const Placeholder = () => (
  <div style={{ maxWidth: 280 }}>
    <Select>
      <SelectTrigger>
        <SelectValue placeholder="Choose a provider" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Boston team</SelectLabel>
          <SelectItem value="marcus">Marcus Bell</SelectItem>
          <SelectItem value="dana">Dana Ruiz</SelectItem>
        </SelectGroup>
        <SelectSeparator />
        <SelectItem value="unassigned">Unassigned</SelectItem>
      </SelectContent>
    </Select>
  </div>
);

// Open state — renders the popup list statically so the option styling is visible.
export const Open = () => (
  <div style={{ maxWidth: 280, minHeight: 240 }}>
    <Select defaultOpen defaultValue="scheduled">
      <SelectTrigger>
        <SelectValue placeholder="Select a status" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="new">New</SelectItem>
        <SelectItem value="scheduled">Scheduled</SelectItem>
        <SelectItem value="in_progress">In progress</SelectItem>
        <SelectItem value="done">Done</SelectItem>
      </SelectContent>
    </Select>
  </div>
);
