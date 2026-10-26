// Fetch the user's iCal feeds, expand them into a day-indexable cache, and
// store it. Shared by the service worker (15-minute alarm) and the new tab
// (refresh when stale / settings change). No DOM.
import { storage } from '../../core/storage';
import { parseIcs } from './ics';
import type { CalendarCache, CalEvent } from './types';

export const CAL_KEY = 'calendarCache';
export const STALE_MS = 15 * 60_000;

// Window kept expanded: arrows past it show "not synced".
const PAST_DAYS = 60;
const FUTURE_DAYS = 180;
const DAY = 86_400_000;

// Requested at runtime (optional_host_permissions) so existing installs don't
// get a new permission warning on update.
const ORIGINS = ['https://calendar.google.com/*'];
const hasPermissionsApi = typeof chrome !== 'undefined' && !!chrome.permissions;

export function hasCalendarAccess(): Promise<boolean> {
  return hasPermissionsApi ? chrome.permissions.contains({ origins: ORIGINS }) : Promise.resolve(true);
}

// Must run inside a user gesture (a click), or Chrome rejects the prompt.
export function requestCalendarAccess(): Promise<boolean> {
  return hasPermissionsApi ? chrome.permissions.request({ origins: ORIGINS }) : Promise.resolve(true);
}

// webcal:// is how calendar apps advertise feeds; it's plain https underneath.
export function normalizeFeedUrl(raw: string): string {
  return raw.trim().replace(/^webcal:\/\//i, 'https://');
}

export function feedUrls(raw: string[] | undefined): string[] {
  return (raw ?? []).map(normalizeFeedUrl).filter(Boolean);
}

export const sourcesSig = (urls: string[]): string => urls.join('\n');

export function loadCalendarCache(): Promise<CalendarCache | null> {
  return storage.get<CalendarCache | null>(CAL_KEY, null);
}

function startOfDay(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

async function fetchFeed(url: string): Promise<string> {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error('Not a valid link.');
  }
  if (host !== 'calendar.google.com') throw new Error('Only Google Calendar iCal links are supported.');
  // `vite dev` runs as a plain web page, where Google's missing CORS headers
  // block the fetch; vite.config.ts proxies /gcal to calendar.google.com instead.
  const target = import.meta.env.DEV ? url.replace('https://calendar.google.com', '/gcal') : url;
  const res = await fetch(target, { credentials: 'omit', signal: AbortSignal.timeout(15_000) }).catch(() => {
    throw new Error("Couldn't reach Google Calendar.");
  });
  if (!res.ok) throw new Error(res.status === 404 ? 'Link not found — was it reset?' : `HTTP ${res.status}`);
  const text = await res.text();
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error("That link didn't return a calendar.");
  return text;
}

// Fetch + expand every feed and write the cache. A feed that fails keeps its
// events from the previous cache (when the URL list is unchanged), so a flaky
// network never blanks the day view. Resolves to the stored cache.
export async function syncCalendars(rawUrls: string[]): Promise<CalendarCache> {
  const urls = feedUrls(rawUrls);
  const prev = await loadCalendarCache();
  const sig = sourcesSig(urls);
  const now = Date.now();
  const from = startOfDay(now) - PAST_DAYS * DAY;
  const to = startOfDay(now) + FUTURE_DAYS * DAY;

  const names: string[] = [];
  const events: CalEvent[] = [];
  const errors: string[] = [];
  const sameSources = prev?.sources === sig;

  await Promise.all(
    urls.map(async (url, i) => {
      try {
        const parsed = parseIcs(await fetchFeed(url), url, i, from, to);
        names[i] = parsed.name;
        events.push(...parsed.events);
      } catch (err) {
        errors.push(`Calendar ${i + 1}: ${err instanceof Error ? err.message : 'failed'}`);
        names[i] = sameSources ? (prev?.names[i] ?? '') : '';
        if (sameSources && prev) events.push(...prev.events.filter((e) => e.cal === i));
      }
    }),
  );

  // Every feed failing isn't a sync: keep the old timestamp so "updated …" stays
  // honest, or 0 when there's no earlier data for these links at all.
  const allFailed = urls.length > 0 && errors.length === urls.length;
  const keepPrev = allFailed && sameSources && prev;
  const cache: CalendarCache = {
    syncedAt: keepPrev ? prev.syncedAt : allFailed ? 0 : now,
    sources: sig,
    from: keepPrev ? prev.from : from,
    to: keepPrev ? prev.to : to,
    names,
    events: events.sort((a, b) => a.start - b.start),
    error: errors.length ? errors.join(' · ') : undefined,
  };
  await storage.set(CAL_KEY, cache);
  return cache;
}

// Human "how fresh is it" line for the settings status + day view footer.
export function syncedAgo(t: number): string {
  const min = Math.round((Date.now() - t) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} h ago`;
  return `${Math.round(hr / 24)} d ago`;
}
