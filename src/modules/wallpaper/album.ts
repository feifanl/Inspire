// Google Photos shared-album source. Google's Library API lost read access to
// user albums in 2025, so this reads what the public share page itself uses:
// the photo list is embedded in the page as an AF_initDataCallback JSON blob,
// and each photo's description comes from the same batchexecute RPC ("fDcn4b")
// the page's info panel calls. Both are undocumented — everything is parsed
// defensively, and a failed sync keeps the last good cache.

export interface AlbumPhoto {
  id: string;
  url: string; // lh3 base URL; append =w…-h… for a sized rendition
  w: number;
  h: number;
  taken: number; // epoch ms (UTC)
  tz: number; // UTC offset in ms where it was taken (e.g. -14400000 = GMT-4)
  desc?: string; // undefined = not fetched yet; '' = none
}

export interface AlbumCache {
  source: string; // the share link this was synced from
  syncedAt: number; // epoch ms
  photos: AlbumPhoto[];
}

export const ALBUM_KEY = 'wallpaperAlbum';

// Requested at runtime (optional_host_permissions) so existing installs don't
// get a new permission warning on update. goo.gl redirects to photos.google.com.
const ORIGINS = ['https://photos.app.goo.gl/*', 'https://photos.google.com/*'];
const RPC_URL = 'https://photos.google.com/_/PhotosUi/data/batchexecute';
const MAX_PAGES = 50;
const DESC_CONCURRENCY = 3;

const hasPermissionsApi = typeof chrome !== 'undefined' && !!chrome.permissions;

export function hasAlbumAccess(): Promise<boolean> {
  return hasPermissionsApi ? chrome.permissions.contains({ origins: ORIGINS }) : Promise.resolve(true);
}

// Must run inside a user gesture (a click), or Chrome rejects the prompt.
export function requestAlbumAccess(): Promise<boolean> {
  return hasPermissionsApi ? chrome.permissions.request({ origins: ORIGINS }) : Promise.resolve(true);
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// One entry of the album list: [id, [url, w, h, …], taken, dedupKey, tz, …].
function toPhoto(it: unknown): AlbumPhoto | null {
  if (!Array.isArray(it) || typeof it[0] !== 'string' || !Array.isArray(it[1])) return null;
  const [url, w, h] = it[1] as unknown[];
  if (typeof url !== 'string' || !url.startsWith('https://lh3.googleusercontent.com/')) return null;
  return { id: it[0], url, w: num(w), h: num(h), taken: num(it[2]), tz: num(it[4]) };
}

// A page of the album: [?, items[], nextPageToken, albumMeta, …].
function toPage(block: unknown): { photos: AlbumPhoto[]; token: string } | null {
  if (!Array.isArray(block) || !Array.isArray(block[1])) return null;
  const photos = (block[1] as unknown[]).map(toPhoto).filter((p): p is AlbumPhoto => p !== null);
  if (!photos.length) return null;
  return { photos, token: typeof block[2] === 'string' ? block[2] : '' };
}

function parseSharePage(html: string): { photos: AlbumPhoto[]; token: string } | null {
  const re = /AF_initDataCallback\(\{[^{]*?data:([\s\S]*?), sideChannel: \{\}\}\);/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    try {
      const page = toPage(JSON.parse(m[1]));
      if (page) return page;
    } catch {
      /* not JSON we understand — try the next blob */
    }
  }
  return null;
}

// batchexecute replies in chunks; the payload is a JSON string inside the
// ["wrb.fr", rpcid, "<json>", …] envelope line.
async function rpc(rpcid: string, args: unknown[]): Promise<unknown> {
  const body = new URLSearchParams({ 'f.req': JSON.stringify([[[rpcid, JSON.stringify(args), null, 'generic']]]) });
  const res = await fetch(`${RPC_URL}?rpcids=${rpcid}&rt=c`, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body,
  });
  if (!res.ok) throw new Error(`Google Photos request failed (${res.status}).`);
  for (const line of (await res.text()).split('\n')) {
    if (!line.startsWith('[["wrb.fr"')) continue;
    const payload = JSON.parse(line)[0]?.[2];
    return typeof payload === 'string' ? JSON.parse(payload) : null;
  }
  return null;
}

