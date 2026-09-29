import './wallpaper.css';
import type { DashboardModule, ModuleContext, SettingsField } from '../../core/types';
import { h } from '../../core/dom';
import { registerFileHandler } from '../../ui/settingsPanel';
import { fileToDataUrl } from './image';
import {
  ALBUM_KEY,
  formatTaken,
  hasAlbumAccess,
  photoForSlot,
  requestAlbumAccess,
  sizedUrl,
  syncAlbum,
  type AlbumCache,
  type AlbumPhoto,
} from './album';

const STORAGE_KEY = 'wallpaperImage';
// Album rotation offset: bumped once per new tab in 'tab' mode, and by the
// caption's "next" button in every mode.
const NUDGE_KEY = 'wallpaperAlbumNudge';
const RESYNC_MS = 6 * 60 * 60_000; // re-fetch the album list when older than this
const DAY = 86_400_000;

let ctx: ModuleContext;
let layer: HTMLElement;
let overlay: HTMLElement;
let caption: HTMLElement;
let pending = ''; // src of the image currently loading; stale loads are dropped
let album: AlbumCache | null = null;
let current: AlbumPhoto | null = null; // album photo on screen
let nudge = 0;
let albumTimer: ReturnType<typeof setTimeout> | undefined;
let syncing: Promise<string> | null = null;

// Swap in `src` once it has loaded; a failed load leaves the color in place.
function setImage(src: string, onShown?: () => void): void {
  if (!src) return;
  pending = src;
  const img = new Image();
  img.onload = () => {
    if (src !== pending) return;
    layer.style.backgroundImage = `url("${src}")`;
    overlay.style.background = `rgb(0 0 0 / ${ctx.settings.wallpaper.dim})`;
    onShown?.();
  };
  img.src = src;
}

// Paints the solid color instantly, then (for url/upload/album) swaps in the
// image once it loads.
function paint(): void {
  const w = ctx.settings.wallpaper;
  clearTimeout(albumTimer);
  pending = '';
  layer.style.backgroundColor = w.color;
  layer.style.backgroundImage = '';
  overlay.style.background = 'transparent';
  current = null;
  renderCaption();

  if (w.mode === 'url') {
    setImage(w.url);
  } else if (w.mode === 'album') {
    showAlbum();
  } else if (w.mode === 'upload') {
    // read the stored data URL asynchronously (never blocks first paint)
    ctx.storage.get<string>(STORAGE_KEY, '').then((src) => setImage(src));
  }
}

// ---- album ----

function localDayNumber(): number {
  const offset = new Date().getTimezoneOffset() * 60_000;
  return Math.floor((Date.now() - offset) / DAY);
}

function intervalMs(): number {
  const m = ctx.settings.wallpaper.albumIntervalMinutes;
  return (m > 0 ? m : 60) * 60_000;
}

function albumSlot(): number {
  const r = ctx.settings.wallpaper.albumRotation;
  const base =
    r === 'interval'
      ? Math.floor(Date.now() / intervalMs())
      : r === 'daily'
        ? localDayNumber()
        : r === 'weekly'
          ? Math.floor((localDayNumber() + 3) / 7) // weeks start Monday (epoch day 0 was a Thursday)
          : 0;
  return base + nudge;
}

// Time until the rotation's next slot starts, or null when it only changes per tab.
function msUntilNextSlot(): number | null {
  const r = ctx.settings.wallpaper.albumRotation;
  if (r === 'interval') return intervalMs() - (Date.now() % intervalMs());
  if (r === 'daily' || r === 'weekly') {
    const midnight = new Date();
    midnight.setHours(24, 0, 0, 0);
    return midnight.getTime() - Date.now();
  }
  return null;
}

function albumPhotos(): AlbumPhoto[] {
  const src = ctx.settings.wallpaper.albumUrl.trim();
  return album && album.source === src ? album.photos : [];
}

