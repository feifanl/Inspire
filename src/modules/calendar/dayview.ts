// Google-style single-day grid for the sidebar's Today tab: hours down the
// side, events as blocks sized by length, overlapping events side by side, a
// red now-line. ‹ › step days, "Today" jumps back. One long-lived instance —
// the todo sidebar re-appends `el` on each rebuild, so scroll position and the
// shown day survive.
import { h } from '../../core/dom';
import type { CalendarCache, CalEvent } from './types';
import { syncedAgo } from './sync';

const HOUR_PX = 44;
const DAY_MS = 86_400_000;
const MIN_BLOCK_PX = 20;

export interface DayView {
  el: HTMLElement;
  setCache(cache: CalendarCache | null): void;
  // Call right after (re)attaching `el`: reattaching drops scrollTop, so this
  // restores it — or, with reset, scrolls to "now" (today) / the first event.
  attached(reset: boolean): void;
  destroy(): void;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Same "Weekday · Mon D" shape as the tasks header.
function dayLabel(d: Date): string {
  const weekday = d.toLocaleDateString('en-US', { weekday: 'long' });
  const md = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${weekday} · ${md}`;
}

// en-US like every other date on the page, so a non-English browser doesn't
// mix "14时" into an otherwise English panel.
function timeLabel(t: number): string {
  return new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function hourLabel(hr: number): string {
  return new Date(2000, 0, 1, hr).toLocaleTimeString('en-US', { hour: 'numeric' });
}

// Minutes since the day's midnight, clamped into [0, 1440]. Built from wall
// clock fields, so DST days still lay out on a 24-row grid.
function minuteOfDay(t: number, day: Date): number {
  if (t <= day.getTime()) return 0;
  const d = new Date(t);
  if (!sameDay(d, day)) return 24 * 60;
  return d.getHours() * 60 + d.getMinutes();
}

interface Placed {
  ev: CalEvent;
  top: number; // minutes
  bottom: number;
  col: number;
  cols: number;
}

// Classic calendar packing: walk events by start, group runs that overlap into
// clusters, give each event the first free column, then every member of a
// cluster shares the cluster's column count.
function layoutDay(events: CalEvent[], day: Date): Placed[] {
  const items = events
    .map((ev) => {
      const top = minuteOfDay(ev.start, day);
      // Short events still need room for a line of text.
      const bottom = Math.max(minuteOfDay(ev.end, day), top + (MIN_BLOCK_PX / HOUR_PX) * 60);
      return { ev, top, bottom, col: 0, cols: 1 };
    })
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom);

  let cluster: Placed[] = [];
  let colEnds: number[] = [];
  let clusterEnd = -1;
  const close = (): void => {
    for (const p of cluster) p.cols = colEnds.length;
    cluster = [];
    colEnds = [];
  };
  for (const p of items) {
    if (p.top >= clusterEnd) close();
    let col = colEnds.findIndex((end) => end <= p.top);
    if (col < 0) {
      col = colEnds.length;
      colEnds.push(p.bottom);
    } else {
      colEnds[col] = p.bottom;
    }
    p.col = col;
    cluster.push(p);
    clusterEnd = Math.max(clusterEnd, p.bottom);
  }
  close();
  return items;
}

export function createDayView(openSettings: () => void): DayView {
  let cache: CalendarCache | null = null;
  let day = startOfDay(new Date());

  const title = h('span', { class: 'cal-date' });
  const prev = h('button', { class: 'todo-nav', title: 'Previous day', 'aria-label': 'Previous day', onClick: () => go(-1) }, '‹');
  const next = h('button', { class: 'todo-nav', title: 'Next day', 'aria-label': 'Next day', onClick: () => go(1) }, '›');
  const todayBtn = h('button', { class: 'cal-today', onClick: () => go(0) }, 'Today');
  const head = h('div', { class: 'cal-head' }, title, h('div', { class: 'cal-nav' }, prev, todayBtn, next));

  const allDay = h('div', { class: 'cal-allday' });
  const events = h('div', { class: 'cal-events' });
  const nowLine = h('div', { class: 'cal-now' });
  const hours = h('div', { class: 'cal-hours' });
  for (let hr = 0; hr < 24; hr++) {
    hours.appendChild(h('div', { class: 'cal-hour', style: { top: `${hr * HOUR_PX}px` } }, h('span', {}, hourLabel(hr))));
  }
  const grid = h('div', { class: 'cal-grid', style: { height: `${24 * HOUR_PX}px` } }, hours, events, nowLine);
  const scroller = h('div', { class: 'cal-scroll' }, grid);
  const note = h('div', { class: 'cal-note' });
  const el = h('div', { class: 'cal' }, head, allDay, scroller, note);
  let lastScroll = -1; // -1 = never positioned → first attach scrolls to default
  scroller.addEventListener('scroll', () => {
    if (scroller.isConnected) lastScroll = scroller.scrollTop;
  });

  function go(dir: -1 | 0 | 1): void {
    day = dir === 0 ? startOfDay(new Date()) : addDays(day, dir);
    shownToday = sameDay(day, new Date());
    render();
    scrollToDefault();
  }

  function placeNow(): void {
    const now = new Date();
    const show = sameDay(now, day);
    nowLine.hidden = !show;
    if (show) nowLine.style.top = `${((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_PX}px`;
  }

  function eventBlock(p: Placed): HTMLElement {
    const { ev } = p;
    const height = ((p.bottom - p.top) / 60) * HOUR_PX;
    const width = 100 / p.cols;
    const block = h(
      'a',
      {
        class: `cal-ev c${ev.cal % 6}${ev.end <= Date.now() ? ' past' : ''}`,
        href: ev.link,
        target: '_blank',
        rel: 'noopener noreferrer',
        title: `${ev.title}\n${timeLabel(ev.start)} – ${timeLabel(ev.end)}${ev.location ? `\n${ev.location}` : ''}`,
        style: {
          top: `${(p.top / 60) * HOUR_PX}px`,
          height: `${height - 2}px`,
          left: `${p.col * width}%`,
          width: `calc(${width}% - 2px)`,
        },
      },
      h('span', { class: 'cal-ev-title' }, ev.title),
    );
    // Room for a second line → show the time (and place, if it fits).
    if (height >= 34) {
      const meta = `${timeLabel(ev.start)} – ${timeLabel(ev.end)}${ev.location && height >= 50 ? ` · ${ev.location}` : ''}`;
      block.appendChild(h('span', { class: 'cal-ev-meta' }, meta));
    }
    return block;
  }

  function render(): void {
    const isToday = sameDay(day, new Date());
    title.textContent = dayLabel(day);
    todayBtn.disabled = isToday;
    placeNow();

    if (!cache) {
      allDay.replaceChildren();
      events.replaceChildren();
      note.replaceChildren(
        'Not synced yet. ',
        h('button', { class: 'cal-link', onClick: openSettings }, 'Open calendar settings'),
      );
      return;
    }

    const dayStart = day.getTime();
    const dayEnd = addDays(day, 1).getTime();
    const outside = dayEnd <= cache.from || dayStart >= cache.to;
    const todays = cache.events.filter((e) => e.start < dayEnd && e.end > dayStart);

    allDay.replaceChildren(
      ...todays
        .filter((e) => e.allDay)
        .map((e) =>
          h(
            'a',
            { class: `cal-allday-ev c${e.cal % 6}`, href: e.link, target: '_blank', rel: 'noopener noreferrer', title: e.title },
            e.title,
          ),
        ),
    );
    events.replaceChildren(...layoutDay(todays.filter((e) => !e.allDay), day).map(eventBlock));

    const lines: (string | Node)[] = [];
    if (!cache.syncedAt) {
      // Never loaded for these links: say why instead of an empty "Nothing scheduled".
      note.replaceChildren(h('span', { class: 'cal-err' }, `Couldn't load calendar. ${cache.error ?? ''}`));
      return;
    }
    if (outside) lines.push('Outside the synced range. ');
    else if (!todays.length) lines.push('Nothing scheduled. ');
    if (cache.error) lines.push(h('span', { class: 'cal-err', title: cache.error }, `Couldn't refresh — showing ${syncedAgo(cache.syncedAt)}. `));
    note.replaceChildren(...lines);
  }

  function scrollToDefault(): void {
    const now = new Date();
    let minute: number;
    if (sameDay(now, day)) {
      minute = now.getHours() * 60 + now.getMinutes() - 90; // a bit of the past for context
    } else {
      const first = cache?.events.find((e) => !e.allDay && e.start >= day.getTime() && e.start < day.getTime() + DAY_MS);
      minute = first ? minuteOfDay(first.start, day) - 30 : 8 * 60;
    }
    scroller.scrollTop = Math.max(0, (minute / 60) * HOUR_PX);
    lastScroll = scroller.scrollTop;
  }

  // Keep the now-line moving, the "past" fade current, and follow midnight
  // when the user is sitting on today.
  let shownToday = sameDay(day, new Date());
  const tick = setInterval(() => {
    const today = startOfDay(new Date());
    if (shownToday && !sameDay(day, today)) day = today;
    shownToday = sameDay(day, today);
    render();
  }, 60_000);

  render();
  return {
    el,
    setCache(c) {
      cache = c;
      render();
    },
    attached(reset) {
      if (reset || lastScroll < 0) scrollToDefault();
      else scroller.scrollTop = lastScroll;
    },
    destroy() {
      clearInterval(tick);
    },
  };
}
