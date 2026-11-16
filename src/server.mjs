#!/usr/bin/env node
/**
 * opencode-model-bridge — expose OpenCode's free models to DeepSeek Harness as
 * an OpenAI-compatible chat-completions endpoint, with SSE streaming support.
 *
 * DSH's Models page (llm-pi-ai) points at this server with:
 *   api: openai-completions
 *   baseURL: http://127.0.0.1:PORT/v1
 *   apiKeyEnv: OPENCODE_BRIDGE_KEY   (any non-empty value; the CLI is keyless)
 *   models: [ opencode/deepseek-v4.1-flash-free, ... ]
 *
 * Each /v1/chat/completions request turns into one
 *   opencode run --model <model> --format json <prompt>
 * invocation. The CLI emits a newline-delimited JSON event stream; the bridge
 * maps its `text` events onto either an OpenAI SSE stream (when the request
 * asks for streaming, which DSH does) or a single JSON completion.
 *
 * Environment
 *   PORT            listen port (default 4201)
 *   HOST            bind host (default 127.0.0.1)
 *   OPENCODE_BIN    path to the opencode CLI (defaults to the app bundle binary)
 *   DEFAULT_MODEL   model used when the request omits one (default opencode/deepseek-v4.1-flash-free)
 */

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'

const PORT = Number(process.env.PORT || 4201)
const HOST = process.env.HOST || '127.0.0.1'
const DEFAULT_MODEL =
	process.env.DEFAULT_MODEL || 'opencode/deepseek-v4.1-flash-free'
const OPENCODE_BIN =
	process.env.OPENCODE_BIN ||
	'/Applications/OpenCode.app/Contents/Resources/opencode-cli'

function readBody(request) {
	return new Promise((resolve, reject) => {
		const chunks = []
		let size = 0
		request.on('data', (c) => {
			size += c.length
			if (size > 2 * 1024 * 1024) {
				reject(new Error('body too large'))
				request.destroy()
				return
			}
			chunks.push(c)
		})
		request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
		request.on('error', reject)
	})
}

function json(res, status, payload) {
	const body = JSON.stringify(payload)
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': Buffer.byteLength(body),
		'cache-control': 'no-store',
	})
	res.end(body)
}

/** The last user text message in an OpenAI messages array. */
function lastUserText(body) {
	const messages = Array.isArray(body?.messages) ? body.messages : []
	let text = ''
	for (const m of messages) {
		if (typeof m?.content === 'string') text = m.content
		else if (Array.isArray(m?.content)) {
			const parts = m.content
				.filter((p) => p?.type === 'text' && typeof p.text === 'string')
				.map((p) => p.text)
			if (parts.length) text = parts.join('\n')
		}
	}
	return text
}

/**
 * Run one `opencode run --format json` and feed assistant text chunks to
 * `onText` as the CLI emits them. Resolves on process exit.
 */
/** True once a session has been created; later calls reuse it via --continue. */
let sessionWarmed = false

function runOpencodeStream(model, prompt, onText) {
	return new Promise((resolve, reject) => {
		// After the first call, `--continue` reuses OpenCode's warm session,
		// which drops per-request latency from ~4-10s (cold start) to ~0.4s.
		// The first call creates the session (no --continue yet).
		const args = ['run']
		if (sessionWarmed) args.push('--continue')
		args.push('--model', model, '--format', 'json', prompt)
		const child = spawn(OPENCODE_BIN, args, {
			stdio: ['pipe', 'pipe', 'pipe'],
		})
		child.stdin.end()
		let buf = ''
		let err = ''
		const timer = setTimeout(() => child.kill('SIGKILL'), 240000)

		child.stdout.on('data', (d) => {
			buf += d.toString()
			// The CLI emits newline-delimited JSON events; consume whole lines.
			let nl
			while ((nl = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, nl).trim()
				buf = buf.slice(nl + 1)
				if (!line) continue
				let ev
				try {
					ev = JSON.parse(line)
				} catch {
					continue
				}
				if (ev?.type === 'text' && ev.part?.type === 'text' && typeof ev.part.text === 'string') {
					onText(ev.part.text)
				}
			}
		})
		child.stderr.on('data', (d) => (err += d.toString()))
		child.on('close', (code) => {
			clearTimeout(timer)
			if (code !== 0) {
				reject(new Error(`opencode exited ${code}: ${err.slice(-400) || 'no output'}`))
				return
			}
			// The session now exists; reuse it on the next call.
			sessionWarmed = true
			resolve()
		})
		child.on('error', (e) => {
			clearTimeout(timer)
			reject(e)
		})
	})
}

