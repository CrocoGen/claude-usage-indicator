// Core logic without the vscode dependency, so it can be tested from the CLI:
//   node src/usage.js
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);

let nodeSqlite;
try {
	nodeSqlite = require("node:sqlite");
} catch {
	nodeSqlite = undefined;
}

const HOME = os.homedir();
const DEFAULTS = {
	ungateDir: path.join(HOME, ".ungate"),
	claudeCredentials: path.join(HOME, ".claude", ".credentials.json"),
	statuslineCache: path.join(HOME, ".claude", "usage-cache.json"),
	codexAuth: path.join(HOME, ".codex", "auth.json"),
};

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_QUERY =
	"SELECT access_token, expires_at FROM provider_settings WHERE provider = 'claude' LIMIT 1;";

// ---------- Token sources ----------

async function tokenFromUngate(ungateDir) {
	const dbPath = path.join(ungateDir, "data.db");
	if (!fs.existsSync(dbPath)) throw new Error(`not found: ${dbPath}`);

	if (nodeSqlite) {
		try {
			const db = new nodeSqlite.DatabaseSync(dbPath, { readOnly: true });
			try {
				const row = db.prepare(TOKEN_QUERY).get();
				if (!row) throw new Error("no claude row in provider_settings");
				return { token: row.access_token, expiresAt: Number(row.expires_at) || undefined };
			} finally {
				db.close();
			}
		} catch (err) {
			if (/no claude row/.test(err.message)) throw err;
			// fall through to CLI
		}
	}

	const candidates = [path.join(ungateDir, "bin", "sqlite3.exe"), "sqlite3"];
	for (const exe of candidates) {
		try {
			const { stdout } = await execFileAsync(
				exe,
				["-readonly", "-separator", "\t", dbPath, TOKEN_QUERY],
				{ windowsHide: true },
			);
			const line = stdout.trim();
			if (!line) throw new Error("no claude row in provider_settings");
			const [token, expires] = line.split("\t");
			return { token, expiresAt: Number(expires) || undefined };
		} catch (err) {
			if (/no claude row/.test(err.message)) throw err;
		}
	}
	throw new Error("cannot read Ungate DB (node:sqlite and sqlite3 unavailable)");
}

function tokenFromClaudeCode(credentialsPath) {
	const raw = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
	const o = raw.claudeAiOauth;
	if (!o || !o.accessToken) throw new Error("no claudeAiOauth.accessToken");
	return { token: o.accessToken, expiresAt: o.expiresAt };
}

// ---------- Usage fetch ----------

function normalizeWindow(w) {
	if (!w || typeof w !== "object") return undefined;
	const pct = w.utilization ?? w.used_percentage ?? w.usedPercentage;
	if (typeof pct !== "number") return undefined;
	let resetsAt = w.resets_at ?? w.resetsAt;
	if (typeof resetsAt === "number") resetsAt = new Date(resetsAt < 1e12 ? resetsAt * 1000 : resetsAt);
	else if (typeof resetsAt === "string") resetsAt = new Date(resetsAt);
	return { percent: pct, resetsAt: resetsAt && !isNaN(resetsAt) ? resetsAt : undefined };
}

function normalize(data) {
	return {
		fiveHour: normalizeWindow(data.five_hour),
		sevenDay: normalizeWindow(data.seven_day),
		sevenDayOpus: normalizeWindow(data.seven_day_opus),
		sevenDaySonnet: normalizeWindow(data.seven_day_sonnet),
	};
}