function showAlbum(): void {
  clearTimeout(albumTimer);
  const photos = albumPhotos();
  const p = photoForSlot(photos, albumSlot());
  if (p && current?.url === p.url) {
    // Already on screen (e.g. a sync just refreshed the list) — only the
    // caption may have changed.
    current = p;
    renderCaption();
  } else if (p) {
    setImage(sizedUrl(p), () => {
      current = p;
      renderCaption();
    });
  }
  const wait = msUntilNextSlot();
  // setTimeout overflows past ~24.8 days (fires at once) — cap and re-check.
  if (wait !== null && photos.length > 1) albumTimer = setTimeout(showAlbum, Math.min(wait + 500, 2 ** 31 - 1));
}

function nextPhoto(): void {
  nudge++;
  ctx.storage.set(NUDGE_KEY, nudge);
  showAlbum();
}

// Date + description of the album photo on screen, bottom-right. Hidden when
// there's no album photo, or the pins wall covers the wallpaper.
function renderCaption(): void {
  const w = ctx.settings.wallpaper;
  const p = current;
  caption.hidden = !p || w.mode !== 'album' || ctx.settings.pins.enabled;
  if (caption.hidden || !p) return;

  const date = w.captionDate ? formatTaken(p) : '';
  const desc = w.captionDesc ? (p.desc ?? '') : '';
  const next =
    albumPhotos().length > 1
      ? h('button', { class: 'wp-caption-next', title: 'Next photo', 'aria-label': 'Next photo', onClick: nextPhoto }, '›')
      : null;
  caption.replaceChildren(
    ...(desc ? [h('p', { class: 'wp-caption-desc' + (w.captionFull ? ' full' : '') }, desc)] : []),
    h('div', { class: 'wp-caption-row' }, next, date ? h('span', { class: 'wp-caption-date' }, date) : null),
  );
}

function runSync(): Promise<string> {
  const src = ctx.settings.wallpaper.albumUrl.trim();
  if (!src) return Promise.reject(new Error('Paste a shared album link first.'));
  // One sync at a time; a second click just waits on the running one.
  syncing ??= syncAlbum(src, album, async (c) => {
    album = c;
    await ctx.storage.set(ALBUM_KEY, c);
    if (layer && ctx.settings.wallpaper.mode === 'album') showAlbum();
  })
    .then((c) => `Synced ${c.photos.length} photo${c.photos.length === 1 ? '' : 's'}.`)
    .finally(() => {
      syncing = null;
    });
  return syncing;
}

// Background refresh on load / link change. Only runs once the user has
// granted access via "Sync now" (the permission prompt needs a click).
function maybeAutoSync(): void {
  const w = ctx.settings.wallpaper;
  const src = w.albumUrl.trim();
  if (w.mode !== 'album' || !src) return;
  if (album && album.source === src && Date.now() - album.syncedAt < RESYNC_MS) return;
  hasAlbumAccess().then((ok) => {
    if (ok) runSync().catch((err) => console.warn('[wallpaper] album sync failed', err));
  });
}

