# Inspire - A Better New Tab

A calm, inspiring new-tab dashboard for Chrome.

The extension replaces the default new tab with a **life clock**, **daily todos** (optionally synced with Trello), a **daily quote**, a **Pinterest-style pins wall**, and **sticky notes**.

![Example of extension in action](public/imgs/image.png)

---

## Features

- **Life clock** - see how much of your current day, week, month, year, decade, and life are left as progress bars and grids. Zoom in and out to change views. Meant as a reminder that life is fleeting, not as something to get depressed about.
- **Todos** - a per-day task list in the left sidebar. Works fully offline, and can optionally two-way sync with a Trello board.
- **Quote** - a daily quote from [ZenQuotes](https://zenquotes.io) with included offline quotes (philosophy, self-help, morality). Write your own quotes too — mixed into the rotation, or shown on their own.
- **Pins wall** - a full Pinterest-style pins board of your own images, grouped into boards. Right-click any image on the web to add it. Auto-rotate boards or slowly drift through pins with panorama scroll.
- **Notes** - add sticky notes so you can jot down any idea; open on a full-screen interactive board.
- **Wallpaper** - set a wallpaper -- solid color, image URL, or a locally uploaded image.
- **Move mode** - the pencil button opens the layout editor: `‹` `›` step through one panel at a time, with everything else off screen — quote at the top, center, or bottom; tasks on the left or right edge; the search bar anywhere down the centre line. Green check keeps it, red × throws it away.
- **Themes** - dark / light, plus a liquid-glass toggle.

Features zoom to fit any window size.

Full keybind + setting reference: [USER.md](USER.md).

---

## Usage

Add the extension to any Chrome-based browser by visiting [this link](https://chromewebstore.google.com/detail/djbodeflaapfiadddfdjbmfjldkgndli).

Email me at [feifan.liu@utexas.edu](mailto:feifan.liu@utexas.edu) for any inquiries or requests for new features!

---

## Install (unpacked)

**To load the prebuilt zip instead: unzip `inspire-*.zip` and **Load unpacked** the extracted folder.**

If you want to build the extension yourself:

1. Build the extension:

   ```bash
   npm install
   npm run build
   ```

   Output lands in `dist/`.
2. Open `chrome://extensions` (or `brave://extensions`).
3. Toggle **Developer mode** (top-right) on.
4. Click **Load unpacked** and select the `dist/` folder.
5. Open a new tab.

---

## Update an installed copy

After pulling changes or editing source:

1. `npm run build` - rebuilds `dist/`.
2. `chrome://extensions` -> the extension card -> **Reload** (↻).
3. Open a new tab.

---

## Development

```bash
npm run dev        # Vite dev server for newtab.html (hot reload)
npm run build      # production build -> dist/
npm run typecheck  # tsc --noEmit
npm run icons      # regenerate PNG icons from source
```

The dev server serves `newtab.html`, but Chrome-only APIs (`chrome.storage`, context menus) are guarded, so most of the UI works in a plain browser tab. Load `dist/` as an unpacked extension to use and view the full feature set.

---

## Project structure

```
public/            manifest.json, icons, fonts (copied verbatim into dist/)
newtab.html        new-tab entry
src/
  main.ts          boot + zoom controller
  background.ts    service worker (right-click "Add image to pins board")
  core/            DOM, events bus, storage, settings, module registry
  modules/         lifeclock, todo, notes, pins, quote, search, wallpaper, layout, help
  ui/              settings panel
  styles/          tokens, base, fonts
scripts/           icon + font generators
```

Modules self-register in [src/modules/index.ts](src/modules/index.ts) and mount into fixed slots (`background`, `main`, `sidebar`, `corner`, `overlay`).

---

## Privacy

All data is stored in `chrome.storage.local` on your machine. The only outbound requests are **Trello** (*if* you enable sync and enter credentials) and **ZenQuotes** (*if* the daily-quote fetch is on).

With both off, the dashboard is still fully functional, with bundled fonts, a solid wallpaper color, and a bundled quote pool. The right-click "Add image to pins board" feature reads only the URL of the image you click; no page content is collected or uploaded.
