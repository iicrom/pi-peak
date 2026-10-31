/**
 * Peak-window time math: parsing window specs, evaluating the current state,
 * and formatting countdowns.
 *
 * Everything is minute-granular. A window is half-open: `[start, end)`, so a
 * window of `01:00-04:00` includes 01:00 and excludes 04:00. A window whose end
 * is before its start wraps past midnight (`22:00-02:00`).
 *
 * A window may also carry `days` (0 = Sunday … 6 = Saturday). Omitted means
 * every day. For a window that wraps midnight, the day list names the day the
 * window *starts*: `mon 22:00-02:00` runs into Tuesday morning.
 */

export type TimeFrame = "utc" | "local";

/** Day of week, 0 = Sunday … 6 = Saturday (the same numbering as `Date#getDay`). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface PeakWindow {
	/** "HH:MM", 24h clock, in the configured frame. */
	start: string;
	/** "HH:MM", 24h clock, in the configured frame. "24:00" means end of day. */
	end: string;
	/** Days the window applies to, 0 = Sunday … 6 = Saturday. Omitted means every day. */
	days?: Weekday[];
}

export const MINUTES_PER_DAY = 1440;

const FRAME_PREFIX = /^(utc|gmt|local|loc)\b[\s:,]*/i;
const RANGE = /(\d{1,2}(?::\d{1,2})?\s*(?:[ap]m)?)\s*(?:-|to)\s*(\d{1,2}(?::\d{1,2})?\s*(?:[ap]m)?)/gi;

const DAY_NAME = "sunday|sun|monday|mon|tuesday|tue|wednesday|wed|thursday|thu|friday|fri|saturday|sat";
const DAY_TERM = `(?:weekdays?|weekends?|(?:${DAY_NAME})(?:\\s*(?:-|to)\\s*(?:${DAY_NAME}))?)(?![a-z])`;
const DAY_PREFIX = new RegExp(`(?:${DAY_TERM})(?:\\s*[,/&]\\s*(?:${DAY_TERM}))*`, "gi");

const DAY_INDEX: Record<string, Weekday> = {
	sunday: 0,
	sun: 0,
	monday: 1,
	mon: 1,
	tuesday: 2,
	tue: 2,
	wednesday: 3,
	wed: 3,
	thursday: 4,
	thu: 4,
	friday: 5,
	fri: 5,
	saturday: 6,
	sat: 6,
};

/** Parse a single day name or keyword into day numbers. */
function parseDayTerm(term: string): Weekday[] | undefined {
	const text = term.trim().toLowerCase();
	if (text === "weekday" || text === "weekdays") return [1, 2, 3, 4, 5];
	if (text === "weekend" || text === "weekends") return [0, 6];

	const direct = DAY_INDEX[text];
	if (direct !== undefined) return [direct];

	const range = /^([a-z]+)\s*(?:-|to)\s*([a-z]+)$/.exec(text);
	if (!range) return undefined;
	const start = DAY_INDEX[range[1] ?? ""];
	const end = DAY_INDEX[range[2] ?? ""];
	if (start === undefined || end === undefined) return undefined;

	const days: Weekday[] = [start];
	let cursor = start;
	while (cursor !== end && days.length < 7) {
		cursor = ((cursor + 1) % 7) as Weekday;
		days.push(cursor);
	}
	return days;
}

/** Parse `mon-fri`, `weekdays`, `weekends`, `mon,wed,fri` into sorted day numbers. */
function parseDaysExpression(text: string): Weekday[] | undefined {
	const days: Weekday[] = [];
	for (const part of text.split(/\s*[,/&]\s*/)) {
		if (!part) continue;
		const parsed = parseDayTerm(part);
		if (parsed === undefined) return undefined;
		days.push(...parsed);
	}
	return normalizeDays(days);
}

/** Whether `value` is a valid day number (0-6) or day name/keyword. */
export function isWeekdayValue(value: unknown): boolean {
	if (typeof value === "number") return Number.isInteger(value) && value >= 0 && value <= 6;
	if (typeof value === "string") return parseDayTerm(value) !== undefined;
	return false;
}

/**
 * Normalize a day list (numbers 0-6, or names/keywords) into a sorted, deduped
 * `Weekday[]`. Returns `undefined` for "every day" and for an empty list.
 */
