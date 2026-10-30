const vscode = require("vscode");
const { getUsage, getChatGptUsage } = require("./usage");

let item;
let timer;
let log;
let last;
let lastChat;
let secrets;
let globalState;
const SECRET_KEY = "claudeUsageIndicator.ungateApiKey";
const URL_STATE_KEY = "claudeUsageIndicator.ungateUrl";

// URL: settings.json value (if registered) takes precedence, else globalState.
function ungateUrl() {
	const fromSettings = vscode.workspace.getConfiguration("claudeUsageIndicator").get("ungateUrl");
	return fromSettings || globalState.get(URL_STATE_KEY) || "";
}

function cfg() {
	const c = vscode.workspace.getConfiguration("claudeUsageIndicator");
	const opt = (k) => {
		const v = c.get(k);
		return v ? v : undefined;
	};
	return {
		intervalMin: Math.max(1, c.get("pollIntervalMinutes", 5)),
		showChatGpt: c.get("showChatGpt", false) === true,
		opts: Object.fromEntries(
			[
				["ungateDir", opt("ungateDir")],
				["claudeCredentials", opt("claudeCredentialsPath")],
				["statuslineCache", opt("statuslineCachePath")],
				["remoteUrl", ungateUrl() || undefined],
				["remoteModel", opt("probeModel")],
				["codexAuth", opt("codexAuthPath")],
			].filter(([, v]) => v),
		),
	};
}

const pct = (w) => (w ? `${Math.round(w.percent)}%` : "—");

// Allowed weekly usage by day of the weekly window (day 1 = first 24h after reset).
const WEEK_THRESHOLDS = [40, 60, 70, 80, 90, 95, 95];
const FIVE_HOUR_THRESHOLD = 80;
const ACK_STATE_KEY = "claudeUsageIndicator.weeklyAck";
const ACK5_STATE_KEY = "claudeUsageIndicator.fiveHourAck";
const WEEK_MS = 7 * 24 * 3.6e6;

function weekDay(resetsAt) {
	if (!resetsAt) return undefined;
	const start = resetsAt.getTime() - WEEK_MS;
	const day = Math.floor((Date.now() - start) / (24 * 3.6e6)) + 1;
	return Math.min(7, Math.max(1, day));
}

