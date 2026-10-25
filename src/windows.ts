/**
 * Peak-window time math: parsing window specs, evaluating the current state,
 * and formatting countdowns.
 *
 * Everything is minute-granular. A window is half-open: `[start, end)`, so a
 * window of `01:00-04:00` includes 01:00 and excludes 04:00. A window whose end
 * is before its start wraps past midnight (`22:00-02:00`).
 */

export type TimeFrame = "utc" | "local";

export interface PeakWindow {
	/** "HH:MM", 24h clock, in the configured frame. */
	start: string;
	/** "HH:MM", 24h clock, in the configured frame. "24:00" means end of day. */
	end: string;
}

export const MINUTES_PER_DAY = 1440;

const FRAME_PREFIX = /^(utc|gmt|local|loc)\b[\s:,]*/i;
const RANGE = /(\d{1,2}(?::\d{1,2})?\s*(?:[ap]m)?)\s*(?:-|to)\s*(\d{1,2}(?::\d{1,2})?\s*(?:[ap]m)?)/gi;

/** Parse `"1"`, `"01"`, `"1:30"`, `"0130"`, `"1:30pm"`, `"24:00"` into minutes past midnight. */
export function parseClockToken(token: string): number | undefined {
	let text = token.trim().toLowerCase().replace(/\s+/g, "");
	let meridiem: "am" | "pm" | undefined;
	if (text.endsWith("pm")) {
		meridiem = "pm";
		text = text.slice(0, -2);
	} else if (text.endsWith("am")) {
		meridiem = "am";
		text = text.slice(0, -2);
	}

	let hours: number;
	let minutes = 0;
	const colon = text.match(/^(\d{1,2}):(\d{1,2})$/);
	const compact = text.match(/^(\d{1,2})(\d{2})$/);
	const bare = text.match(/^(\d{1,2})$/);
	if (colon) {
		hours = Number(colon[1]);
		minutes = Number(colon[2]);
	} else if (compact) {
		hours = Number(compact[1]);
		minutes = Number(compact[2]);
	} else if (bare) {
		hours = Number(bare[1]);
	} else {
		return undefined;
	}

	if (meridiem === "pm" && hours < 12) hours += 12;
	if (meridiem === "am" && hours === 12) hours = 0;

	// 24:00 is allowed as an end-of-day marker; nothing else may exceed midnight.
	if (hours === 24 && minutes === 0) return MINUTES_PER_DAY;
	if (hours > 23 || minutes > 59) return undefined;
	return hours * 60 + minutes;
}