/** Cache of the live OpenCode model list, refreshed on demand. */
let modelsCache = { at: 0, ids: [] }
const MODELS_TTL = 30 * 60 * 1000

async function fetchModels(force = false) {
	const now = Date.now()
	if (!force && now - modelsCache.at < MODELS_TTL && modelsCache.ids.length > 0) {
		return modelsCache.ids
	}
	try {
		const ids = await new Promise((resolve, reject) => {
			const child = spawn(OPENCODE_BIN, ['models'], { stdio: ['pipe', 'pipe', 'pipe'] })
			child.stdin.end()
			let out = ''
			let err = ''
			child.stdout.on('data', (d) => (out += d.toString()))
			child.stderr.on('data', (d) => (err += d.toString()))
			const timer = setTimeout(() => child.kill('SIGKILL'), 30000)
			child.on('close', (code) => {
				clearTimeout(timer)
				if (code !== 0) {
					reject(new Error(`opencode models exited ${code}: ${err.slice(-200)}`))
					return
				}
				const ids = out
					.split('\n')
					.map((l) => l.trim())
					.filter((l) => l.startsWith('opencode/') && /-free$/.test(l))
				resolve(ids)
			})
			child.on('error', reject)
		})
		if (ids.length > 0) {
			modelsCache = { at: now, ids }
			return ids
		}
	} catch {
		// fall through
	}
	return modelsCache.ids.length > 0 ? modelsCache.ids : [DEFAULT_MODEL]
}

const server = createServer(async (req, res) => {
	try {
		const url = new URL(req.url || '/', `http://${HOST}:${PORT}`)
		if (req.method === 'GET' && url.pathname === '/v1/models') {
			const ids = await fetchModels()
			json(res, 200, {
				object: 'list',
				data: ids.map((id) => ({ id, object: 'model', owned_by: 'opencode' })),
			})
			return
		}
		if (req.method === 'GET' && url.pathname === '/') {
			json(res, 200, { name: 'opencode-model-bridge', models: (await fetchModels()).length })
			return
		}
		if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
			const body = JSON.parse((await readBody(req)) || '{}')
			const prompt = lastUserText(body)
			const model = typeof body?.model === 'string' ? body.model : DEFAULT_MODEL
			if (!prompt) {
				json(res, 400, { error: { message: 'no text message provided', type: 'invalid_request_error' } })
				return
			}
			const id = `opencode-${Date.now()}`
			let text = ''
			const stream = body?.stream === true
			try {
				if (stream) {
					// Start SSE immediately; flush chunks as they arrive.
					res.writeHead(200, {
						'content-type': 'text/event-stream; charset=utf-8',
						'cache-control': 'no-store',
						connection: 'keep-alive',
						'x-accel-buffering': 'no',
					})
					const sse = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
					sse({
						id,
						object: 'chat.completion.chunk',
						created: Math.floor(Date.now() / 1000),
						model,
						choices: [{ index: 0, delta: { role: 'assistant' } }],
					})
					await runOpencodeStream(model, prompt, (chunk) => {
						text += chunk
						sse({
							id,
							object: 'chat.completion.chunk',
							created: Math.floor(Date.now() / 1000),
							model,
							choices: [{ index: 0, delta: { content: chunk } }],
						})
					})
					sse({
						id,
						object: 'chat.completion.chunk',
						created: Math.floor(Date.now() / 1000),
						model,
						choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
					})
					res.end('data: [DONE]\n\n')
				} else {
					await runOpencodeStream(model, prompt, (chunk) => {
						text += chunk
					})
					json(res, 200, {
						id,
						object: 'chat.completion',
						created: Math.floor(Date.now() / 1000),
						model,
						choices: [
							{
								index: 0,
								message: { role: 'assistant', content: text },
								finish_reason: 'stop',
							},
						],
						usage: {
							prompt_tokens: 0,
							completion_tokens: 0,
							total_tokens: 0,
						},
					})
				}
			} catch (error) {
				if (res.writableEnded) return
				json(res, 502, { error: { message: String(error), type: 'upstream_error' } })
			}
			return
		}
		json(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } })
	} catch (error) {
		json(res, 400, { error: { message: String(error), type: 'invalid_request_error' } })
	}
})

server.listen(PORT, HOST, () => {
	console.error(`[opencode-bridge] listening on http://${HOST}:${PORT}`)
})