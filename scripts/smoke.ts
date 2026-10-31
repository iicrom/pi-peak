/**
 * Smoke test: exercise the extension through a mocked ExtensionAPI.
 *
 * Run with:  node scripts/smoke.ts
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = join(tmpdir(), `pi-peak-smoke-${process.pid}`);
rmSync(agentDir, { recursive: true, force: true });
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const { default: peakExtension } = await import("../extensions/peak.ts");

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;

const handlers = new Map<string, Handler>();
let command: { name: string; handler: (args: string, ctx: unknown) => Promise<void> } | undefined;

const pi = {
	on(event: string, handler: Handler) {
		handlers.set(event, handler);
		return () => handlers.delete(event);
	},
	registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
		command = { name, handler: options.handler };
	},
} as never;

const deepseek = {
	provider: "deepseek",
	id: "deepseek-chat",
	name: "DeepSeek Chat",
	reasoning: false,
};

const other = { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude", reasoning: true };

const notifications: string[] = [];
const statuses: Array<string | undefined> = [];
let model: unknown = deepseek;

const ctx = {
	mode: "tui",
	hasUI: true,
	cwd: process.cwd(),
	signal: undefined,
	model: deepseek,
	scopedModels: [],
	modelRegistry: {
		getAvailable: () => [deepseek, other],
		getAll: () => [deepseek, other],
		find: () => undefined,
	},
	ui: {
		theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
		notify: (message: string) => notifications.push(message),
		setStatus: (_key: string, text: string | undefined) => statuses.push(text),
		select: async () => undefined,
		input: async () => undefined,
		confirm: async () => false,
	},
};

// Keep `ctx.model` in sync with what a real session would expose.
Object.defineProperty(ctx, "model", { get: () => model });

peakExtension(pi);
assert.ok(command, "the extension must register a /peak command");
assert.equal(command.name, "peak");
assert.ok(handlers.has("session_start"), "the extension must handle session_start");
assert.ok(handlers.has("model_select"), "the extension must handle model_select");
assert.ok(handlers.has("session_shutdown"), "the extension must handle session_shutdown");

const run = (args: string) => command.handler(args, ctx);
const setStatus = (next: unknown) => {
	model = next;
	return handlers.get("model_select")?.({}, ctx);
};

// --- no config yet -------------------------------------------------------
await handlers.get("session_start")?.({ reason: "startup" }, ctx);
assert.equal(statuses.at(-1), undefined, "no status line without config");

await run("status");
assert.match(notifications.at(-1) ?? "", /no peak hours configured for deepseek\/deepseek-chat/);

// --- apply the built-in DeepSeek preset ----------------------------------
await run("preset deepseek");
const configPath = join(agentDir, "peak-hours.json");
assert.ok(existsSync(configPath), "preset must persist to disk");

const saved = JSON.parse(readFileSync(configPath, "utf-8"));
assert.deepEqual(saved.models["deepseek/deepseek-chat"].windows, [
	{ start: "01:00", end: "04:00", days: [1, 2, 3, 4, 5] },
	{ start: "06:00", end: "10:00", days: [1, 2, 3, 4, 5] },
]);
assert.equal(saved.models["deepseek/deepseek-chat"].frame, "utc");
assert.equal(saved.models["deepseek/deepseek-chat"].preset, "deepseek");

const statusLine = statuses.at(-1) ?? "";
assert.match(
	statusLine,
	/^(PEAK · ends in .+|OFF-PEAK · next peak in .+) \(UTC Mon-Fri 01:00-04:00, 06:00-10:00\)$/,
);

// --- a different model clears the status line ---------------------------
await setStatus(other);
assert.equal(statuses.at(-1), undefined, "status line must disappear for unconfigured models");

// --- status detail and list ---------------------------------------------
await setStatus(deepseek);
await run("status");
assert.match(notifications.at(-1) ?? "", /deepseek\/deepseek-chat — (PEAK|off-peak)/);
assert.match(notifications.at(-1) ?? "", /windows UTC Mon-Fri 01:00-04:00, 06:00-10:00/);

await run("list");
assert.match(notifications.at(-1) ?? "", /deepseek\/deepseek-chat · UTC Mon-Fri 01:00-04:00, 06:00-10:00/);

// --- custom spec, including a midnight-spanning local window ------------
await run("set local 22:00-02:00");
const localSaved = JSON.parse(readFileSync(configPath, "utf-8"));
assert.equal(localSaved.models["deepseek/deepseek-chat"].frame, "local");
assert.deepEqual(localSaved.models["deepseek/deepseek-chat"].windows, [{ start: "22:00", end: "02:00" }]);
assert.equal(localSaved.models["deepseek/deepseek-chat"].preset, undefined, "custom windows drop the preset tag");

// --- a bad spec is rejected, config untouched ---------------------------
await run("set 01:00-01:00");
assert.match(notifications.at(-1) ?? "", /equal start and end/);
assert.deepEqual(
	JSON.parse(readFileSync(configPath, "utf-8")).models["deepseek/deepseek-chat"].windows,
	[{ start: "22:00", end: "02:00" }],
);

// --- clear --------------------------------------------------------------
await run("clear");
assert.equal(JSON.parse(readFileSync(configPath, "utf-8")).models["deepseek/deepseek-chat"], undefined);
assert.equal(statuses.at(-1), undefined);

// --- interactive flow through the non-TUI fallback dialogs --------------
const prompts: string[] = [];
const replies: Array<string | undefined> = ["deepseek/deepseek-chat", "custom windows…", "utc 03:00-05:00"];
const rpcCtx = {
	...ctx,
	mode: "rpc",
	ui: {
		...ctx.ui,
		select: async (title: string, options: string[]) => {
			prompts.push(`${title} :: ${options.join(" | ")}`);
			const reply = replies.shift();
			if (reply === undefined) return undefined;
			// Model items are prefixed with ●/✓/space markers; match on a substring.
			return options.find((option) => option.includes(reply));
		},
		input: async (title: string) => {
			prompts.push(`input ${title}`);
			return replies.shift();
		},
	},
};
Object.defineProperty(rpcCtx, "model", { get: () => model });
model = deepseek;

await command.handler("", rpcCtx);
const interactiveSaved = JSON.parse(readFileSync(configPath, "utf-8"));
assert.ok(interactiveSaved.models["deepseek/deepseek-chat"], "interactive flow must save a config");
assert.deepEqual(interactiveSaved.models["deepseek/deepseek-chat"].windows, [{ start: "03:00", end: "05:00" }]);
assert.equal(interactiveSaved.models["deepseek/deepseek-chat"].frame, "utc");
assert.match(prompts[0] ?? "", /^Peak hours · model :: /);
assert.match(prompts[1] ?? "", /^Peak hours · deepseek\/deepseek-chat :: .*custom windows…/);
assert.match(prompts[2] ?? "", /^input Peak windows for deepseek\/deepseek-chat/);

// --- TUI flow: real SelectList + search input, driven by keystrokes -------
const renderLog: string[] = [];
const keyScripts: string[][] = [
	["\r"], // model picker: accept the preselected current model
	[..."custom", "\r"], // action picker: filter to "custom windows…" and take it
];
const keybindings = {
	matches: (data: string, action: string) =>
		({
			"tui.select.up": data === "\x1b[A",
			"tui.select.down": data === "\x1b[B",
			"tui.select.confirm": data === "\r",
			"tui.select.cancel": data === "\x1b",
		})[action] === true,
};
const tuiCtx = {
	...ctx,
	mode: "tui",
	ui: {
		...ctx.ui,
		input: async (title: string) => {
			prompts.push(`input ${title}`);
			return "utc 07:00-08:00";
		},
		custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => Promise<unknown>) => {
			let result: unknown;
			const component = (await factory(
				{ requestRender() {} },
				ctx.ui.theme,
				keybindings,
				(value: unknown) => {
					result = value;
				},
			)) as { render(width: number): string[]; handleInput(data: string): void };
			renderLog.push(component.render(100).join("\n"));
			for (const key of keyScripts.shift() ?? []) component.handleInput(key);
			return result;
		},
	},
};
Object.defineProperty(tuiCtx, "model", { get: () => model });

await command.handler("", tuiCtx);
const tuiSaved = JSON.parse(readFileSync(configPath, "utf-8"));
assert.deepEqual(tuiSaved.models["deepseek/deepseek-chat"].windows, [{ start: "07:00", end: "08:00" }]);
assert.match(renderLog[0] ?? "", /Peak hours · model/);
assert.match(renderLog[0] ?? "", /deepseek\/deepseek-chat/);
assert.match(renderLog[1] ?? "", /custom windows…/);
assert.match(renderLog[1] ?? "", /preset: deepseek/);

// --- Escape cancels without touching the config --------------------------
keyScripts.push(["\x1b"]);
const before = readFileSync(configPath, "utf-8");
await command.handler("", tuiCtx);
assert.equal(readFileSync(configPath, "utf-8"), before, "cancelling must not write the config");

// --- shutdown stops the timer and clears the status ---------------------
await handlers.get("session_shutdown")?.({}, ctx);
assert.equal(statuses.at(-1), undefined);

rmSync(agentDir, { recursive: true, force: true });
console.log("smoke: ok");