/** Format minutes past midnight as `"HH:MM"`. */
export function formatClock(minutes: number): string {
	const normalized = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
	const hours = Math.floor(normalized / 60);
	const mins = normalized % 60;
	return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

export interface ParsedSpec {
	frame?: TimeFrame;
	windows: PeakWindow[];
	error?: string;
}

/**
 * Parse a window spec such as `"utc 01:00-04:00 06:00-10:00"`,
 * `"1-4, 6-10"`, or `"local 9:00pm-2:00am"`.
 */
export function parseWindowSpec(input: string): ParsedSpec {
	const raw = input.trim();
	if (!raw) return { windows: [], error: "Empty window spec. Try: 01:00-04:00, 06:00-10:00" };

	// Normalize unicode separators so copy-pasted ranges parse.
	let rest = raw.replace(/[\u2010-\u2015\u2212~]/g, "-");

	let frame: TimeFrame | undefined;
	const frameMatch = rest.match(FRAME_PREFIX);
	if (frameMatch) {
		frame = /^(utc|gmt)$/i.test(frameMatch[1] ?? "") ? "utc" : "local";
		rest = rest.slice(frameMatch[0].length);
	}

	const windows: PeakWindow[] = [];
	const scanner = new RegExp(RANGE.source, "gi");
	for (let match = scanner.exec(rest); match; match = scanner.exec(rest)) {
		const start = parseClockToken(match[1] ?? "");
		const end = parseClockToken(match[2] ?? "");
		if (start === undefined || end === undefined) {
			return { frame, windows: [], error: `Cannot parse "${match[0]}". Use 24h times like 01:00-04:00.` };
		}
		if (start === end) {
			return { frame, windows: [], error: `"${match[0]}" has equal start and end.` };
		}
		windows.push({ start: formatClock(start), end: formatClock(end) });
	}

	if (windows.length === 0) {
		return {
			frame,
			windows: [],
			error: "No windows found. Try: 01:00-04:00, 06:00-10:00",
		};
	}

	const leftover = rest.replace(new RegExp(RANGE.source, "gi"), "").replace(/[,;/\s]+/g, "");
	if (leftover) {
		return { frame, windows: [], error: `Unexpected "${leftover}". Separate windows with commas or spaces.` };
	}

	return { frame, windows };
}

/** Render windows as `"01:00-04:00, 06:00-10:00"`. */
export function formatWindowList(windows: readonly PeakWindow[]): string {
	return windows.map((w) => `${w.start}-${w.end}`).join(", ");
}

/** Render a spec that can be pasted back into `/peak set`. */
export function formatSpec(frame: TimeFrame, windows: readonly PeakWindow[]): string {
	return `${frame} ${formatWindowList(windows)}`;
}

export function frameLabel(frame: TimeFrame): string {
	return frame === "utc" ? "UTC" : "local";
}

/** Half-open `[start, end)` segments in minutes, splitting windows that wrap midnight. */
export function windowSegments(windows: readonly PeakWindow[]): Array<[number, number]> {
	const segments: Array<[number, number]> = [];
	for (const window of windows) {
		let start = parseClockToken(window.start);
		let end = parseClockToken(window.end);
		if (start === undefined || end === undefined) continue;
		if (start === MINUTES_PER_DAY) start = 0;
		if (start === end) continue;
		if (start < end) {
			segments.push([start, end]);
		} else {
			segments.push([start, MINUTES_PER_DAY]);
			segments.push([0, end]);
		}
	}
	return segments;
}

export function minuteOfDay(date: Date, frame: TimeFrame): number {
	return frame === "utc"
		? date.getUTCHours() * 60 + date.getUTCMinutes()
		: date.getHours() * 60 + date.getMinutes();
}

export interface PeakState {
	/** Whether `now` falls inside a peak window. */
	peak: boolean;
	/** Minutes until the state flips, or null when it never flips (all day / never). */
	minutesUntilChange: number | null;
	/** Milliseconds until the state flips, including the remaining seconds of the current minute. */
	msUntilChange: number | null;
	/** Whether any window is configured at all. */
	hasWindows: boolean;
}

/** Evaluate `windows` at `now` in `frame`. */
export function evaluatePeak(windows: readonly PeakWindow[], now: Date, frame: TimeFrame): PeakState {
	const segments = windowSegments(windows);
	if (segments.length === 0) {
		return { peak: false, minutesUntilChange: null, msUntilChange: null, hasWindows: false };
	}

	const isPeakAt = (minute: number) => segments.some(([start, end]) => minute >= start && minute < end);
	const nowMinute = minuteOfDay(now, frame);
	const peak = isPeakAt(nowMinute);
	const secondsIntoMinute = now.getSeconds();

	for (let delta = 0; delta < MINUTES_PER_DAY; delta++) {
		const minute = (nowMinute + delta) % MINUTES_PER_DAY;
		if (isPeakAt(minute) !== peak) {
			return {
				peak,
				minutesUntilChange: delta,
				msUntilChange: delta * 60_000 - secondsIntoMinute * 1000,
				hasWindows: true,
			};
		}
	}

	return { peak, minutesUntilChange: null, msUntilChange: null, hasWindows: true };
}

/** Format a countdown as `"1h20m"`, `"45m"`, or `"<1m"`. */
export function formatDuration(ms: number): string {
	if (ms < 60_000) return "<1m";
	const totalMinutes = Math.round(ms / 60_000);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours === 0) return `${minutes}m`;
	if (minutes === 0) return `${hours}h`;
	return `${hours}h${String(minutes).padStart(2, "0")}m`;
}

/** `"HH:MM"` for `now` in `frame`, e.g. `"14:05"`. */
export function currentClock(now: Date, frame: TimeFrame): string {
	return formatClock(minuteOfDay(now, frame));
}

/** Human-readable local zone name, used in dialogs only. */
export function localZoneName(now: Date = new Date()): string {
	const offsetMinutes = -now.getTimezoneOffset();
	const sign = offsetMinutes < 0 ? "-" : "+";
	const abs = Math.abs(offsetMinutes);
	const zone = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
	try {
		const name = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(now).find(
			(part) => part.type === "timeZoneName",
		)?.value;
		return name ? `local (${name}, UTC${zone})` : `local (UTC${zone})`;
	} catch {
		return `local (UTC${zone})`;
	}
}
