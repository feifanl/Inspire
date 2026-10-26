// iCal (.ics) text → flat list of event occurrences inside a time window.
// Recurring series are expanded with ical.js, which also applies EXDATEs and
// moved/cancelled single instances (RECURRENCE-ID overrides). No DOM — the
// service worker runs this too.
import ICAL from 'ical.js';
import type { CalEvent } from './types';

// Hard stop per series so a bad RRULE can't spin forever. Expansion walks from
// the series' first instance, so a years-old daily event needs a few thousand
// steps just to reach the window.
const MAX_OCCURRENCES = 50_000;

export interface ParsedCalendar {
  name: string; // X-WR-CALNAME, '' when absent
  events: CalEvent[];
}

// Google's secret iCal path is /calendar/ical/<calendar id>/private-…/basic.ics;
// the id is half of an event link's eid. '' for anything else.
function calendarIdFrom(url: string): string {
  const m = /\/calendar\/ical\/([^/]+)\//.exec(url);
  return m ? decodeURIComponent(m[1]) : '';
}

const pad = (n: number): string => String(n).padStart(2, '0');

// Deep link to one event in Google Calendar: eid = base64("<event id> <calendar id>").
// A recurring instance's event id carries its original start as a suffix. Falls
// back to that day's view when the UID isn't a Google one.
function eventLink(uid: string, calId: string, instance: ICAL.Time | null, day: Date): string {
  const dayView = `https://calendar.google.com/calendar/r/day/${day.getFullYear()}/${day.getMonth() + 1}/${day.getDate()}`;
  if (!calId || !uid.endsWith('@google.com')) return dayView;
  let id = uid.slice(0, -'@google.com'.length);
  if (instance) {
    if (instance.isDate) {
      id += `_${instance.year}${pad(instance.month)}${pad(instance.day)}`;
    } else {
      const u = instance.toJSDate();
      id +=
        `_${u.getUTCFullYear()}${pad(u.getUTCMonth() + 1)}${pad(u.getUTCDate())}` +
        `T${pad(u.getUTCHours())}${pad(u.getUTCMinutes())}${pad(u.getUTCSeconds())}Z`;
    }
  }
  try {
    const eid = btoa(`${id} ${calId}`).replace(/=+$/, '');
    return `https://calendar.google.com/calendar/event?eid=${eid}`;
  } catch {
    return dayView; // non-Latin-1 id; btoa can't encode it
  }
}

function isCancelled(ev: ICAL.Event): boolean {
  return String(ev.component.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED';
}

// All-day ends are exclusive dates; a missing DTEND means one day (all-day) or
// zero length (timed), per RFC 5545.
function toOccurrence(
  item: ICAL.Event,
  start: ICAL.Time,
  end: ICAL.Time | null,
  cal: number,
  calId: string,
  instance: ICAL.Time | null,
): CalEvent {
  const allDay = start.isDate;
  const s = start.toJSDate();
  let e = end ? end.toJSDate() : new Date(s);
  if (allDay && e.getTime() <= s.getTime()) e = new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1);
  return {
    id: `${cal}:${item.uid}:${s.getTime()}`,
    title: item.summary || '(No title)',
    start: s.getTime(),
    end: e.getTime(),
    allDay,
    location: item.location || undefined,
    cal,
    link: eventLink(item.uid, calId, instance, s),
  };
}

// Parse one feed and expand every occurrence that overlaps [from, to).
// `cal` tags each event with its feed's index (→ its color in the day view).
export function parseIcs(text: string, url: string, cal: number, from: number, to: number): ParsedCalendar {
  const root = new ICAL.Component(ICAL.parse(text));
  // Register the feed's own VTIMEZONEs so TZID-tagged times resolve correctly.
  for (const tz of root.getAllSubcomponents('vtimezone')) {
    const id = String(tz.getFirstPropertyValue('tzid') ?? '');
    if (id && !ICAL.TimezoneService.has(id)) ICAL.TimezoneService.register(tz);
  }
  const calId = calendarIdFrom(url);
  const name = String(root.getFirstPropertyValue('x-wr-calname') ?? '');

  // Group overrides (RECURRENCE-ID) under their series master.
  const masters = new Map<string, ICAL.Event>();
  const overrides: ICAL.Event[] = [];
  for (const c of root.getAllSubcomponents('vevent')) {
    const ev = new ICAL.Event(c);
    if (ev.isRecurrenceException()) overrides.push(ev);
    else masters.set(ev.uid, ev);
  }
  const orphans: ICAL.Event[] = [];
  for (const ov of overrides) {
    const m = masters.get(ov.uid);
    if (m?.isRecurring()) m.relateException(ov);
    else orphans.push(ov); // override without a recurring master: show it as-is
  }

  const events: CalEvent[] = [];
  const keep = (e: CalEvent): void => {
    if (e.end > from && e.start < to) events.push(e);
  };

  for (const ev of masters.values()) {
    if (!ev.isRecurring()) {
      if (!isCancelled(ev)) keep(toOccurrence(ev, ev.startDate, ev.endDate, cal, calId, null));
      continue;
    }
    const it = ev.iterator();
    for (let n = 0; n < MAX_OCCURRENCES; n++) {
      const next = it.next();
      if (!next) break;
      if (next.toJSDate().getTime() >= to) break;
      const d = ev.getOccurrenceDetails(next);
      if (isCancelled(d.item)) continue;
      keep(toOccurrence(d.item, d.startDate, d.endDate, cal, calId, d.recurrenceId));
    }
  }
  for (const ov of orphans) {
    if (!isCancelled(ov)) keep(toOccurrence(ov, ov.startDate, ov.endDate, cal, calId, ov.recurrenceId));
  }
  return { name, events };
}
