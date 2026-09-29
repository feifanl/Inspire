// Single source of truth for types. No logic.

// ---------- Utility ----------
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

// ---------- Storage ----------
export interface TypedStorage {
  get<T>(key: string, fallback: T): Promise<T>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}

// ---------- Event bus ----------
export type BusEvent = 'settings-changed' | 'open-settings' | 'open-notes-board' | 'start-tour';

export interface EventBus {
  on(event: BusEvent, cb: (payload?: unknown) => void): () => void;
  emit(event: BusEvent, payload?: unknown): void;
}

// ---------- Module contract ----------
export type Slot = 'background' | 'main' | 'sidebar' | 'corner' | 'overlay';

export interface ModuleContext {
  settings: Settings; // live snapshot
  saveSettings(patch: DeepPartial<Settings>): Promise<void>;
  storage: TypedStorage; // from core/storage.ts
  bus: EventBus; // from core/events.ts
}

export interface SettingsField {
  key: string; // dot-path inside Settings, e.g. "lifeclock.birthday"
  label: string;
  type: 'text' | 'date' | 'number' | 'range' | 'select' | 'toggle' | 'textarea' | 'file' | 'color' | 'list' | 'pins' | 'action';
  // for select: a static list, or a function computing options from live settings
  // (e.g. one option per pin board, so the list tracks the user's boards)
  options?: { value: string; label: string }[] | ((settings: Settings) => { value: string; label: string }[]);
  numeric?: boolean; // select: store the chosen option value as a number, not a string
  min?: number;
  max?: number; // for number
  step?: number; // for number
  placeholder?: string;
  help?: string;
  itemFields?: SettingsField[]; // for 'list': schema of one row; value is an array of objects
  itemLabel?: string; // for 'list': singular name for a row when it has no title yet (e.g. "Board")
  newItem?: () => Record<string, unknown>; // for 'list': factory for a new row (e.g. id/index defaults)
  parse?: (raw: string) => unknown; // textarea/text: string → stored value (e.g. lines → Pin[])
  format?: (val: unknown) => string; // textarea/text: stored value → string for display
  showIf?: (settings: Settings) => boolean; // hide field unless predicate holds
  run?: () => Promise<string>; // for 'action': button click handler; resolves to a status line
  status?: () => Promise<string>; // for 'action': status line shown before the first click
}

export interface DashboardModule {
  id: string; // unique, kebab-case
  slot: Slot;
  order: number; // mount order within slot (ascending)
  init(ctx: ModuleContext): void | Promise<void>; // MUST NOT await network
  render(el: HTMLElement): void; // synchronous DOM build
  destroy?(): void;
  settingsSchema: SettingsField[]; // [] if none
}

// ---------- Settings (single typed schema, root storage key "settings") ----------
export type LifeView = 'day' | 'week' | 'month' | 'year' | 'decade' | 'life';
export type SearchEngine = 'google' | 'duckduckgo' | 'brave' | 'bing';
// Placements the layout editor can drop a panel into.
export type QuotePos = 'top' | 'center' | 'bottom';
export type SideLR = 'left' | 'right';
// Panels the layout editor can drag freely and scale.
export type PanelId = 'quote' | 'todo' | 'search' | 'lifeclock';
// 'tab' = a new photo on every new tab.
export type AlbumRotation = 'tab' | 'interval' | 'daily' | 'weekly';
// A panel's free placement. x/y are its anchor point as % of the screen (see
// ANCHOR in modules/layout); both null = sits in its normal dock. scale is a
// uniform zoom factor, 1 = default size.
export interface PanelPlace {
  x: number | null;
  y: number | null;
  scale: number;
}