async function fetchUsage(token) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), 15000);
	try {
		const res = await fetch(USAGE_URL, {
			method: "GET",
			signal: ctrl.signal,
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${token}`,
				"anthropic-beta": "oauth-2025-04-20",
				"User-Agent": "claude-cli/2.1.257 (external, cli)",
			},
		});
		const text = await res.text();
		if (!res.ok) {
			const err = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
			err.status = res.status;
			throw err;
		}
		return { raw: JSON.parse(text), usage: normalize(JSON.parse(text)) };
	} finally {
		clearTimeout(timer);
	}
}

// ---------- Remote Ungate (via rate-limit response headers) ----------

function headerWindow(h, key) {
	const util = h.get(`anthropic-ratelimit-unified-${key}-utilization`);
	if (util == null) return undefined;
	const reset = h.get(`anthropic-ratelimit-unified-${key}-reset`);
	const n = Number(util);
	return {
		percent: n * 100, // header value is a fraction 0..1
		resetsAt: reset ? new Date(Number(reset) * 1000) : undefined,
	};
}

async function usageFromRemoteUngate(baseUrl, apiKey, model) {
	const url = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1/messages";
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), 30000);
	try {
		const headers = {
			"Content-Type": "application/json",
			"anthropic-version": "2023-06-01",
		};
		if (apiKey) {
			headers.Authorization = `Bearer ${apiKey}`;
			headers["x-api-key"] = apiKey;
		}
		const res = await fetch(url, {
			method: "POST",
			signal: ctrl.signal,
			headers,
			body: JSON.stringify({
				model,
				max_tokens: 1,
				messages: [{ role: "user", content: "." }],
			}),
		});
		const h = res.headers;
		await res.text().catch(() => "");
		const usage = {
			fiveHour: headerWindow(h, "5h"),
			sevenDay: headerWindow(h, "7d"),
			sevenDayOpus: headerWindow(h, "7d_opus"),
			sevenDaySonnet: headerWindow(h, "7d_sonnet"),
		};
		if (!usage.fiveHour && !usage.sevenDay) {
			throw new Error(`HTTP ${res.status}, rate-limit headers missing (${url})`);
		}
		return usage;
	} finally {
		clearTimeout(timer);
	}
}

// ---------- Statusline cache fallback ----------

function usageFromStatuslineCache(cachePath) {
	const stat = fs.statSync(cachePath);
	const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
	const rl = raw.rate_limits || raw;
	return {
		usage: normalize(rl),
		updatedAt: stat.mtime,
	};
}

// ---------- Orchestrator ----------

/**
 * Tries the sources in order and returns the first success.
 * The result never contains the token.
 */
async function getUsage(opts = {}) {
	const o = { ...DEFAULTS, ...opts };
	const errors = [];

	if (o.remoteUrl) {
		try {
			const usage = await usageFromRemoteUngate(o.remoteUrl, o.remoteApiKey, o.remoteModel || "claude-haiku-4-5");
			return { ok: true, source: "Ungate (remote)", live: true, updatedAt: new Date(), usage, errors };
		} catch (err) {
			errors.push(`Ungate remote: ${err.name === "AbortError" ? "timeout" : err.message}`);
		}
	}

	const tokenSources = [
		["Ungate", () => tokenFromUngate(o.ungateDir)],
		["Claude Code", () => tokenFromClaudeCode(o.claudeCredentials)],
	];

	for (const [name, getToken] of tokenSources) {
		let t;
		try {
			t = await getToken();
		} catch (err) {
			errors.push(`${name}: ${err.message}`);
			continue;
		}
		if (t.expiresAt && Date.now() >= t.expiresAt) {
			errors.push(`${name}: token expired ${new Date(t.expiresAt).toLocaleString()}`);
			continue;
		}
		try {
			const { usage, raw } = await fetchUsage(t.token);
			return { ok: true, source: name, live: true, updatedAt: new Date(), usage, raw, errors };
		} catch (err) {
			errors.push(`${name}: ${err.message}`);
		}
	}

	try {
		const { usage, updatedAt } = usageFromStatuslineCache(o.statuslineCache);
		return { ok: true, source: "statusline cache", live: false, updatedAt, usage, errors };
	} catch (err) {
		errors.push(`statusline cache: ${err.message}`);
	}

	return { ok: false, errors };
}

// ---------- ChatGPT (Codex /wham/usage) ----------

const CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const OPENAI_TOKEN_QUERY =
	"SELECT access_token, expires_at, account_id FROM provider_settings WHERE provider = 'openai' LIMIT 1;";

function jwtPayload(token) {
	const part = String(token).split(".")[1];
	if (!part) return undefined;
	return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

function jwtExpiryMs(token) {
	try {
		const exp = jwtPayload(token)?.exp;
		return typeof exp === "number" ? exp * 1000 : undefined;
	} catch {
		return undefined;
	}
}

function accountIdFromJwt(token) {
	try {
		const id = jwtPayload(token)?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		return typeof id === "string" && id ? id : undefined;
	} catch {
		return undefined;
	}
}

function expiryMs(explicit, token) {
	const n = Number(explicit);
	if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
	return jwtExpiryMs(token);
}

async function tokenFromUngateOpenAI(ungateDir) {
	const dbPath = path.join(ungateDir, "data.db");
	if (!fs.existsSync(dbPath)) throw new Error(`not found: ${dbPath}`);

	const pack = (token, expires, accountId) => {
		if (!token) throw new Error("no openai row in provider_settings");
		return {
			token,
			expiresAt: expiryMs(expires, token),
			accountId: accountId || accountIdFromJwt(token),
		};
	};

	if (nodeSqlite) {
		try {
			const db = new nodeSqlite.DatabaseSync(dbPath, { readOnly: true });
			try {
				const row = db.prepare(OPENAI_TOKEN_QUERY).get();
				if (!row) throw new Error("no openai row in provider_settings");
				return pack(row.access_token, row.expires_at, row.account_id);
			} finally {
				db.close();
			}
		} catch (err) {
			if (/no openai row/.test(err.message)) throw err;
		}
	}

	const candidates = [path.join(ungateDir, "bin", "sqlite3.exe"), "sqlite3"];
	for (const exe of candidates) {
		try {
			const { stdout } = await execFileAsync(
				exe,
				["-readonly", "-separator", "\t", dbPath, OPENAI_TOKEN_QUERY],
				{ windowsHide: true },
			);
			const line = stdout.trim();
			if (!line) throw new Error("no openai row in provider_settings");
			const [token, expires, accountId] = line.split("\t");
			return pack(token, expires, accountId);
		} catch (err) {
			if (/no openai row/.test(err.message)) throw err;
		}
	}
	throw new Error("cannot read Ungate DB (node:sqlite and sqlite3 unavailable)");
}

function tokenFromCodex(authPath) {
	let raw;
	try {
		raw = JSON.parse(fs.readFileSync(authPath, "utf8"));
	} catch (err) {
		if (err.code === "ENOENT") throw new Error(`not found: ${authPath}`);
		throw err;
	}
	const t = raw && raw.tokens;
	if (!t || !t.access_token) throw new Error("no tokens.access_token");
	return {
		token: t.access_token,
		expiresAt: jwtExpiryMs(t.access_token),
		accountId: t.account_id || accountIdFromJwt(t.access_token),
	};
}

function normalizeChatWindow(w) {
	if (!w || typeof w.used_percent !== "number") return undefined;
	let resetsAt;
	if (typeof w.reset_at === "number" && w.reset_at > 0) {
		const d = new Date(w.reset_at * 1000);
		if (!isNaN(d.getTime())) resetsAt = d;
	}
	return {
		seconds: typeof w.limit_window_seconds === "number" ? w.limit_window_seconds : undefined,
		percent: w.used_percent,
		resetsAt,
	};
}

async function fetchChatGptUsage(token, accountId) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), 15000);
	try {
		const headers = {
			Accept: "application/json",
			Authorization: `Bearer ${token}`,
			"User-Agent": "codex_cli_rs/0.0.0 (Windows 10.0.26200; x86_64)",
		};
		if (accountId) headers["ChatGPT-Account-Id"] = accountId;
		const res = await fetch(CHATGPT_USAGE_URL, { method: "GET", signal: ctrl.signal, headers });
		const text = await res.text();
		if (!res.ok) {
			throw new Error(`HTTP ${res.status}: ${text.slice(0, 160).replace(/\s+/g, " ")}`);
		}
		const data = JSON.parse(text);
		const rl = data.rate_limit || {};
		const windows = [rl.primary_window, rl.secondary_window]
			.map(normalizeChatWindow)
			.filter(Boolean)
			.sort((a, b) => (a.seconds || 1e15) - (b.seconds || 1e15));
		if (!windows.length) throw new Error("rate limit windows missing");
		return { plan: typeof data.plan_type === "string" ? data.plan_type : undefined, windows };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * ChatGPT plan limits. Never returns the token.
 * Sources: Ungate provider "openai", then ~/.codex/auth.json. Expired tokens are skipped.
 * Refresh tokens are not used: Codex rotates them itself.
 */
async function getChatGptUsage(opts = {}) {
	const o = { ...DEFAULTS, ...opts };
	const errors = [];
	const sources = [
		["Ungate", () => tokenFromUngateOpenAI(o.ungateDir)],
		["Codex", () => tokenFromCodex(o.codexAuth)],
	];

	for (const [name, getToken] of sources) {
		let t;
		try {
			t = await getToken();
		} catch (err) {
			errors.push(`${name}: ${err.message}`);
			continue;
		}
		if (t.expiresAt && Date.now() >= t.expiresAt) {
			errors.push(`${name}: token expired ${new Date(t.expiresAt).toLocaleString()}`);
			continue;
		}
		try {
			const usage = await fetchChatGptUsage(t.token, t.accountId);
			return { ok: true, source: name, live: true, updatedAt: new Date(), ...usage, errors: [] };
		} catch (err) {
			errors.push(`${name}: ${err.name === "AbortError" ? "timeout" : err.message}`);
		}
	}

	return { ok: false, errors };
}

module.exports = { getUsage, getChatGptUsage, DEFAULTS };

if (require.main === module) {
	// Test: UNGATE_URL=https://... UNGATE_KEY=... node src/usage.js
	getUsage({
		remoteUrl: process.env.UNGATE_URL,
		remoteApiKey: process.env.UNGATE_KEY,
		remoteModel: process.env.UNGATE_MODEL,
	}).then((r) => {
		const { raw, ...safe } = r;
		console.log(JSON.stringify(safe, null, 2));
		if (raw) console.log("raw keys:", Object.keys(raw));
	});
}