async function syncStatus(): Promise<string> {
  const photos = albumPhotos();
  if (!album || !photos.length) return 'Not synced yet.';
  const when = new Date(album.syncedAt).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${photos.length} photo${photos.length === 1 ? '' : 's'} · last synced ${when}. Re-syncs automatically every few hours.`;
}

const isAlbum = (s: { wallpaper: { mode: string } }) => s.wallpaper.mode === 'album';

const schema: SettingsField[] = [
  {
    key: 'wallpaper.mode',
    label: 'Background',
    type: 'select',
    options: [
      { value: 'color', label: 'Solid color' },
      { value: 'url', label: 'Image URL' },
      { value: 'upload', label: 'Uploaded image' },
      { value: 'album', label: 'Google Photos album' },
    ],
  },
  { key: 'wallpaper.color', label: 'Color', type: 'color' },
  { key: 'wallpaper.url', label: 'Image URL', type: 'text', placeholder: 'https://…' },
  {
    key: 'wallpaper.albumUrl',
    label: 'Shared album link',
    type: 'text',
    placeholder: 'https://photos.app.goo.gl/…',
    help: 'In Google Photos: open an album → Share → Create link. Paste it here, then press Sync. Photos added to the album later show up on their own.',
    showIf: isAlbum,
  },
  {
    key: 'wallpaper.albumSync',
    label: 'Sync now',
    type: 'action',
    run: async () => {
      // Ask first, synchronously inside the click, or Chrome drops the prompt.
      if (!(await requestAlbumAccess())) throw new Error('Needs permission to read Google Photos.');
      return runSync();
    },
    status: syncStatus,
    showIf: isAlbum,
  },
  {
    key: 'wallpaper.albumRotation',
    label: 'Change photo',
    type: 'select',
    options: [
      { value: 'tab', label: 'Every new tab' },
      { value: 'interval', label: 'Every N minutes' },
      { value: 'daily', label: 'Daily' },
      { value: 'weekly', label: 'Weekly' },
    ],
    help: 'Shuffled — every photo shows once before any repeats.',
    showIf: isAlbum,
  },
  {
    key: 'wallpaper.albumIntervalMinutes',
    label: 'Minutes between photos',
    type: 'number',
    min: 1,
    step: 1,
    showIf: (s) => isAlbum(s) && s.wallpaper.albumRotation === 'interval',
  },
  { key: 'wallpaper.captionDate', label: 'Show date taken', type: 'toggle', showIf: isAlbum },
  { key: 'wallpaper.captionDesc', label: 'Show description', type: 'toggle', showIf: isAlbum },
  {
    key: 'wallpaper.captionFull',
    label: 'Show full description',
    type: 'toggle',
    help: 'Off: long descriptions show 3 lines and expand on hover.',
    showIf: (s) => isAlbum(s) && s.wallpaper.captionDesc,
  },
  { key: 'wallpaper.dim', label: 'Dim overlay', type: 'range', min: 0, max: 0.8, step: 0.05 },
  {
    key: 'wallpaper.image',
    label: 'Upload image',
    type: 'file',
    help: 'JPEG/PNG ≤ 10 MB. Downscaled to 2560px and stored locally.',
  },
];

export const wallpaper: DashboardModule = {
  id: 'wallpaper',
  slot: 'background',
  order: 0,
  settingsSchema: schema,

  async init(c) {
    ctx = c;
    album = await ctx.storage.get<AlbumCache | null>(ALBUM_KEY, null);
    nudge = await ctx.storage.get<number>(NUDGE_KEY, 0);
    const w = ctx.settings.wallpaper;
    if (w.mode === 'album' && w.albumRotation === 'tab') {
      nudge++;
      ctx.storage.set(NUDGE_KEY, nudge);
    }
    maybeAutoSync();

    registerFileHandler('wallpaper.image', async (file) => {
      const dataUrl = await fileToDataUrl(file);
      await ctx.storage.set(STORAGE_KEY, dataUrl);
      await ctx.saveSettings({ wallpaper: { mode: 'upload' } });
      // A second upload leaves settings.wallpaper unchanged (already 'upload'),
      // so the gate below skips it — repaint for the new image explicitly.
      if (layer) paint();
    });
    // Repaint only when the wallpaper settings changed. paint() starts from the
    // bare colour and fades the image back in once it loads, so running it on
    // every unrelated save (e.g. minimizing the clock) flashed the colour.
    let last = JSON.stringify(ctx.settings.wallpaper);
    ctx.bus.on('settings-changed', () => {
      const key = JSON.stringify(ctx.settings.wallpaper);
      if (key === last) {
        if (caption) renderCaption(); // e.g. the pins wall was toggled
        return;
      }
      last = key;
      if (layer) paint();
      maybeAutoSync();
    });
  },

  render(el) {
    layer = h('div', { class: 'wallpaper-layer' });
    overlay = h('div', { class: 'wallpaper-dim' });
    Object.assign(layer.style, {
      position: 'absolute',
      inset: '0',
      backgroundSize: 'cover',
      backgroundPosition: 'center',
    });
    Object.assign(overlay.style, { position: 'absolute', inset: '0' });
    el.append(layer, overlay);
    // The background slot sits under the dashboard; the caption goes in the
    // overlay slot so it stays readable and its "next" button clickable.
    caption = h('div', { class: 'wp-caption', hidden: true });
    (document.querySelector('.slot-overlay') ?? el).appendChild(caption);
    paint();
  },
};