export interface Settings {
  version: 1; // migration guard
  theme: 'dark' | 'light';
  lifeclock: {
    birthday: string | null; // "YYYY-MM-DD"
    lifeExpectancyYears: number; // default 80
    defaultView: LifeView; // default "month"
  };
  wallpaper: {
    mode: 'color' | 'url' | 'upload' | 'album';
    color: string; // default "#0d1117"
    url: string; // remote image URL, mode "url"
    dim: number; // 0–0.8 overlay dim, default 0.35
    albumUrl: string; // Google Photos shared-album link, mode "album"
    albumRotation: AlbumRotation; // how often the album photo changes
    albumIntervalMinutes: number; // used iff albumRotation === 'interval'
    captionDate: boolean; // album mode: show the date the photo was taken
    captionDesc: boolean; // album mode: show the photo's Google Photos description
    captionFull: boolean; // album mode: show the whole description, not clamped to 3 lines
  };
  todo: {
    trelloEnabled: boolean;
    trelloKey: string;
    trelloToken: string;
    trelloListId: string;
    trelloBoardId: string; // board scanned when auto-weekday is on
    trelloAutoWeekday: boolean; // pick the list whose name matches today's weekday
  };
  quote: {
    enabled: boolean;
    api: boolean; // fetch ZenQuotes online; false = bundled only
    categories: QuoteCategory[]; // filters the offline fallback pool; default all three
    custom: CustomQuote[]; // the user's own quotes, mixed into the offline pool
    customOnly: boolean; // show ONLY the user's quotes (no bundled pool, no API)
  };
  pins: {
    enabled: boolean;
    boards: PinBoard[]; // user-created, named boards (e.g. "hopecore", "grimy")
    mode: 'board' | 'all'; // 'board' = show one active board; 'all' = pool every pin across boards
    activeBoardId: string | null; // board mode: which board shows; null → boards[0]
    boardRotation: PinRotation; // board mode: auto-advance WHICH board is active ('off' = manual/keybind only)
    boardIntervalMinutes?: number; // used iff boardRotation === 'interval'
    allRotation: PinRotation; // all mode: how the pooled pins rotate
    allIntervalMinutes?: number; // used iff allRotation === 'interval'
    allIndex: number; // all mode: current pin in the pooled list (manual cursor)
    screenRotation: PinScreenRotation; // cycle which pins fill the wall when the pool overflows; 'scroll' = panorama
    screenIntervalMinutes?: number; // used iff screenRotation === 'interval'
    screenScrollSeconds?: number; // seconds between column slides, iff screenRotation === 'scroll'
    tileSize: number; // % of the default column width (100 = default); bigger → fewer, larger images
  };
  notes: {
    enabled: boolean;
  };
  layout: {
    quotePos: QuotePos; // where the quote dock sits ('center' = in the column, under the clock)
    todoSide: SideLR; // which edge the tasks sidebar is pinned to
    searchY: number | null; // legacy search height (%); migrated into panels.search on load
    panels: Record<PanelId, PanelPlace>; // free position + scale per panel
  };
  search: {
    enabled: boolean;
    engine: SearchEngine;
  };
  ui: {
    quoteOpen: boolean; // quote card pulled up from its bottom tab
    todoHidden: boolean; // todo sidebar collapsed to a handle
    clockMinimized: boolean; // life clock collapsed to a compact pill
    pinsBoardsOpen: boolean; // board switcher expanded from its top-right tab
    glass: boolean; // liquid-glass surfaces (false = flat opaque)
    hideCollapsed: boolean; // fade out the tab/handle a collapsed panel leaves behind
  };
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  theme: 'dark',
  lifeclock: { birthday: null, lifeExpectancyYears: 80, defaultView: 'month' },
  wallpaper: {
    mode: 'color',
    color: '#0d1117',
    url: '',
    dim: 0.35,
    albumUrl: '',
    albumRotation: 'tab',
    albumIntervalMinutes: 60,
    captionDate: true,
    captionDesc: true,
    captionFull: false,
  },
  todo: { trelloEnabled: false, trelloKey: '', trelloToken: '', trelloListId: '', trelloBoardId: '', trelloAutoWeekday: false },
  quote: {
    enabled: true,
    api: true,
    categories: ['philosophy', 'self-help', 'morality'],
    custom: [],
    customOnly: false,
  },
  pins: {
    enabled: false,
    boards: [],
    mode: 'board',
    activeBoardId: null,
    boardRotation: 'off',
    boardIntervalMinutes: 60,
    allRotation: 'daily',
    allIntervalMinutes: 60,
    allIndex: 0,
    screenRotation: 'off',
    screenIntervalMinutes: 5,
    screenScrollSeconds: 100,
    tileSize: 100,
  },
  notes: { enabled: true },
  layout: {
    quotePos: 'bottom',
    todoSide: 'left',
    searchY: null,
    // Every key spelled out: deepMerge only keeps keys the defaults have.
    panels: {
      quote: { x: null, y: null, scale: 1 },
      todo: { x: null, y: null, scale: 1 },
      search: { x: null, y: null, scale: 1 },
      lifeclock: { x: null, y: null, scale: 1 },
    },
  },
  search: { enabled: true, engine: 'google' },
  ui: { quoteOpen: false, todoHidden: false, clockMinimized: false, pinsBoardsOpen: false, glass: true, hideCollapsed: false },
};

// ---------- Todo (root storage key "todos") ----------
export type Priority = 'high' | 'med' | 'low';

export interface Todo {
  id: string; // crypto.randomUUID()
  text: string;
  done: boolean;
  priority: Priority; // default "med"
  createdAt: number; // epoch ms
  pos: number; // manual sort order (ascending); mirrors Trello's card pos when synced
  desc?: string; // free-text description (Trello-style)
  link?: string; // single URL, opened in a new tab
  trelloCardId?: string; // present iff synced
  dirty?: true; // text/desc/link edited locally, not yet confirmed pushed to Trello
}

export interface TodoState {
  items: Todo[];
  syncedListId?: string; // Trello list these items currently mirror; a change triggers a rewrite
}

// ---------- Quote (bundled quotes.json entries) ----------
export type QuoteCategory = 'philosophy' | 'self-help' | 'morality';

export interface Quote {
  text: string;
  author: string;
  category?: QuoteCategory; // absent for API-sourced quotes (ZenQuotes has no category)
  own?: true; // written by the user (settings.quote.custom), not bundled/fetched
}

// One row of the "my quotes" settings list. Author may be blank.
export interface CustomQuote {
  text: string;
  author: string;
}

// ---------- Pins ----------
export interface Pin {
  imageUrl: string;
  linkUrl?: string; // open on click; defaults to imageUrl
}

export type PinRotation = 'off' | 'daily' | 'interval';
// Screen rotation adds a 'scroll' panorama mode (slide one column at a time).
export type PinScreenRotation = PinRotation | 'scroll';

export interface PinBoard {
  id: string; // crypto.randomUUID()
  name: string;
  pins: Pin[];
  rotation: PinRotation; // 'off' = static/manual only
  intervalMinutes?: number; // used iff rotation === 'interval' (e.g. 60, 240)
  index: number; // current pin shown (also the manual cursor)
}

// ---------- Notes (root storage key "notes") ----------
export type NoteColor = 'green' | 'yellow' | 'blue' | 'red' | 'gray';

export interface StickyNote {
  id: string;
  text: string; // ≤ 500 chars
  color: NoteColor;
  createdAt: number;
  // Free-canvas position on the notes board, in px from the canvas top-left.
  // Absent on notes created before dragging existed — auto-placed on first open.
  x?: number;
  y?: number;
  // Hand-resized size in px. Absent = default card (fixed width, height grows
  // with the text up to a cap, then scrolls).
  w?: number;
  h?: number;
}
