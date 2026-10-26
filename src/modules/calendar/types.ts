// Calendar cache shapes (root storage key "calendarCache"). No logic.

export interface CalEvent {
  id: string; // unique per occurrence
  title: string;
  start: number; // epoch ms; all-day = local midnight of the first day
  end: number; // epoch ms, exclusive
  allDay: boolean;
  location?: string;
  cal: number; // index of the feed in settings.calendar.urls → color
  link: string; // opens the event (or its day) in Google Calendar
}

export interface CalendarCache {
  syncedAt: number; // epoch ms of the last successful fetch; 0 = never loaded (see error)
  sources: string; // the feed URLs this was built from (joined), to detect edits
  from: number; // expanded window [from, to) — days outside show "not synced"
  to: number;
  names: string[]; // per-feed calendar name, '' if the feed has none
  events: CalEvent[];
  error?: string; // last attempt failed; events are from the previous good sync
}
