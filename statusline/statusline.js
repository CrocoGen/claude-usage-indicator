// Claude Code statusLine script (fallback source for the extension).
// Settings (~/.claude/settings.json):
//   "statusLine": { "type": "command", "command": "node C:/path/to/statusline.js" }
// Reads session JSON from stdin, saves rate_limits to ~/.claude/usage-cache.json,
// prints a short status line.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
	let data = {};
	try {
		data = JSON.parse(input);
	} catch {}
	const rl = data.rate_limits;
	if (rl) {
		try {
			fs.writeFileSync(
				path.join(os.homedir(), ".claude", "usage-cache.json"),
				JSON.stringify({ rate_limits: rl, savedAt: Date.now() }),
			);
		} catch {}
	}
	const p = (w) => (w && typeof w.used_percentage === "number" ? `${Math.round(w.used_percentage)}%` : "—");
	const model = data.model?.display_name ?? "";
	process.stdout.write(`${model} | 5h ${p(rl?.five_hour)} | wk ${p(rl?.seven_day)}`);
});