export function normalizeDays(values: readonly unknown[] | undefined): Weekday[] | undefined {
	if (values === undefined) return undefined;
	const days = new Set<Weekday>();
	for (const value of values) {
		if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 6) {
			days.add(value as Weekday);
		} else if (typeof value === "string") {
			for (const day of parseDayTerm(value) ?? []) days.add(day);
		}
	}
	if (days.size === 0 || days.size === 7) return undefined;
	return [...days].sort((left, right) => left - right);
}

/** `Mon-Fri`, `Sat-Sun`, `Mon,Wed,Fri`; `undefined` when every day applies. */
export function formatDays(days: readonly Weekday[] | undefined): string | undefined {
	if (days === undefined || days.length === 0) return undefined;
	const wanted = new Set(days);
	if (wanted.size === 7) return undefined;

	// Monday-first order reads naturally; Sunday sits at the end so `sat-sun`
	// becomes one run instead of two.
	const order: Weekday[] = [1, 2, 3, 4, 5, 6, 0];
	const runs: Weekday[][] = [];
	let run: Weekday[] = [];
	for (const day of order) {
		if (wanted.has(day)) {
			run.push(day);
		} else if (run.length > 0) {
			runs.push(run);
			run = [];
		}
	}
	if (run.length > 0) runs.push(run);

	return runs
		.map((daysInRun) => {
			const first = WEEKDAY_SHORT[daysInRun[0]!];
			const last = WEEKDAY_SHORT[daysInRun[daysInRun.length - 1]!];
			return daysInRun.length === 1 ? first : `${first}-${last}`;
		})
		.join(",");
}

/** Day of week for `date` in `frame`. */
export function weekdayOf(date: Date, frame: TimeFrame): Weekday {
	return (frame === "utc" ? date.getUTCDay() : date.getDay()) as Weekday;
}

/** Short weekday label for `date` in `frame`, e.g. `"Mon"`. */
export function weekdayLabel(date: Date, frame: TimeFrame): string {
	return WEEKDAY_SHORT[weekdayOf(date, frame)];
}

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

/** Like {@link formatClock}, but preserves `24:00` as an end-of-day marker. */
export function formatClockBoundary(minutes: number): string {
	return minutes === MINUTES_PER_DAY ? "24:00" : formatClock(minutes);
}

export interface ParsedSpec {
	frame?: TimeFrame;
	windows: PeakWindow[];
	error?: string;
}

