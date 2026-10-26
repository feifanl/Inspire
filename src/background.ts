// Service worker: right-click any web image → "Add image to pins board".
// Menus are rebuilt from the saved boards so the submenu always matches the
// user's current boards. Clicking appends the image URL to the chosen board;
// the open new-tab picks it up via chrome.storage.onChanged.
import { DEFAULT_SETTINGS, type PinBoard, type Settings } from './core/types';
import { feedUrls, hasCalendarAccess, syncCalendars } from './modules/calendar/sync';

const PARENT = 'add-to-pins';
const NEW_BOARD = 'pin-board:__new__';
const BOARD_PREFIX = 'pin-board:';

async function getSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get('settings');
  return (settings as Settings) ?? DEFAULT_SETTINGS;
}

async function buildMenus(): Promise<void> {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: PARENT, title: 'Add image to pins board', contexts: ['image'] });

  const boards = (await getSettings()).pins?.boards ?? [];
  for (const b of boards) {
    chrome.contextMenus.create({
      id: BOARD_PREFIX + b.id,
      parentId: PARENT,
      title: b.name || 'Untitled board',
      contexts: ['image'],
    });
  }
  if (boards.length) {
    chrome.contextMenus.create({ id: 'pin-sep', parentId: PARENT, type: 'separator', contexts: ['image'] });
  }
  chrome.contextMenus.create({ id: NEW_BOARD, parentId: PARENT, title: '＋ New board…', contexts: ['image'] });
}

chrome.runtime.onInstalled.addListener(buildMenus);
// Fresh installs get the guided tour on their first new tab (modules/tour);
// updates don't, so existing users aren't walked through what they know.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.storage.local.set({ tourPending: true });
});
chrome.runtime.onStartup.addListener(buildMenus);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) buildMenus();
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  const id = String(info.menuItemId);
  if (!info.srcUrl || (id !== NEW_BOARD && !id.startsWith(BOARD_PREFIX))) return;

  const s = await getSettings();
  const boards = (s.pins.boards ?? []).map((b) => ({ ...b }));

  let boardId: string;
  if (id === NEW_BOARD) {
    // Each "New board" makes a fresh board with the next free "Saved (N)" name.
    const taken = new Set(boards.map((b) => b.name.trim().toLowerCase()));
    let n = 1;
    while (taken.has(`saved (${n})`)) n++;
    boardId = crypto.randomUUID();
    const board: PinBoard = { id: boardId, name: `Saved (${n})`, pins: [], rotation: 'off', index: 0 };
    boards.push(board);
  } else {
    boardId = id.slice(BOARD_PREFIX.length);
  }

  const idx = boards.findIndex((b) => b.id === boardId);
  if (idx < 0) return;
  const board = boards[idx];
  // Skip exact-duplicate URLs; keep the source page as the click-through link.
  if (!board.pins.some((p) => p.imageUrl === info.srcUrl)) {
    board.pins = [...board.pins, { imageUrl: info.srcUrl, linkUrl: info.pageUrl || info.srcUrl }];
  }

  const next: Settings = {
    ...s,
    pins: { ...s.pins, boards, enabled: true, activeBoardId: s.pins.activeBoardId ?? boardId },
  };
  await chrome.storage.local.set({ settings: next });
});

// Calendar: refresh the iCal cache every 15 minutes so a new tab always opens
// on recent events without fetching anything itself (modules/calendar).
const CAL_ALARM = 'calendar-sync';

async function syncCalendarIfOn(): Promise<void> {
  const urls = feedUrls((await getSettings()).calendar?.urls);
  if (!urls.length || !(await hasCalendarAccess())) return;
  await syncCalendars(urls).catch(() => undefined);
}

function ensureCalendarAlarm(): void {
  chrome.alarms.get(CAL_ALARM, (a) => {
    if (!a) chrome.alarms.create(CAL_ALARM, { periodInMinutes: 15 });
  });
}

chrome.runtime.onInstalled.addListener(ensureCalendarAlarm);
chrome.runtime.onStartup.addListener(() => {
  ensureCalendarAlarm();
  syncCalendarIfOn();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === CAL_ALARM) syncCalendarIfOn();
});
