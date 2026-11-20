# TaskNotes Calendar Enhancer

An independent companion Obsidian plugin (desktop & mobile) that enhances the [TaskNotes](https://github.com/callumalpass/tasknotes) (`v5.0.1+`) Bases Calendar view without patching or forking TaskNotes.

## Features

Each feature has an independent toggle in **Settings → TaskNotes Calendar Enhancer**, so you can turn off any module immediately if upstream TaskNotes adopts an equivalent fix or behavior.

### 1. Bases Toolbar Calendar Picker (`enableToolbarCalendarPicker`)
- Adds a **Calendars** dropdown button directly into the Obsidian Bases toolbar next to native controls (`Sort`, `Filter`, `Properties`, `Search`), styled to match native Bases toolbar buttons and menus.
- Toggle individual Google, Microsoft, and ICS calendars on/off cleanly without navigating away from the calendar view.
- Includes **Show all** / **Hide all** batch actions, a visible-count badge when filtered, mobile-friendly touch sizing (`44px`), and a shortcut to TaskNotes settings when using Hosted Google (which caps enabled Google calendars at 5 in TaskNotes settings).

### 2. External Calendar Startup Cache (`enableExternalCalendarCache`)
- Uses a safe Stale-While-Revalidate runtime wrapper across TaskNotes' Google (Hosted & Own OAuth), Microsoft, and ICS providers so cached external calendars appear immediately on Obsidian startup instead of waiting on sequential background network syncs.
- Supports staggered per-subscription ICS loading so slower feeds stay visible while faster feeds update live.
- Preserves stale cache cleanly across offline startups, purges automatically on sign-out/disconnect/session expiry, and includes a **Clear calendar cache** button in plugin settings.

### 3. Mobile Month View Tap Details (`enableMobileMonthTap`)
- Restores tap interaction on month `chips` indicators (`560px–850px` width) and narrow/compact dot cells (`< 560px`) when `showMonthDayPanel` is off so tapping opens task details or the day's event popover cleanly.
- Leaves swipes, drag-and-drop, selection mode, and `showMonthDayPanel: true` intact.

### 4. Month View Quick Create (`enableMonthDayQuickCreate`)
- **Desktop right-click** or **mobile/touch long-press (`480ms`)** on a month day cell opens TaskNotes' native creation menu (`Create task`, `Create timeblock`, `Create time entry`, `Create external calendar event`) across `full`, `chips`, `dots`, `compact`, and `showMonthDayPanel: true`.
- Suppresses post-long-press OS callouts and accidental tap-through popovers while cancelling cleanly on finger movement (`> 10px`), pinch gestures, swipes, or drags.

### 5. Custom Calendar Colors (`enableCustomCalendarColors`)
- Override individual Google, Microsoft, and ICS calendar colors across TaskNotes Calendar views without modifying upstream provider accounts (including per-calendar color differentiation for Microsoft calendars, which TaskNotes otherwise renders with a single `#0078D4` color).
- Change colors either in **Settings → TaskNotes Calendar Enhancer → Calendar colors** or directly inside the **Calendars** toolbar popover by clicking any calendar's color dot to open an inline palette (12 presets, custom color picker, and **Reset** button).
- Layered cleanly above the startup cache so cached upstream data remains untouched and toggling custom colors off immediately restores original provider colors.

### 6. Weekend & Holiday Colors (`enableWeekendHolidayColors`)
- Colors Saturdays blue and Sundays/holidays red across TaskNotes Calendar views (**Month**, **Week / Day / Custom Days**, **Year**, **List**, and **Agenda Strip**), with Saturday holidays prioritizing holiday red.
- Includes a built-in **offline Japanese national holiday calculator** (`enableJapaneseHolidays`, `1948–2150`, covering fixed holidays, Happy Mondays, astronomical equinoxes, `振替休日`, `国民の休日`, and 2019–2021 special holiday legislation) with zero external network calls.
- Supports selecting any connected Google, Microsoft, or ICS calendar as an external holiday source (`holidayCalendarKeys`, tucked inside a collapsible settings disclosure so large calendar lists stay compact).
- Displays inline holiday name labels in Month view (centered to the left of the date number), Week/Day headers, and List day headers, plus hover tooltips on date numbers.

## Installation via BRAT

This plugin is packaged for desktop and mobile (`"isDesktopOnly": false`) and distributed via **BRAT** (Beta Reviewers Auto-update Tester):

1. Install and enable **BRAT** from Obsidian Community Plugins.
2. Open **Settings → BRAT → Add Beta plugin**.
3. Enter the repository URL:
   ```text
   https://github.com/kntrinsic/tasknotes-calendar-enhancer
   ```
4. Enable **TaskNotes Calendar Enhancer** in **Settings → Community plugins** (requires core **Bases** and **TaskNotes** to be enabled).

## Privacy & Security

- **Zero runtime dependencies**: Does not ship third-party analytics, telemetry, or external network libraries.
- **Device-local cache & hashed settings keys**: Cached external calendar events and calendar metadata are stored exclusively in Obsidian's device-local `localStorage` (`app.loadLocalStorage` / `app.saveLocalStorage`) with a 7-day TTL and per-provider size/count limits—**never** inside Vault notes or `data.json`. Custom calendar color overrides and selected holiday calendar keys stored in `data.json` use one-way 64-bit FNV-1a hashed keys (`<provider>:<16-hex-digest>`) so raw email addresses or calendar IDs are never written to the Vault.
- **No credential access**: Never reads, copies, or logs OAuth tokens, client secrets, or ICS passwords/URLs. ICS cache entries use a strict field whitelist (`id`, `name`, `type`, `color`, `enabled`, `refreshInterval`) and strip `url`, `filePath`, `authType`, `username`, and `filter`.
- **Safe cleanup & XSS protection**: Never uses `innerHTML` / `outerHTML` / `insertAdjacentHTML`; cleans up all wrappers, DOM elements, listeners, and observers on `onunload()` without calling Bases `config.set()` during teardown (avoiding Bases `#1397`).

## Development & Verification

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm audit --audit-level=high
```

## License

MIT — see [LICENSE](LICENSE).
