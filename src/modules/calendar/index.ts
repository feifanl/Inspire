// Google Calendar day view, shown as a Today tab in the todo sidebar.
// This module owns the settings, the cache, and when to refresh it; the todo
// module only mounts calendarDayView().el. Nothing renders on its own.
import './calendar.css';
import type { DashboardModule, ModuleContext, Settings } from '../../core/types';
import { createDayView, type DayView } from './dayview';
import {
  CAL_KEY,
  STALE_MS,
  feedUrls,
  hasCalendarAccess,
  loadCalendarCache,
  requestCalendarAccess,
  sourcesSig,
  syncCalendars,
  syncedAgo,
} from './sync';
import type { CalendarCache } from './types';

let ctx: ModuleContext;
let view: DayView | null = null;
let cache: CalendarCache | null = null;
let syncing: Promise<CalendarCache> | null = null;

export function calendarOn(s: Settings): boolean {
  return feedUrls(s.calendar?.urls).length > 0;
}

// Lazily built so tabs that never show the calendar don't pay for it.
export function calendarDayView(): DayView {
  if (!view) {
    view = createDayView(() => ctx.bus.emit('open-settings', 'calendar'));
    view.setCache(usableCache());
  }
  return view;
}

// A cache built from a different URL list (user edited settings) is stale data
// for the wrong calendars — hide it until the new sync lands.
function usableCache(): CalendarCache | null {
  if (!cache || !ctx) return null;
  return cache.sources === sourcesSig(feedUrls(ctx.settings.calendar.urls)) ? cache : null;
}

function setCache(c: CalendarCache | null): void {
  cache = c;
  view?.setCache(usableCache());
}

// One sync at a time per tab; the service worker may run its own in parallel,
// which is harmless (both write the same result).
function sync(): Promise<CalendarCache> {
  if (!syncing) {
    syncing = syncCalendars(ctx.settings.calendar.urls)
      .then((c) => {
        setCache(c);
        return c;
      })
      .finally(() => (syncing = null));
  }
  return syncing;
}

// Background refresh without a prompt: only when access was already granted.
async function refreshIfStale(): Promise<void> {
  if (!calendarOn(ctx.settings)) return;
  const fresh = usableCache() && Date.now() - cache!.syncedAt < STALE_MS;
  if (fresh || !(await hasCalendarAccess())) return;
  sync().catch(() => undefined);
}

async function syncStatus(): Promise<string> {
  if (!calendarOn(ctx.settings)) return 'Paste a link above, then press Sync.';
  if (!(await hasCalendarAccess())) return 'Press Sync to allow access to Google Calendar.';
  const c = usableCache();
  if (!c) return 'Not synced yet.';
  if (!c.syncedAt) return `Couldn't load: ${c.error ?? 'unknown error'}`;
  const n = c.names.filter(Boolean).join(', ') || `${c.names.length} calendar${c.names.length === 1 ? '' : 's'}`;
  return `${n} · updated ${syncedAgo(c.syncedAt)}${c.error ? ` · ${c.error}` : ''}`;
}

const parseLines = (raw: string): string[] =>
  raw
    .split(/\s+/)
    .map((l) => l.trim())
    .filter(Boolean);

let unsub: (() => void) | undefined;
let lastSig = '';
let onStorage: ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void) | undefined;

export const calendar: DashboardModule = {
  id: 'calendar',
  slot: 'overlay',
  order: 9, // before todo (10), so the cache is loaded when the sidebar first builds
  settingsSchema: [
    {
      key: 'calendar.urls',
      label: 'Google Calendar iCal links',
      type: 'textarea',
      placeholder: 'https://calendar.google.com/calendar/ical/…/private-…/basic.ics',
      parse: parseLines,
      format: (v) => ((v as string[]) ?? []).join('\n'),
      help:
        'In Google Calendar: Settings → pick a calendar → Integrate calendar → copy "Secret address in iCal format". One link per line. Adds a Today tab next to your tasks. The secret link is a password to your calendar: it stays in this browser only.',
    },
    {
      key: 'calendar.sync',
      label: 'Sync now',
      type: 'action',
      run: async () => {
        // Ask first, synchronously inside the click, or Chrome drops the prompt.
        if (!(await requestCalendarAccess())) throw new Error('Needs permission to read Google Calendar.');
        if (!calendarOn(ctx.settings)) throw new Error('Paste a calendar link first.');
        await sync();
        return syncStatus();
      },
      status: syncStatus,
    },
  ],

  async init(c) {
    ctx = c;
    cache = await loadCalendarCache();
    lastSig = sourcesSig(feedUrls(c.settings.calendar.urls));
    // Edited links → drop the old calendars' events and fetch the new ones.
    unsub = c.bus.on('settings-changed', () => {
      const sig = sourcesSig(feedUrls(ctx.settings.calendar.urls));
      if (sig === lastSig) return;
      lastSig = sig;
      setCache(cache);
      refreshIfStale();
    });
    // The service worker's alarm sync (or another tab) wrote a fresh cache.
    onStorage = (changes, area) => {
      if (area === 'local' && changes[CAL_KEY]) setCache((changes[CAL_KEY].newValue as CalendarCache) ?? null);
    };
    chrome.storage?.onChanged?.addListener(onStorage);
  },

  render() {
    // Refresh after first paint; never blocks the tab.
    setTimeout(() => refreshIfStale(), 0);
  },

  destroy() {
    unsub?.();
    if (onStorage) chrome.storage?.onChanged?.removeListener(onStorage);
    view?.destroy();
  },
};
