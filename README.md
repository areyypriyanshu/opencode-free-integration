# OpenCode Free Model Bridge

Use **OpenCode's free models** (DeepSeek, GLM, MiniMax, etc.) as chat models in
DeepSeek Harness — without any API key.

OpenCode, the open-source AI coding agent, serves several **free models** keyless.
This bridge turns OpenCode's CLI into a local OpenAI-compatible server, so a tool
like DeepSeek Harness can call those models like it would any other provider.

```
DeepSeek Harness --OpenAI-compatible/SSE--> bridge (127.0.0.1:4201) --`opencode run`--> OpenCode CLI
```

---

## Installing in DeepSeek Harness (from scratch)

If you just cloned this repo and want the OpenCode free models in **your**
DeepSeek Harness, here's the whole thing, step by step. It takes about 10 minutes.

### 0. What you need

- **OpenCode** installed and running (the CLI is at
  `/Applications/OpenCode.app/Contents/Resources/opencode-cli` on macOS). The
  bridge calls `opencode run`, which talks to OpenCode's background service, so
  that service must be active.
- **Node.js** (any modern LTS).
- DeepSeek Harness, obviously.

### 1. Clone and install the bridge

```bash
git clone https://github.com/areyypriyanshu/opencode-free-integration.git
cd opencode-free-integration
npm install
```

### 2. Start the bridge

```bash
node src/server.mjs
```

It listens on `http://127.0.0.1:4201`. Check it's up:

```bash
curl http://127.0.0.1:4201/v1/models   # should list the free models
```

> **Want it to auto-start at login?** (macOS) Edit
> `launchd/com.user.opencode-model-bridge.plist`, replace every
> `/PATH/TO/opencode-free-integration` with your actual repo path, then:
> ```bash
> cp launchd/com.user.opencode-model-bridge.plist ~/Library/LaunchAgents/
> launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.user.opencode-model-bridge.plist
> ```

### 3. Add a credential placeholder in DeepSeek Harness

Open `~/.dsh/.credentials.yaml` and add one line under `refs:` (the bridge is
keyless, so the value can be anything):

```yaml
refs:
  OPENCODE_BRIDGE_KEY: opencode-bridge-local
```

### 4. Add the model route in DeepSeek Harness

Open `~/.dsh/profiles/desktop/cordis.patch.yml` and add a provider to the
`llm-pi-ai` section. Start with a couple of models — you can add more later from
`/v1/models`:

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      opencode-free:
        apiKeyEnv: OPENCODE_BRIDGE_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:4201/v1
        models:
          - id: opencode/deepseek-v4.1-flash-free
            name: OpenCode DeepSeek V4.1 Flash (free)
            contextWindow: 198000
            maxTokens: 65536
          - id: opencode/glm-5.3-flash-free
            name: OpenCode GLM 5.3 Flash (free)
            contextWindow: 198000
            maxTokens: 65536
```

> **Easier alternative:** in DeepSeek Harness go to **Settings → Models → Add
> provider**, choose an OpenAI-compatible endpoint, set the base URL to
> `http://127.0.0.1:4201/v1`, then pick the free models you want.

### 5. Make it your default model (optional)

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: opencode-free
    model: opencode/deepseek-v4.1-flash-free
```

### 6. Restart DeepSeek Harness

Restart the app so the new route loads. Then, in the model selector, pick
**OpenCode DeepSeek V4.1 Flash (free)** and chat. Done.

---

## How it works

- Each `/v1/chat/completions` request runs `opencode run --model <model> --format json`.
- Streaming (SSE) is supported, with a terminal `finish_reason: "stop"` chunk.
- `/v1/models` returns the **live** list of free models (refreshed every 30 min),
  so new OpenCode models appear without a code change.
- The bridge reuses a **warm session** (`--continue`) so follow-up messages return
  in ~0.5s instead of a 4–10s cold start.

## Requirements

- macOS with Node.js (tested on Node 26; any modern LTS works).
- [OpenCode](https://opencode.ai) installed and its background service running.
- On macOS the CLI is at `/Applications/OpenCode.app/Contents/Resources/opencode-cli`.

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