async function fetchDescription(id: string, key: string): Promise<string> {
  const info = (await rpc('fDcn4b', [id, 1, key])) as unknown[][] | null;
  const desc = info?.[0]?.[1];
  return typeof desc === 'string' ? desc : '';
}

// Fetches the album list, then fills in descriptions for photos we haven't
// seen. `save` is called once the list is known and again as descriptions
// arrive, so a tab closed mid-sync still keeps what it got.
export async function syncAlbum(
  source: string,
  prev: AlbumCache | null,
  save: (cache: AlbumCache) => Promise<void>,
): Promise<AlbumCache> {
  const res = await fetch(source, { credentials: 'omit' }).catch(() => {
    throw new Error("Couldn't reach Google Photos — check the link and your connection.");
  });
  if (!res.ok) throw new Error(`Couldn't open the album (${res.status}).`);
  const final = new URL(res.url);
  const albumId = final.pathname.match(/\/share\/([^/]+)/)?.[1];
  const key = final.searchParams.get('key');
  if (!albumId || !key) throw new Error("That link isn't a shared Google Photos album.");

  const first = parseSharePage(await res.text());
  if (!first) throw new Error('No photos found — the album is empty or Google changed its page.');

  // Big albums arrive in pages; follow the continuation token.
  const photos = first.photos;
  let token = first.token;
  for (let i = 0; token && i < MAX_PAGES; i++) {
    let page: ReturnType<typeof toPage> = null;
    try {
      page = toPage(await rpc('snAcKc', [albumId, token, null, key]));
    } catch {
      /* keep the pages we have */
    }
    if (!page) break;
    photos.push(...page.photos);
    token = page.token;
  }

  // Carry over descriptions from the last sync of this album.
  const known = new Map((prev?.source === source ? prev.photos : []).map((p) => [p.id, p.desc]));
  for (const p of photos) p.desc = known.get(p.id);

  const cache: AlbumCache = { source, syncedAt: Date.now(), photos };
  await save(cache);

  const todo = photos.filter((p) => p.desc === undefined);
  const worker = async (): Promise<void> => {
    for (let p = todo.shift(); p; p = todo.shift()) {
      try {
        p.desc = await fetchDescription(p.id, key);
      } catch {
        /* left undefined — retried on the next sync */
      }
    }
  };
  if (todo.length) {
    await Promise.all(Array.from({ length: DESC_CONCURRENCY }, worker));
    await save(cache);
  }
  return cache;
}

// ---- rotation ----

// Seeded PRNG so every open tab computes the same shuffle for the same slot.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(arr: T[], seed: number): T[] {
  const out = arr.slice();
  const rand = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Slot N → photo. Slots are grouped into cycles of `photos.length`; each cycle
// is its own shuffle, so every photo shows once before any repeats, and a
// cycle never opens with the photo the previous one ended on.
export function photoForSlot(photos: AlbumPhoto[], slot: number): AlbumPhoto | null {
  const n = photos.length;
  if (!n) return null;
  const base = photos.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
  const cycle = Math.floor(slot / n);
  const order = shuffled(base, cycle);
  if (n > 1) {
    const prevLast = shuffled(base, cycle - 1)[n - 1];
    if (order[0] === prevLast) [order[0], order[1]] = [order[1], order[0]];
  }
  return order[slot - cycle * n];
}

// lh3 serves any size on request: ask for exactly enough pixels to cover the
// screen (background-size: cover), never more than the original.
export function sizedUrl(p: AlbumPhoto): string {
  const dpr = window.devicePixelRatio || 1;
  // screen size can read 0 in a hidden/background page — fall back to 1080p
  const sw = (screen.width || 1920) * dpr;
  const sh = (screen.height || 1080) * dpr;
  if (!p.w || !p.h) return `${p.url}=s${Math.ceil(Math.max(sw, sh))}`;
  const s = Math.min(1, Math.max(sw / p.w, sh / p.h));
  return `${p.url}=w${Math.ceil(p.w * s)}-h${Math.ceil(p.h * s)}`;
}

// Date the photo was taken, in the local time of where it was taken.
export function formatTaken(p: AlbumPhoto): string {
  if (!p.taken) return '';
  return new Date(p.taken + p.tz).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
