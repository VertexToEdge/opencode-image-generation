/**
 * Image generation over an OpenAI-compatible Responses API (Apache-2.0).
 * Original: https://github.com/VertexToEdge/pi-codex-image-gen
 * Portions adapted for OpenCode configuration, storage, image editing, and validation.
 * See LICENSE and NOTICE for license and attribution details.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { normalizeImageOptions, type ImageInputs, type ImageOptions } from "./image-options.js";

const CONFIG_FILENAME = "image-generation.json";
const DEFAULT_SAVE_MODE = "global";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const SAVE_MODES = ["none", "project", "global", "custom"] as const;
export type SaveMode = (typeof SAVE_MODES)[number];
export type OutputFormat = "png" | "jpeg" | "webp";

export function configDirectory(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
}

export function dataDirectory(): string {
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode");
}

// --- Retry helpers with exponential backoff + jitter ---

function isRetryableStatus(status: number, errorText: string): boolean {
	if ([429, 500, 502, 503, 504].includes(status)) return true;
	return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(errorText);
}

function backoffMs(attempt: number): number {
	const jitter = 0.9 + Math.random() * 0.2;
	return BASE_DELAY_MS * 2 ** (attempt - 1) * jitter;
}

export interface ToolParams extends ImageOptions {
  prompt: string;
  model?: string;
  save?: SaveMode;
  saveDir?: string;
}

// --- Config types ---

export interface ExtensionConfig {
	provider?: string;
	model?: string;
	save?: SaveMode;
	saveDir?: string;
}

interface SaveConfig {
	mode: SaveMode;
	outputDir?: string;
}

interface GeneratedImage {
	id: string;
	status: string;
	result: string;
	revisedPrompt?: string;
}

interface ParsedResponse {
	image?: GeneratedImage;
	text: string[];
	responseId?: string;
	usage?: unknown;
}

type SseEvent =
	| { type: "error"; message?: string; code?: string }
	| { type: "response.failed"; response?: { error?: { message?: string } } }
	| { type: "response.created"; response?: { id?: string } }
	| { type: "response.output_text.delta"; delta?: string }
	| {
			type: "response.output_item.done";
			item?: {
				type?: string;
				id?: string | number;
				status?: string;
				result?: string;
				revised_prompt?: string;
			};
	  }
	| { type: "response.completed"; response?: { id?: string; usage?: unknown } };

// --- Config loading ---

function readConfigFile(path: string): ExtensionConfig {
	try {
		return JSON.parse(readFileSync(path, "utf8")) ?? {};
	} catch {
		return {};
	}
}

export function loadConfig(cwd: string): ExtensionConfig {
	const globalConfig = readConfigFile(join(configDirectory(), CONFIG_FILENAME));
	const projectConfig = readConfigFile(join(cwd, ".opencode", CONFIG_FILENAME));
	return { ...globalConfig, ...projectConfig };
}

// Append /responses to the configured OpenCode provider base URL.
export function resolveResponsesUrl(baseUrl: string): string {
	if (!baseUrl) {
		throw new Error("The OpenCode provider has no baseURL. Configure provider options.baseURL before using codex_generate_image.");
	}
	return `${baseUrl.replace(/\/+$/, "")}/responses`;
}

// --- Path helpers ---

function resolveUnderCwd(cwd: string, path: string): string {
	const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
	return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function sanitizePathPart(value: string, fallback: string): string {
	const sanitized = value
		.split("")
		.map((ch) => (/[a-zA-Z0-9_-]/.test(ch) ? ch : "_"))
		.join("")
		.replace(/_+$/g, "");
	return sanitized || fallback;
}

export function resolveSaveConfig(params: ToolParams, cwd: string, sessionId: string, config: ExtensionConfig): SaveConfig {
	const envMode = process.env.OPENCODE_IMAGE_SAVE_MODE?.toLowerCase();
	const mode = (params.save || envMode || config.save || DEFAULT_SAVE_MODE) as SaveMode;
	const safeSessionId = sanitizePathPart(sessionId, "session");
	if (!SAVE_MODES.includes(mode)) {
		throw new Error(`Invalid save mode: ${mode}. Expected one of ${SAVE_MODES.join(", ")}.`);
	}
	if (mode === "project") {
		return { mode, outputDir: join(cwd, ".opencode", "generated-images", safeSessionId) };
	}
	if (mode === "global") {
		return { mode, outputDir: join(dataDirectory(), "generated-images", safeSessionId) };
	}
	if (mode === "custom") {
		const configuredDir = params.saveDir || process.env.OPENCODE_IMAGE_SAVE_DIR || config.saveDir;
		if (!configuredDir || !configuredDir.trim()) {
			throw new Error("save=custom requires saveDir or OPENCODE_IMAGE_SAVE_DIR.");
		}
		return { mode, outputDir: join(resolveUnderCwd(cwd, configuredDir), safeSessionId) };
	}
	return { mode };
}

// --- Image save helpers ---

function extensionForFormat(outputFormat: OutputFormat): string {
	return outputFormat === "jpeg" ? "jpg" : outputFormat;
}

export function mimeForFormat(outputFormat: OutputFormat): string {
	return outputFormat === "jpeg" ? "image/jpeg" : `image/${outputFormat}`;
}

export async function saveImage(base64Data: string, outputFormat: OutputFormat, outputDir: string, imageCallId: string): Promise<string> {
	const filename = `${sanitizePathPart(imageCallId, "image_generation")}.${extensionForFormat(outputFormat)}`;
	const filePath = join(outputDir, filename);
	const tempPath = join(outputDir, `.${filename}.${randomUUID()}.tmp`);
	await mkdir(outputDir, { recursive: true });
	try {
		await writeFile(tempPath, Buffer.from(base64Data, "base64"));
		await rename(tempPath, filePath);
	} catch (error) {
		await rm(tempPath, { force: true }).catch(() => {});
		throw error;
	}
	return filePath;
}

// --- Request building ---

function buildRequestBody(params: ToolParams, model: string, outputFormat: OutputFormat, sessionId: string, images: ImageInputs) {
	const options = normalizeImageOptions({ ...params, outputFormat });
	if ((params.referencePaths?.length ?? 0) !== images.references.length || Boolean(params.maskPath) !== Boolean(images.mask)) {
		throw new Error("Image inputs must be loaded and validated before sending the request.");
	}
	return {
		model,
		store: false,
		stream: true, // required: the gateway's /v1/responses only relays cleanly in streaming mode
		prompt_cache_key: sessionId,
		instructions:
			"Generate or edit one bitmap image using image_generation exactly once. " +
			"Honor the requested size, quality, background, and output format. " +
			"For edits, apply only the requested changes and preserve other details. " +
			"The first input image is the base image; additional inputs are references. " +
			"When a mask is supplied, its transparent regions identify the area to edit. " +
			"Do not answer with only text unless image generation is unavailable.",
		input: [
			{
				role: "user",
				content: [
					{ type: "input_text", text: params.prompt },
					...images.references.map((image) => ({ type: "input_image", image_url: image.dataUrl })),
				],
			},
		],
		tools: [{
			type: "image_generation",
			output_format: outputFormat,
			size: options.size,
			quality: options.quality,
			background: options.background,
			action: options.action,
			...(images.mask ? { input_image_mask: { image_url: images.mask.dataUrl } } : {}),
			...(params.outputCompression !== undefined ? { output_compression: params.outputCompression } : {}),
		}],
		tool_choice: "auto",
		parallel_tool_calls: false,
		text: { verbosity: "low" },
	};
}

// --- SSE parsing ---

function parseSseDataLines(chunk: string): string | undefined {
	const data = chunk
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim())
		.join("\n")
		.trim();
	return data && data !== "[DONE]" ? data : undefined;
}

async function parseResponseSse(response: Response, signal?: AbortSignal): Promise<ParsedResponse> {
	if (!response.body) throw new Error("Gateway response did not include a stream body.");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const parsed: ParsedResponse = { text: [] };
	// Cancellation must not hold up saving an image on a gateway that keeps SSE open.
	const cancel = () => { void reader.cancel().catch(() => {}); };
	signal?.addEventListener("abort", cancel, { once: true });
	const consume = (chunk: string): boolean => {
		if (chunk.split("\n").some((line) => line.startsWith("data:") && line.slice(5).trim() === "[DONE]")) return true;
		const data = parseSseDataLines(chunk);
		if (!data) return false;
		const event = JSON.parse(data) as SseEvent;
		handleSseEvent(event, parsed);
		return Boolean(parsed.image) || event.type === "response.completed";
	};
	try {
		while (true) {
			signal?.throwIfAborted();
			const { done, value } = await reader.read();
			signal?.throwIfAborted();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			let separator = /\r?\n\r?\n/.exec(buffer);
			while (separator) {
				const chunk = buffer.slice(0, separator.index);
				buffer = buffer.slice(separator.index + separator[0].length);
				if (consume(chunk)) return parsed;
				separator = /\r?\n\r?\n/.exec(buffer);
			}
		}
		consume(buffer + decoder.decode());
		return parsed;
	} finally {
		signal?.removeEventListener("abort", cancel);
		cancel();
		reader.releaseLock();
	}
}

function handleSseEvent(event: SseEvent, parsed: ParsedResponse): void {
	if (!event || typeof event !== "object") return;

	switch (event.type) {
		case "error": {
			const e = event as Extract<SseEvent, { type: "error" }>;
			throw new Error(`Gateway error: ${e.message || e.code || JSON.stringify(event)}`);
		}
		case "response.failed": {
			const e = event as Extract<SseEvent, { type: "response.failed" }>;
			throw new Error(e.response?.error?.message || "Response failed.");
		}
		case "response.created": {
			const e = event as Extract<SseEvent, { type: "response.created" }>;
			if (typeof e.response?.id === "string") parsed.responseId = e.response.id;
			break;
		}
		case "response.output_text.delta": {
			const e = event as Extract<SseEvent, { type: "response.output_text.delta" }>;
			if (typeof e.delta === "string") parsed.text.push(e.delta);
			break;
		}
		case "response.output_item.done": {
			const e = event as Extract<SseEvent, { type: "response.output_item.done" }>;
			const item = e.item;
			if (item?.type === "image_generation_call") {
				if (typeof item.result !== "string" || item.result.length === 0) {
					throw new Error("image_generation_call did not contain image data.");
				}
				parsed.image = {
					id: String(item.id || "image_generation"),
					status: String(item.status || "completed"),
					result: item.result,
					revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : undefined,
				};
			}
			break;
		}
		case "response.completed": {
			const e = event as Extract<SseEvent, { type: "response.completed" }>;
			if (typeof e.response?.id === "string") parsed.responseId = e.response.id;
			if (e.response?.usage) parsed.usage = e.response.usage;
			break;
		}
	}
}

// --- Gateway call with retry + backoff + jitter ---

export async function requestImage(
	params: ToolParams,
	gatewayUrl: string,
	apiKey: string,
	model: string,
	outputFormat: OutputFormat,
	sessionId: string,
	signal?: AbortSignal,
	images: ImageInputs = { references: [] },
): Promise<ParsedResponse> {
	const body = JSON.stringify(buildRequestBody(params, model, outputFormat, sessionId, images));
	const headers: Record<string, string> = {
		Authorization: `Bearer ${apiKey}`,
		accept: "text/event-stream",
		"content-type": "application/json",
	};

	const controller = new AbortController();
	const abort = () => controller.abort(signal?.reason);
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	const timeout = setTimeout(() => controller.abort(new Error("Gateway image generation timed out after 5 minutes.")), REQUEST_TIMEOUT_MS);
	const requestSignal = controller.signal;
	try {
		for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
			requestSignal.throwIfAborted();
			const response = await fetch(gatewayUrl, { method: "POST", headers, body, signal: requestSignal });
			if (!response.ok) {
				const errorText = await response.text();
				if (attempt <= MAX_RETRIES && isRetryableStatus(response.status, errorText)) {
					await delay(backoffMs(attempt), undefined, { signal: requestSignal });
					continue;
				}
				throw new Error(`Gateway image generation request failed (${response.status}): ${errorText}`);
			}
			return await parseResponseSse(response, requestSignal);
		}
		throw new Error("Gateway image generation request failed after all retries.");
	} catch (error) {
		if (requestSignal.aborted) throw requestSignal.reason;
		const message = error instanceof Error ? error.message : "Image generation request failed.";
		throw new Error(message.split(apiKey).join("[redacted]"));
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", abort);
	}
}
