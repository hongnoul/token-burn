#!/usr/bin/env node
/* token-burn: aggregate the tokens your coding agents burn into a static
 * daily-counts JSON (plus an SVG card), ready to publish on any static host.
 *
 * Zero dependencies. Node 18+.
 *
 *   token-burn export [--out data/tokens.json] [--svg data/thumb.svg]
 *                     [--source jcode,claude-code] [--quiet]
 *   token-burn sources          # list detected sources on this machine
 *
 * Adapters read local agent logs and emit {isoDate: [input, output,
 * cacheRead, cacheWrite]} buckets. Only dates and counts are exported,
 * never prompts, code, or conversation content.
 */
import { readdir, readFile, writeFile, mkdir, stat, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";

const FIELDS = ["input", "output", "cache_read", "cache_write"];

/* ---------- helpers ---------- */

const localDay = (ts) => {
  const d = new Date(ts);
  if (isNaN(d)) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const human = (n) =>
  n >= 1e9 ? (n / 1e9).toFixed(2) + "B"
  : n >= 1e6 ? (n / 1e6).toFixed(1) + "M"
  : n >= 1e3 ? (n / 1e3).toFixed(1) + "k"
  : String(n);

const addTo = (days, day, vals) => {
  const b = (days[day] ??= [0, 0, 0, 0]);
  for (let i = 0; i < 4; i++) b[i] += vals[i] || 0;
};

async function* walkFiles(dir, ext) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(p, ext);
    else if (e.isFile() && e.name.endsWith(ext)) yield p;
  }
}

/* ---------- adapters ----------
 * Each adapter: { name, detect() -> bool, scan(cache) -> days }
 * Scans are mtime-cached per file in ~/.cache/token-burn.json so daily
 * re-exports only re-parse sessions that changed. */

const jcodeAdapter = {
  name: "jcode",
  dir: join(homedir(), ".jcode", "sessions"),
  async detect() {
    return (await readdir(this.dir).catch(() => [])).length > 0;
  },
  async scan(cache) {
    const days = {};
    for (const name of await readdir(this.dir).catch(() => [])) {
      if (!name.endsWith(".json")) continue;
      const path = join(this.dir, name);
      const fileDays = await cachedScan(cache, path, async () => {
        const out = {};
        const data = JSON.parse(await readFile(path, "utf8"));
        for (const msg of data.messages ?? []) {
          const u = msg.token_usage;
          const day = u && localDay(msg.timestamp ?? "");
          if (!day) continue;
          addTo(out, day, [
            u.input_tokens, u.output_tokens,
            u.cache_read_input_tokens, u.cache_creation_input_tokens,
          ]);
        }
        return out;
      });
      for (const [d, v] of Object.entries(fileDays)) addTo(days, d, v);
    }
    return days;
  },
};

const claudeCodeAdapter = {
  name: "claude-code",
  dir: join(homedir(), ".claude", "projects"),
  async detect() {
    return (await readdir(this.dir).catch(() => [])).length > 0;
  },
  async scan(cache) {
    const days = {};
    for await (const path of walkFiles(this.dir, ".jsonl")) {
      const fileDays = await cachedScan(cache, path, async () => {
        const out = {};
        const seen = new Set(); // streaming duplicates share a message id
        for (const line of (await readFile(path, "utf8")).split("\n")) {
          if (!line.includes('"usage"')) continue;
          let d;
          try { d = JSON.parse(line); } catch { continue; }
          const m = d.message;
          const u = m && typeof m === "object" ? m.usage : null;
          if (!u) continue;
          const key = m.id || d.requestId || d.uuid;
          if (key && seen.has(key)) continue;
          if (key) seen.add(key);
          const day = localDay(d.timestamp ?? "");
          if (!day) continue;
          addTo(out, day, [
            u.input_tokens, u.output_tokens,
            u.cache_read_input_tokens, u.cache_creation_input_tokens,
          ]);
        }
        return out;
      });
      for (const [d, v] of Object.entries(fileDays)) addTo(days, d, v);
    }
    return days;
  },
};

const ADAPTERS = [jcodeAdapter, claudeCodeAdapter];

/* per-file mtime cache */
async function cachedScan(cache, path, parse) {
  let mtime;
  try {
    mtime = (await stat(path)).mtimeMs;
  } catch {
    return {};
  }
  const hit = cache.files[path];
  if (hit && hit.mtime === mtime) return hit.days;
  let days = {};
  try {
    days = await parse();
  } catch {
    return {}; // unreadable or mid-write: retry next run
  }
  cache.files[path] = { mtime, days };
  cache.dirty = true;
  return days;
}

/* ---------- SVG card ---------- */

