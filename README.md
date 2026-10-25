# pi-peak

Peak / off-peak hour awareness for [pi](https://pi.dev) models.

Some providers charge more (or throttle harder) during published "peak" windows — DeepSeek, for
example, discounts off-peak usage outside **UTC 01:00-04:00** and **06:00-10:00**. This extension
lets you declare those windows per model, and shows the result in the status bar whenever that
model is selected:

```
INFO  Model          gpt-5.2-codex
INFO  Directory      ~/Projects/foo
      PEAK · ends in 2h05m (UTC 01:00-04:00, 06:00-10:00)
```

Off-peak the line flips to:

```
      OFF-PEAK · next peak in 1h20m (UTC 01:00-04:00, 06:00-10:00)
```

Models without a configured window show nothing, so the footer stays clean.

## Install

```bash
# try it for one run
pi -e /path/to/pi-peak

# or install it permanently (personal settings)
pi install /path/to/pi-peak
```

## Commands

| Command | What it does |
| --- | --- |
| `/peak` | Pick a model (current one preselected), then a preset or custom windows |
| `/peak status` | Detailed state for the current model: now, window, next change |
| `/peak list` | Every configured model with its config and whether it is in peak hours right now |
| `/peak set <spec>` | Set windows for the current model, e.g. `/peak set utc 01:00-04:00 06:00-10:00` |
| `/peak preset <name>` | Apply a named preset to the current model |
| `/peak clear` | Remove the current model's windows |
| `/peak help` | Usage summary |

`/peak <spec>` and `/peak <preset>` also work without a subcommand.

### Window specs

```
/peak set utc 01:00-04:00 06:00-10:00     # two UTC windows
/peak set local 09:00-17:00               # local wall-clock window
/peak set 22:00-02:00                     # wraps past midnight (UTC by default)
/peak set 1-4, 6-10                       # shorthand hours
/peak set local 9:00am-5:00pm             # am/pm works too
```

The frame (`utc` or `local`) is optional; without it the existing config's frame is kept, or UTC
for a new config. `local` uses your machine's wall clock, so it follows DST.

### Presets

Built in:

| Preset | Windows |
| --- | --- |
| `deepseek` | UTC 01:00-04:00, 06:00-10:00 |
| `utc-business` | UTC 08:00-17:00 |
| `local-business` | local 09:00-17:00 |

Add your own in the config file under `presets`; they show up in `/peak` and in argument
completion.

## Config file

`~/.pi/agent/peak-hours.json` (or `$PI_CODING_AGENT_DIR/peak-hours.json`) — global, so one config
covers every session and project. Hand edits are picked up within ~20 seconds, no restart needed.

```json
{
	"version": 1,
	"models": {
		"deepseek/deepseek-chat": {
			"frame": "utc",
			"windows": [
				{ "start": "01:00", "end": "04:00" },
				{ "start": "06:00", "end": "10:00" }
			],
			"preset": "deepseek",
			"updatedAt": "2025-01-01T00:00:00.000Z"
		},
		"openrouter/*": {
			"frame": "utc",
			"windows": [{ "start": "16:00", "end": "20:00" }]
		}
	},
	"presets": {
		"my-provider": {
			"description": "My provider's peak window",
			"frame": "utc",
			"windows": [{ "start": "12:00", "end": "14:00" }]
		}
	}
}
```

Lookup order for the active model: exact `provider/model`, then `provider/*`, then `*`.

### Semantics

- Windows are half-open: `01:00-04:00` is peak from 01:00:00 up to (not including) 04:00:00.
- `start` after `end` wraps past midnight (`22:00-02:00`). `24:00` is accepted as end of day.
- `00:00-24:00` marks the whole day as peak.
- Windows in the same config may overlap; the union is what counts.
- The status line refreshes every 20 seconds but only when its text changes, so a minute-resolution
  countdown never causes redraw churn.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # window/time math
npm run smoke       # drives the extension through a mocked ExtensionAPI
node --test src/windows.test.ts
```

`tsc` and the smoke script need `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` to
resolve. When developing outside an installed pi, symlink them into `node_modules/@earendil-works/`
pointing at your pi installation.

## Layout

```
extensions/peak.ts   command, events, status wiring
src/windows.ts       window parsing, peak evaluation, countdowns
src/config.ts        config load/save, presets, model lookup
src/status.ts        status-bar line and `/peak status` text
src/ui.ts            searchable picker used by the interactive flow
```

## License

MIT
