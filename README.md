# OpenCode Free Model Bridge

Expose **OpenCode's free models** (`opencode/*-free`) to DeepSeek Harness (or any
OpenAI-compatible client) as a local chat-completions endpoint.

OpenCode (the open-source AI coding agent) serves several **free models** keyless
(DeepSeek, GLM, MiniMax, etc.). This bridge turns OpenCode's CLI into an
OpenAI-compatible HTTP server so a tool like DeepSeek Harness can use those
models as chat models.

## How it works

```
DeepSeek Harness --OpenAI-compatible/SSE--> bridge (127.0.0.1:4201) --`opencode run`--> OpenCode CLI
```

- Each `/v1/chat/completions` request runs `opencode run --model <model> --format json`.
- Streaming (SSE) is supported, with a terminal `finish_reason: "stop"` chunk.
- `/v1/models` returns the **live** list of free models (refreshed every 30 min),
  so new OpenCode models appear without a code change.
- The bridge reuses a **warm session** (`--continue`) so follow-up messages return
  in ~0.5s instead of a 4–10s cold start.

## Requirements

- macOS with Node.js (tested on Node 26; any modern LTS works).
- [OpenCode](https://opencode.ai) installed. On macOS the CLI is at
  `/Applications/OpenCode.app/Contents/Resources/opencode-cli`.
- OpenCode's **background service** running (`opencode` app/service active). The
  bridge calls `opencode run`, which talks to that service.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the bridge manually:
   ```bash
   node src/server.mjs
   ```
   It listens on `http://127.0.0.1:4201`. Override with `PORT`, `HOST`,
   `OPENCODE_BIN`, or `DEFAULT_MODEL` env vars.

3. Point your client at it as an OpenAI-compatible endpoint:
   ```
   baseURL: http://127.0.0.1:4201/v1
   api:     openai-completions
   ```
   The bridge is keyless; set any non-empty `apiKeyEnv` value so the client
   resolves the credential reference.

### Launch at login (macOS, launchd)

Edit `launchd/com.user.opencode-model-bridge.plist` and replace every
`/PATH/TO/opencode-free-integration` with the absolute path to this repo, then:

```bash
cp launchd/com.user.opencode-model-bridge.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.user.opencode-model-bridge.plist
```

`RunAtLoad` starts it at login; `KeepAlive` restarts it if it exits.

## Models

The free models are advertised live on `/v1/models`. At the time of writing:

```
opencode/beam-free
opencode/big-pickle
opencode/deepseek-v4.1-flash-free
opencode/flint-40b-free
opencode/glm-5.3-flash-free
opencode/hy4-flash-free
opencode/iceman-free
opencode/inkling-2-small-free
opencode/longcat-2.5-free
opencode/mimo-v2.6-flash-free
opencode/minimax-m3.1-flash-free
opencode/nemotron-3.5-lightning-free
opencode/nemotron-3.5-super-vl-free
```

## Limitations

- The free models have a **usage cap** (OpenCode returns HTTP 429 "Free usage
  limit reached" after heavy use; `retryAfterMs` says when it resets).
- Latency is variable (the free tier is not prioritized).
- The bridge calls `opencode run` per request, so it needs the OpenCode CLI and
  its background service to be running.
- Tool-calling passes through to OpenCode only in the simplest text form; this
  bridge is a chat-completions adapter, not a full tool-use proxy.

## License

MIT