function todayKey() {
	const d = new Date();
	return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

const step = (p) => Math.floor(p / 10) * 10;

// Returns { day, limit, over, alert } for the weekly window.
function weeklyPace(w) {
	if (!w) return undefined;
	const day = weekDay(w.resetsAt);
	if (!day) return undefined;
	const limit = WEEK_THRESHOLDS[day - 1];
	const over = w.percent >= limit;
	let alert = over;
	if (over) {
		const ack = globalState.get(ACK_STATE_KEY);
		if (ack && ack.date === todayKey() && step(w.percent) <= ack.step) alert = false;
	}
	return { day, limit, over, alert };
}

// 5h window: alert from 80%; acknowledgement holds until next +10% or window reset.
const windowKey = (w) => (w.resetsAt ? String(Math.round(w.resetsAt.getTime() / 6e4)) : "");

function fiveHourPace(w) {
	if (!w) return undefined;
	const over = w.percent >= FIVE_HOUR_THRESHOLD;
	let alert = over;
	if (over) {
		const ack = globalState.get(ACK5_STATE_KEY);
		if (ack && ack.window === windowKey(w) && step(w.percent) <= ack.step) alert = false;
	}
	return { over, alert };
}

async function acknowledge() {
	const u = last?.usage;
	if (!u) return;
	if (weeklyPace(u.sevenDay)?.alert) {
		await globalState.update(ACK_STATE_KEY, { date: todayKey(), step: step(u.sevenDay.percent) });
	}
	if (fiveHourPace(u.fiveHour)?.alert) {
		await globalState.update(ACK5_STATE_KEY, { window: windowKey(u.fiveHour), step: step(u.fiveHour.percent) });
	}
	render(last);
}

function fmtReset(d) {
	if (!d) return "";
	const ms = d.getTime() - Date.now();
	if (ms <= 0) return " — reset";
	const h = Math.floor(ms / 3.6e6);
	const m = Math.floor((ms % 3.6e6) / 6e4);
	const left = h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
	return ` — resets in ${left}`;
}

function ago(d) {
	const min = Math.round((Date.now() - d.getTime()) / 6e4);
	if (min < 1) return "just now";
	if (min < 60) return `${min} min ago`;
	const h = Math.round(min / 60);
	return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

function limitLabel(seconds) {
	if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "Limit";
	const hours = seconds / 3600;
	if (Math.abs(hours - 5) < 0.2) return "5h";
	const days = hours / 24;
	if (Math.abs(days - 7) < 0.2) return "Week";
	if (hours < 48) return `${Math.round(hours)}h`;
	return `${Math.round(days)}d`;
}

function planLabel(plan) {
	if (!plan || typeof plan !== "string") return "";
	return plan.charAt(0).toUpperCase() + plan.slice(1);
}

// Extra tooltip lines. No-op unless showChatGpt is on, so the tooltip stays as before.
function appendChatGpt(lines) {
	if (!cfg().showChatGpt || !lastChat) return;
	const g = lastChat;
	lines.push("");
	if (!g || !g.ok) {
		lines.push("**ChatGPT** — unavailable");
		return;
	}
	const plan = planLabel(g.plan);
	const stale = g.live ? "" : " (last request failed)";
	lines.push(`**ChatGPT**${plan ? ` · ${plan}` : ""}${stale}`);
	for (const w of g.windows || []) {
		lines.push(`- ${limitLabel(w.seconds)}: **${pct(w)}**${fmtReset(w.resetsAt)}`);
	}
}

function render(r) {
	if (!r || !r.ok) {
		item.text = "$(pulse) Claude: ?";
		const failed = (r?.errors || []).map((e) => `- ${e}`).join("\n");
		const lines = ["**Could not load Claude limits**", "", ...failed.split("\n").filter(Boolean)];
		appendChatGpt(lines);
		item.tooltip = new vscode.MarkdownString(
			cfg().showChatGpt && lastChat
				? lines.join("\n")
				: "**Could not load Claude limits**\n\n" + failed,
		);
		item.backgroundColor = undefined;
		return;
	}
	const u = r.usage;
	const stale = !r.live;
	item.text = `$(pulse) 5h ${pct(u.fiveHour)} · wk ${pct(u.sevenDay)}${stale ? " $(history)" : ""}`;

	const pace = weeklyPace(u.sevenDay);
	const five = fiveHourPace(u.fiveHour);
	const alert = !!(pace?.alert || five?.alert);
	const lines = [
		`Updated ${ago(r.updatedAt)}${stale ? " (last request failed)" : ""}`,
		"",
		"**Claude**",
		`- 5h: **${pct(u.fiveHour)}**${fmtReset(u.fiveHour?.resetsAt)}${five?.over ? " — **≥80%**" : ""}`,
		`- Week: **${pct(u.sevenDay)}**${fmtReset(u.sevenDay?.resetsAt)}${pace?.over ? ` — **above the ${pace.limit}% pace**` : ""}`,
	];
	if (u.sevenDayOpus) lines.push(`- Opus: **${pct(u.sevenDayOpus)}**${fmtReset(u.sevenDayOpus.resetsAt)}`);
	if (u.sevenDaySonnet) lines.push(`- Sonnet: **${pct(u.sevenDaySonnet)}**${fmtReset(u.sevenDaySonnet.resetsAt)}`);
	if (alert) lines.push("", "Click to acknowledge");
	appendChatGpt(lines);
	item.tooltip = new vscode.MarkdownString(lines.join("\n"));

	item.backgroundColor = alert ? new vscode.ThemeColor("statusBarItem.errorBackground") : undefined;
}

async function onClick() {
	const u = last?.ok ? last.usage : undefined;
	if (u && (weeklyPace(u.sevenDay)?.alert || fiveHourPace(u.fiveHour)?.alert)) await acknowledge();
	else await menu();
}

async function refresh() {
	item.text = last?.ok ? item.text.replace("$(pulse)", "$(sync~spin)") : "$(sync~spin) Claude";
	const chatP = cfg().showChatGpt ? loadChatGpt() : null;
	try {
		const opts = cfg().opts;
		const key = await secrets.get(SECRET_KEY);
		if (key) opts.remoteApiKey = key;
		const r = await getUsage(opts);
		for (const e of r.errors || []) log.appendLine(`[${new Date().toLocaleTimeString()}] ${e}`);
		if (r.ok) log.appendLine(`[${new Date().toLocaleTimeString()}] ok via ${r.source}: ${JSON.stringify(r.usage)}`);
		// If this attempt failed but earlier data exists, keep showing it as stale
		if (!r.ok && last?.ok) {
			last = { ...last, live: false, errors: r.errors };
		} else {
			last = r;
		}
	} catch (err) {
		log.appendLine(`[error] ${err?.stack || err}`);
		last = last?.ok ? { ...last, live: false } : { ok: false, errors: [String(err?.message || err)] };
	}
	render(last);
	if (chatP) {
		lastChat = await chatP;
		render(last);
	} else {
		lastChat = undefined;
	}
}

async function loadChatGpt() {
	try {
		const r = await getChatGptUsage(cfg().opts);
		for (const e of r.errors || []) log.appendLine(`[${new Date().toLocaleTimeString()}] chatgpt ${e}`);
		if (r.ok) {
			const bits = (r.windows || []).map((w) => `${w.seconds || "?"}:${Math.round(w.percent)}%`).join(" ");
			log.appendLine(
				`[${new Date().toLocaleTimeString()}] chatgpt ok via ${r.source} ${r.plan || ""} ${bits}`.replace(/\s+/g, " ").trim(),
			);
		}
		if (!r.ok && lastChat?.ok) return { ...lastChat, live: false, errors: r.errors };
		return r;
	} catch (err) {
		log.appendLine(`[error] chatgpt ${err?.message || err}`);
		if (lastChat?.ok) return { ...lastChat, live: false, errors: [String(err?.message || err)] };
		return { ok: false, errors: [String(err?.message || err)] };
	}
}

function schedule() {
	if (timer) clearInterval(timer);
	timer = setInterval(() => void refresh(), cfg().intervalMin * 60 * 1000);
}

function diagnostics() {
	const r = last || {};
	const { remoteApiKey, ...opts } = cfg().opts;
	const lines = [
		`time: ${new Date().toISOString()}`,
		`ok: ${!!r.ok} source: ${r.source || "-"} live: ${!!r.live}`,
		`usage: ${JSON.stringify(r.usage || null)}`,
		`settings: ${JSON.stringify(opts)}`,
		"errors:",
		...(r.errors || []).map((e) => `  - ${e}`),
	];
	if (cfg().showChatGpt) {
		const g = lastChat || {};
		const safe = g.ok ? { plan: g.plan, windows: g.windows, source: g.source, live: g.live } : null;
		lines.push(
			`chatgpt ok: ${!!g.ok} source: ${g.source || "-"} live: ${!!g.live}`,
			`chatgpt: ${JSON.stringify(safe)}`,
			"chatgpt errors:",
			...(g.errors || []).map((e) => `  - ${e}`),
		);
	}
	return lines.join("\n");
}

async function configureUngate() {
	const url = await vscode.window.showInputBox({
		title: "Claude Usage (step 1 of 2): Ungate address",
		prompt: "Cloudflare tunnel URL — the same value as Cursor → Settings → Models → Override OpenAI Base URL. Leave empty to turn remote mode off.",
		placeHolder: "https://xxxx.trycloudflare.com",
		value: ungateUrl(),
		ignoreFocusOut: true,
	});
	if (url === undefined) return;
	await globalState.update(URL_STATE_KEY, url.trim());
	if (!url.trim()) {
		await refresh();
		return;
	}
	const key = await vscode.window.showInputBox({
		title: "Claude Usage (step 2 of 2): Ungate API key",
		prompt: "The same key as Cursor → Settings → Models → OpenAI API Key, if Ungate has an api_key. Leave empty to clear the key. Esc keeps the current key.",
		password: true,
		ignoreFocusOut: true,
	});
	if (key !== undefined) {
		if (key.trim()) await secrets.store(SECRET_KEY, key.trim());
		else await secrets.delete(SECRET_KEY);
	}
	await refresh();
}

async function menu() {
	const pick = await vscode.window.showQuickPick(
		[
			{ label: "$(sync) Refresh now", id: "refresh" },
			{ label: "$(copy) Copy diagnostics", id: "copy" },
			{ label: "$(output) Open log", id: "log" },
			{ label: "$(gear) Configure remote Ungate (URL and key)", id: "cfg" },
		],
		{ title: "Claude Usage" },
	);
	if (!pick) return;
	if (pick.id === "refresh") await refresh();
	if (pick.id === "copy") {
		await vscode.env.clipboard.writeText(diagnostics());
		vscode.window.showInformationMessage("Claude Usage diagnostics copied.");
	}
	if (pick.id === "log") log.show();
	if (pick.id === "cfg") await configureUngate();
}

async function activate(context) {
	secrets = context.secrets;
	globalState = context.globalState;
	log = vscode.window.createOutputChannel("Claude Usage");
	item = vscode.window.createStatusBarItem("claudeUsageIndicator", vscode.StatusBarAlignment.Right, 101);
	item.name = "Claude Usage";
	item.command = "claudeUsageIndicator.click";
	item.show();

	context.subscriptions.push(
		log,
		item,
		vscode.commands.registerCommand("claudeUsageIndicator.refresh", refresh),
		vscode.commands.registerCommand("claudeUsageIndicator.menu", menu),
		vscode.commands.registerCommand("claudeUsageIndicator.click", onClick),
		vscode.commands.registerCommand("claudeUsageIndicator.configureUngate", configureUngate),
		vscode.commands.registerCommand("claudeUsageIndicator.copyDiagnostics", async () => {
			await vscode.env.clipboard.writeText(diagnostics());
			vscode.window.showInformationMessage("Claude Usage diagnostics copied.");
		}),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("claudeUsageIndicator")) {
				schedule();
				void refresh();
			}
		}),
		{ dispose: () => timer && clearInterval(timer) },
	);

	schedule();
	await refresh();
}

function deactivate() {
	if (timer) clearInterval(timer);
}

module.exports = { activate, deactivate };