/**
 * Parse a window spec such as `"utc 01:00-04:00 06:00-10:00"`,
 * `"1-4, 6-10"`, `"local 9:00pm-2:00am"`, or
 * `"utc mon-fri 01:00-04:00 06:00-10:00"`.
 *
 * A day list (`mon-fri`, `weekdays`, `weekends`, `mon,wed,fri`) before a range
 * restricts that range and every following range until the next day list.
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

	interface Token {
		index: number;
		length: number;
		text: string;
		days?: Weekday[];
		start?: number;
		end?: number;
	}

	const tokens: Token[] = [];
	for (const match of rest.matchAll(new RegExp(RANGE.source, "gi"))) {
		const start = parseClockToken(match[1] ?? "");
		const end = parseClockToken(match[2] ?? "");
		if (start === undefined || end === undefined) {
			return { frame, windows: [], error: `Cannot parse "${match[0]}". Use 24h times like 01:00-04:00.` };
		}
		if (start === MINUTES_PER_DAY) {
			return { frame, windows: [], error: `"${match[0]}" cannot start at 24:00.` };
		}
		if (start === end) {
			return { frame, windows: [], error: `"${match[0]}" has equal start and end.` };
		}
		tokens.push({ index: match.index ?? 0, length: match[0].length, text: match[0], start, end });
	}

	for (const match of rest.matchAll(new RegExp(DAY_PREFIX.source, "gi"))) {
		const days = parseDaysExpression(match[0]);
		if (days === undefined) {
			return { frame, windows: [], error: `Cannot parse days "${match[0]}". Try mon-fri, weekdays or weekends.` };
		}
		tokens.push({ index: match.index ?? 0, length: match[0].length, text: match[0], days });
	}

	tokens.sort((left, right) => left.index - right.index);

	const windows: PeakWindow[] = [];
	let currentDays: Weekday[] | undefined;
	let cursor = 0;
	let lastWasDays = false;

	for (const token of tokens) {
		const gap = rest.slice(cursor, token.index);
		if (gap.replace(/[,;/\s]+/g, "") !== "") {
			return {
				frame,
				windows: [],
				error: `Unexpected "${gap.trim()}". Separate windows with commas or spaces.`,
			};
		}
		cursor = token.index + token.length;

		if (token.days !== undefined) {
			currentDays = token.days;
			lastWasDays = true;
			continue;
		}

		lastWasDays = false;
		const window: PeakWindow = {
			start: formatClockBoundary(token.start!),
			end: formatClockBoundary(token.end!),
		};
		if (currentDays !== undefined) window.days = [...currentDays];
		windows.push(window);
	}

	const trailing = rest.slice(cursor).replace(/[,;/\s]+/g, "");
	if (trailing) {
		return { frame, windows: [], error: `Unexpected "${trailing}". Separate windows with commas or spaces.` };
	}
	if (lastWasDays) {
		return { frame, windows: [], error: `"${tokens[tokens.length - 1]?.text ?? ""}" needs a window after it.` };
	}
	if (windows.length === 0) {
		return {
			frame,
			windows: [],
			error: "No windows found. Try: 01:00-04:00, 06:00-10:00",
		};
	}

	return { frame, windows };
}

/** Render windows as `"Mon-Fri 01:00-04:00, 06:00-10:00"` (day groups share a prefix). */
export function formatWindowList(windows: readonly PeakWindow[]): string {
	const groups: Array<{ label: string | undefined; ranges: string[] }> = [];
	for (const window of windows) {
		const label = formatDays(window.days);
		const last = groups[groups.length - 1];
		if (last !== undefined && last.label === label) {
			last.ranges.push(`${window.start}-${window.end}`);
		} else {
			groups.push({ label, ranges: [`${window.start}-${window.end}`] });
		}
	}
	return groups
		.map((group) => `${group.label === undefined ? "" : `${group.label} `}${group.ranges.join(", ")}`)
		.join(", ");
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

/** Whether any window is active at `date` in `frame`, honouring per-window days. */
function isPeakAt(windows: readonly PeakWindow[], date: Date, frame: TimeFrame): boolean {
	const minute = minuteOfDay(date, frame);
	const today = weekdayOf(date, frame);
	const yesterday = ((today + 6) % 7) as Weekday;

	for (const window of windows) {
		let start = parseClockToken(window.start);
		const end = parseClockToken(window.end);
		if (start === undefined || end === undefined) continue;
		if (start === MINUTES_PER_DAY) start = 0;
		if (start === end) continue;

		const applies = (day: Weekday): boolean =>
			window.days === undefined || window.days.length === 0 || window.days.includes(day);

		if (start < end) {
			if (minute >= start && minute < end && applies(today)) return true;
		} else {
			// A wrapping window belongs to the day it starts, so its after-midnight
			// tail checks yesterday's weekday.
			if (minute >= start && applies(today)) return true;
			if (minute < end && applies(yesterday)) return true;
		}
	}
	return false;
}

/** Evaluate `windows` at `now` in `frame`. */
export function evaluatePeak(windows: readonly PeakWindow[], now: Date, frame: TimeFrame): PeakState {
	const segments = windowSegments(windows);
	if (segments.length === 0) {
		return { peak: false, minutesUntilChange: null, msUntilChange: null, hasWindows: false };
	}

	const peak = isPeakAt(windows, now, frame);
	const secondsIntoMinute = now.getSeconds();

	// Peak state is weekly periodic, so one full week is enough to prove that it
	// never flips. Scanning absolute minutes also skips whole weekends when the
	// windows are weekday-only.
	for (let delta = 0; delta < 7 * MINUTES_PER_DAY; delta++) {
		const candidate = new Date(now.getTime() + delta * 60_000);
		if (isPeakAt(windows, candidate, frame) !== peak) {
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

/** Format a countdown as `"1h20m"`, `"45m"`, `"2d15h"`, or `"<1m"`. */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 60_000) return "<1m";
	const totalMinutes = Math.round(ms / 60_000);
	const days = Math.floor(totalMinutes / MINUTES_PER_DAY);
	const hours = Math.floor((totalMinutes % MINUTES_PER_DAY) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) {
		const hourPart = hours > 0 ? `${hours}h` : "";
		const minutePart = minutes > 0 ? `${String(minutes).padStart(2, "0")}m` : "";
		return `${days}d${hourPart}${minutePart}`;
	}
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