function renderSvg(days, sorted) {
  const dayTotal = (d) => (days[d] ?? [0, 0, 0, 0]).reduce((a, b) => a + b, 0);
  const total = sorted.reduce((a, d) => a + dayTotal(d), 0);
  const W = 1980, H = 1080;
  const RAMP = ["#232323", "#5a2018", "#a03322", "#e0492d", "#ff2400"];
  const CELL = 88, GAP = 22, STEP = CELL + GAP;
  const COLS = 14, ROWS = 4; // last 8 weeks, newest bottom-right
  const x0 = (W - (COLS * STEP - GAP)) / 2, y0 = 150;

  const end = new Date(); end.setHours(0, 0, 0, 0);
  const max = Math.max(1, ...sorted.map(dayTotal));
  const level = (v) =>
    v <= 0 ? 0 : 1 + Math.min(3, Math.floor((Math.log(v + 1) / Math.log(max + 1)) * 4));

  let cells = "";
  for (let i = COLS * ROWS - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setDate(d.getDate() - i);
    const idx = COLS * ROWS - 1 - i;
    const c = Math.floor(idx / ROWS), r = idx % ROWS;
    cells += `<rect x="${x0 + c * STEP}" y="${y0 + r * STEP}" width="${CELL}" height="${CELL}" rx="16" fill="${RAMP[level(dayTotal(localDay(d.toISOString())))]}"/>`;
  }

  const today = localDay(new Date().toISOString());
  const latest = days[today] ? today : sorted[sorted.length - 1];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="system-ui, sans-serif">
<rect width="${W}" height="${H}" fill="#111111"/>
${cells}
<text x="${x0}" y="${y0 + ROWS * STEP + 150}" font-size="150" font-weight="600" fill="#ff2400">\u{1f525} ${human(dayTotal(latest))}</text>
<text x="${x0}" y="${y0 + ROWS * STEP + 240}" font-size="56" fill="#9a9a9a">tokens burned ${latest === today ? "today" : "on " + latest} \u00b7 ${human(total)} all-time</text>
</svg>\n`;
}

/* ---------- commands ---------- */

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) args[a.slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[++i];
    else args._.push(a);
  }
  return args;
}

async function detectSources() {
  const found = [];
  for (const a of ADAPTERS) if (await a.detect()) found.push(a);
  return found;
}

async function cmdSources() {
  for (const a of ADAPTERS) {
    const ok = await a.detect();
    console.log(`${ok ? "\u2713" : "\u2717"} ${a.name.padEnd(12)} ${a.dir}`);
  }
}

async function cmdExport(args) {
  const outPath = resolve(args.out || "data/tokens.json");
  const svgPath = args.svg === true || args.svg === undefined
    ? join(dirname(outPath), "thumb.svg")
    : args.svg === "none" ? null : resolve(args.svg);

  const wanted = args.source ? String(args.source).split(",") : null;
  let adapters = wanted
    ? ADAPTERS.filter((a) => wanted.includes(a.name))
    : await detectSources();
  if (wanted && adapters.length !== wanted.length) {
    const known = ADAPTERS.map((a) => a.name).join(", ");
    console.error(`unknown source in --source; known: ${known}`);
    process.exit(1);
  }
  if (!adapters.length) {
    console.error("no token sources found (tried: " + ADAPTERS.map((a) => a.name).join(", ") + ")");
    process.exit(1);
  }

  const cachePath = join(homedir(), ".cache", "token-burn.json");
  const cache = { files: {}, dirty: false };
  try {
    cache.files = JSON.parse(await readFile(cachePath, "utf8")).files ?? {};
  } catch {}

  const days = {};
  const perSource = {};
  for (const a of adapters) {
    const d = await a.scan(cache);
    perSource[a.name] = Object.values(d).reduce((s, v) => s + v.reduce((x, y) => x + y, 0), 0);
    for (const [day, vals] of Object.entries(d)) addTo(days, day, vals);
  }

  if (cache.dirty) {
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath + ".tmp", JSON.stringify({ files: cache.files }));
    await rename(cachePath + ".tmp", cachePath);
  }

  const sorted = Object.keys(days).sort();
  const out = {
    updated: new Date().toISOString(),
    sources: adapters.map((a) => a.name),
    fields: FIELDS,
    days: Object.fromEntries(sorted.map((d) => [d, days[d]])),
  };

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath + ".tmp", JSON.stringify(out));
  await rename(outPath + ".tmp", outPath);
  if (svgPath) await writeFile(svgPath, renderSvg(days, sorted));

  if (!args.quiet) {
    const total = Object.values(days).reduce((a, b) => a + b.reduce((x, y) => x + y, 0), 0);
    const bySrc = adapters.map((a) => `${a.name} ${human(perSource[a.name])}`).join(", ");
    console.log(
      `exported ${sorted.length} days (${sorted[0]} \u2192 ${sorted[sorted.length - 1]}), ` +
        `${total.toLocaleString()} tokens (${bySrc}) \u2192 ${outPath}`,
    );
  }
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || "export";
if (cmd === "export") await cmdExport(args);
else if (cmd === "sources") await cmdSources();
else {
  console.error("usage: token-burn [export|sources] [--out FILE] [--svg FILE|none] [--source a,b] [--quiet]");
  process.exit(1);
}
