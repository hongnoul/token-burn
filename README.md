# token burn 🔥

A GitHub-contributions-style dashboard of the tokens your coding agents burn
every day. Local logs → static JSON → any static host. **Zero dependencies,
no backend, no cloud, no accounts.**

**Live example:** <https://hongnoul.github.io/token-burn/>

A commit graph counts keystrokes you made. This counts the work your agents
did.

## How it works

```
your machine                     your repo                    the internet
┌──────────────────┐   export   ┌──────────────────┐  Pages  ┌─────────────┐
│ agent session    │ ─────────> │ data/tokens.json │ ──────> │ dashboard   │
│ logs (~/.jcode,  │            │ data/thumb.svg   │         │ at your URL │
│ ~/.claude, ...)  │  git push  │ index.html       │         │             │
└──────────────────┘            └──────────────────┘         └─────────────┘
```

- `token-burn export` parses local agent logs and writes `data/tokens.json`,
  a few hundred bytes of **dates and counts only**. No prompts, no code, no
  conversation content ever leaves your machine.
- It also renders `data/thumb.svg`, a live card (mini heatmap + today's
  number) you can embed anywhere an image goes: portfolio, README, socials.
- `index.html` is a self-contained dashboard (light/dark, tooltips, per-day
  table) that fetches the JSON. Serve it from GitHub Pages or any static host.

## Quick start

```sh
# 1. fork or use this template, then clone
git clone https://github.com/YOU/token-burn && cd token-burn

# 2. export your data (auto-detects installed agents)
node bin/token-burn.mjs export

# 3. publish
git add data && git commit -m "tokens" && git push
# enable GitHub Pages: Settings → Pages → deploy from branch → main, / (root)
```

Your dashboard is live at `https://YOU.github.io/token-burn/`.

## Sources

| source        | reads                       | notes                                   |
|---------------|-----------------------------|-----------------------------------------|
| `jcode`       | `~/.jcode/sessions/*.json`  | per-message `token_usage`               |
| `claude-code` | `~/.claude/projects/**.jsonl` | dedups streamed usage lines by message id |

```sh
node bin/token-burn.mjs sources            # what's detected on this machine
node bin/token-burn.mjs export --source jcode   # restrict sources
```

Adding an adapter is a small object in `bin/token-burn.mjs` with `detect()`
and `scan()` returning `{ "YYYY-MM-DD": [input, output, cacheRead, cacheWrite] }`.
PRs for Codex, Cursor, OpenCode, Gemini CLI etc. are welcome.

## Keeping it fresh

Any scheduler works. The whole update is: export, commit, push.

**systemd (Linux):**

```ini
# ~/.config/systemd/user/token-burn.service
[Unit]
Description=Publish token burn data

[Service]
Type=oneshot
WorkingDirectory=%h/git/token-burn
ExecStart=/bin/bash -lc 'node bin/token-burn.mjs export && git add data && (git diff --cached --quiet || (git commit -m "tokens: daily refresh" && git push))'

# ~/.config/systemd/user/token-burn.timer
[Unit]
Description=Daily token burn publish

[Timer]
OnCalendar=*-*-* 23:50
Persistent=true

[Install]
WantedBy=timers.target
```

```sh
systemctl --user enable --now token-burn.timer
```

**cron (anywhere):**

```
50 23 * * * cd ~/git/token-burn && node bin/token-burn.mjs export && git add data && git commit -m "tokens: daily refresh" && git push
```

## Embedding the card

The SVG regenerates on every export, so it is always current:

```html
<a href="https://github.com/YOU/token-burn">
  <img src="https://YOU.github.io/token-burn/data/thumb.svg" alt="tokens burned" width="480">
</a>
```

Works in GitHub READMEs too.

## Data format

```json
{
  "updated": "2026-07-23T01:29:56.360Z",
  "sources": ["jcode", "claude-code"],
  "fields": ["input", "output", "cache_read", "cache_write"],
  "days": { "2026-07-22": [27278716, 4111514, 1010290399, 13867827] }
}
```

## Prior art

[claude-count-tokens](https://github.com/vitoriarlima/claude-count-tokens)
(embeddable widget, cloud sync via Supabase),
[tokenviz](https://github.com/harshkedia177/tokenviz) (terminal heatmap),
[AgentLimits](https://github.com/Nihondo/AgentLimits) (macOS widgets).
token-burn's niche: the no-cloud variant, where your own git repo is the
database and the host.

## License

MIT
