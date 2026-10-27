import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { after, afterEach, test } from "node:test";

import { GatewayImageGenerationPlugin } from "../dist/plugin.js";
import { requestImage, resolveSaveConfig } from "../dist/image-generation.js";

const moduleFixture = mkdtempSync(join(tmpdir(), "opencode-imagegen-module-"));
after(() => rmSync(moduleFixture, { recursive: true, force: true }));

const PNG = (await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 80, b: 255, alpha: 1 } } }).png().toBuffer()).toString("base64");
const originalFetch = globalThis.fetch;
const originalEnv = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  OPENCODE_IMAGE_SAVE_MODE: process.env.OPENCODE_IMAGE_SAVE_MODE, OPENCODE_IMAGE_SAVE_DIR: process.env.OPENCODE_IMAGE_SAVE_DIR };
const sandboxes = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  for (const path of sandboxes.splice(0)) rmSync(path, { recursive: true, force: true });
});
function imageEvents(base64 = PNG) {
  return [
    { type: "response.created", response: { id: "resp_test" } },
    { type: "response.output_item.done", item: { type: "image_generation_call", id: "image/unsafe", status: "completed", result: base64, revised_prompt: "파란 새" } },
  ];
}
function responseFor(events, { crlf = false, chunks = false, stayOpen = false } = {}) {
  const separator = crlf ? "\r\n\r\n" : "\n\n";
  const raw = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}${separator}`).join(""));
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      if (chunks) for (let i = 0; i < raw.length; i += 7) controller.enqueue(raw.slice(i, i + 7));
      else controller.enqueue(raw);
      if (!stayOpen) controller.close();
    },
    cancel() { cancelled = true; return stayOpen ? new Promise(() => {}) : undefined; },
  });
  return { response: new Response(stream, { headers: { "content-type": "text/event-stream" } }), cancelled: () => cancelled };
}
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "opencode-imagegen-test-"));
  sandboxes.push(dir);
  process.env.XDG_CONFIG_HOME = join(dir, "config");
  process.env.XDG_DATA_HOME = join(dir, "data");
  delete process.env.OPENCODE_IMAGE_SAVE_MODE;
  delete process.env.OPENCODE_IMAGE_SAVE_DIR;
  const configDir = join(process.env.XDG_CONFIG_HOME, "opencode");
  const dataDir = join(process.env.XDG_DATA_HOME, "opencode");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "auth.json"), JSON.stringify({ compatible: { type: "api", key: "dummy-test-key" } }), { mode: 0o600 });
  const calls = [];
  const metadata = [];
  const permissions = [];
  const state = {
    info: { role: "assistant", providerID: "compatible", modelID: "gpt-6.1-sol" },
    config: { model: "compatible/gpt-6-sol", provider: { compatible: { options: { baseURL: "https://mock.invalid/v1/" } } } },
  };
  globalThis.fetch = async (url, request) => {
    calls.push({ url, request, body: JSON.parse(request.body) });
    const format = calls.at(-1).body.tools[0].output_format;
    const fixture = format === "png" ? PNG : (await sharp(Buffer.from(PNG, "base64")).toFormat(format).toBuffer()).toString("base64");
    return responseFor(imageEvents(fixture)).response;
  };
  const hooks = await GatewayImageGenerationPlugin({ client: {
    app: { log: async () => ({}) },
    config: { get: async () => ({ data: state.config }) },
    session: { message: async () => ({ data: { info: state.info } }) },
  } });
  const controller = new AbortController();
  const context = { sessionID: "test-session", messageID: "test-message", directory: dir, worktree: dir,
    abort: controller.signal, metadata: (value) => metadata.push(value),
    ask: async (input) => { permissions.push(input); if (state.denyRead && input.permission === "read") throw new Error("read permission denied"); } };
  const execute = (args) => hooks.tool.codex_generate_image.execute(args, context);
  return { dir, dataDir, configDir, calls, metadata, permissions, state, controller, execute, hooks };
}

test("uses OpenCode authentication and preserves exact image model routes", async () => {
  const h = await setup();
  for (const model of ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]) {
    const result = await h.execute({ prompt: "blue bird", model, save: "none" });
    const call = h.calls.at(-1);
    assert.equal(call.url, "https://mock.invalid/v1/responses");
    assert.equal(call.request.headers.Authorization, "Bearer dummy-test-key");
    assert.equal(call.body.model, model);
    assert.equal(call.body.stream, true);
    assert.equal(call.body.tools[0].type, "image_generation");
    assert.equal(result.attachments[0].mime, "image/png");
    assert.equal(result.attachments[0].url, `data:image/png;base64,${PNG}`);
    assert.doesNotMatch(JSON.stringify(result), /dummy-test-key/);
  }
});

test("defaults to the active chat model and saves atomically under OpenCode global storage", async () => {
  const h = await setup();
  const result = await h.execute({ prompt: "blue bird" });
  assert.equal(h.calls[0].body.model, "gpt-6.1-sol");
  const path = join(h.dataDir, "generated-images", "test-session", "image_unsafe.png");
  assert.equal(result.metadata.savedPath, path);
  assert.deepEqual(readFileSync(path), Buffer.from(PNG, "base64"));
  assert.equal(result.metadata.responseId, "resp_test");
  assert.equal(result.metadata.revisedPrompt, "파란 새");
  assert.equal(h.metadata.length, 2);
});

test("project/custom save modes and JPEG filenames resolve correctly", async () => {
  const h = await setup();
  const project = await h.execute({ prompt: "bird", save: "project", outputFormat: "jpeg" });
  assert.equal(project.metadata.savedPath, join(h.dir, ".opencode", "generated-images", "test-session", "image_unsafe.jpg"));
  assert.equal(project.attachments[0].mime, "image/jpeg");
  const custom = await h.execute({ prompt: "bird", save: "custom", saveDir: "assets", outputFormat: "webp" });
  assert.equal(custom.metadata.savedPath, join(h.dir, "assets", "test-session", "image_unsafe.webp"));
  assert.equal(custom.attachments[0].mime, "image/webp");
});

test("project image preferences override global preferences", async () => {
  const h = await setup();
  writeFileSync(join(h.configDir, "image-generation.json"), JSON.stringify({ save: "global", model: "global-route" }));
  mkdirSync(join(h.dir, ".opencode"));
  writeFileSync(join(h.dir, ".opencode", "image-generation.json"), JSON.stringify({ save: "none", model: "project-route" }));
  const result = await h.execute({ prompt: "bird" });
  assert.equal(h.calls[0].body.model, "project-route");
  assert.equal(result.metadata.saveMode, "none");
  assert.equal(result.metadata.savedPath, undefined);
  assert.equal(existsSync(join(h.dataDir, "generated-images")), false);
});

test("custom save validation and missing credentials fail before consuming quota", async () => {
  const h = await setup();
  await assert.rejects(h.execute({ prompt: "bird", save: "custom" }), /requires saveDir/);
  rmSync(join(h.dataDir, "auth.json"));
  await assert.rejects(h.execute({ prompt: "bird" }), /No API key found/);
  assert.equal(h.calls.length, 0);
});

test("provider options API key takes precedence over stored auth", async () => {
  const h = await setup();
  h.state.config.provider.compatible.options.apiKey = "options-test-key";
  await h.execute({ prompt: "bird", save: "none" });
  assert.equal(h.calls[0].request.headers.Authorization, "Bearer options-test-key");
});

test("SSE parser handles split UTF-8/CRLF and returns before an open stream acknowledges cancellation", async () => {
  const h = await setup();
  const stream = responseFor(imageEvents(), { crlf: true, chunks: true, stayOpen: true });
  globalThis.fetch = async () => stream.response;
  const result = await h.execute({ prompt: "bird", save: "none" });
  assert.equal(result.metadata.revisedPrompt, "파란 새");
  assert.equal(stream.cancelled(), true);
});

test("completed responses without an image fail promptly even if SSE stays open", async () => {
  const h = await setup();
  globalThis.fetch = async () => responseFor([
    { type: "response.output_text.delta", delta: "cannot generate this image" },
    { type: "response.completed", response: { id: "no-image" } },
  ], { stayOpen: true }).response;
  await assert.rejects(h.execute({ prompt: "bird", save: "none" }), /cannot generate this image/);
});

test("upstream SSE errors are reported as tool errors", async () => {
  const h = await setup();
  globalThis.fetch = async () => responseFor([{ type: "response.failed", response: { error: { message: "backend refused" } } }]).response;
  await assert.rejects(h.execute({ prompt: "bird", save: "none" }), /backend refused/);
});

test("rate limiting retries, while nonretryable errors redact API keys", async () => {
  await setup();
  let attempts = 0;
  globalThis.fetch = async () => ++attempts === 1
    ? new Response("rate limited", { status: 429 })
    : responseFor(imageEvents()).response;
  const result = await requestImage({ prompt: "bird" }, "https://mock.invalid/v1/responses", "dummy-test-key", "image-route", "png", "s1");
  assert.equal(attempts, 2);
  assert.ok(result.image);
  globalThis.fetch = async () => new Response("invalid key dummy-test-key", { status: 401 });
  await assert.rejects(
    requestImage({ prompt: "bird" }, "https://mock.invalid/v1/responses", "dummy-test-key", "image-route", "png", "s1"),
    (error) => error.message.includes("[redacted]") && !error.message.includes("dummy-test-key"),
  );
});

test("cancellation before execution makes no request and cancellation during streaming stops promptly", async () => {
  const h = await setup();
  h.controller.abort(new Error("cancelled by user"));
  await assert.rejects(h.execute({ prompt: "bird", save: "none" }), /cancelled by user/);
  assert.equal(h.calls.length, 0);
  const other = await setup();
  globalThis.fetch = async (_url, request) => new Response(new ReadableStream({
    start(controller) { setImmediate(() => other.controller.abort(new Error("stream cancelled"))); },
  }));
  await assert.rejects(other.execute({ prompt: "bird", save: "none" }), /stream cancelled/);
});

test("custom paths expand ~/ and environment save preference is honored", async () => {
  const h = await setup();
  process.env.OPENCODE_IMAGE_SAVE_MODE = "none";
  const result = await h.execute({ prompt: "bird" });
  assert.equal(result.metadata.saveMode, "none");
  delete process.env.OPENCODE_IMAGE_SAVE_MODE;
  const config = resolveSaveConfig({ prompt: "bird", save: "custom", saveDir: "~/Pictures" }, h.dir, "../unsafe", {});
  assert.match(config.outputDir, /\/Pictures\/_+unsafe$/);
});

async function fixtureImage(width, height, alpha = 1, format = "png") {
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 80, b: 255, alpha } } }).toFormat(format).toBuffer();
}

test("custom dimensions, image quality and transparency are structured native options", async () => {
  const h = await setup();
  await h.execute({ prompt: "transparent landscape", model: "gpt-image-2.5-flare", width: 2048, height: 1152, quality: "max", background: "transparent", save: "none" });
  const options = h.calls[0].body.tools[0];
  assert.equal(options.size, "2048x1152");
  assert.equal(options.quality, "max");
  assert.equal(options.background, "transparent");
  assert.equal(options.action, "auto");
  assert.equal(options.output_format, "png");
  assert.equal(h.hooks.tool.codex_generate_image.args.quality.safeParse("xhigh").success, true);
  assert.equal(h.hooks.tool.codex_generate_image.args.quality.safeParse("max").success, true);
});

test("invalid dimension and format combinations fail without an image request", async () => {
  const h = await setup();
  for (const [args, message] of [
    [{ width: 1024 }, /both width and height/],
    [{ width: 1024, height: 1024, size: "auto" }, /either size or width/],
    [{ size: "1920x1080" }, /multiples of 16/],
    [{ size: "four-k" }, /WIDTHxHEIGHT/],
    [{ size: "4096x2160" }, /supported bounds/],
    [{ size: "3840x3840" }, /supported bounds/],
    [{ size: "2048x512" }, /supported bounds/],
    [{ background: "transparent", outputFormat: "jpeg" }, /JPEG has no alpha/],
    [{ outputCompression: 50 }, /omit it for PNG/],
    [{ outputFormat: "webp", outputCompression: 101 }, /between 0 and 100/],
  ]) await assert.rejects(h.execute({ prompt: "bird", ...args }), message);
  assert.equal(h.calls.length, 0);
});

test("portrait, square, 16:9 and automatic dimensions remain valid", async () => {
  const h = await setup();
  for (const size of ["1024x1536", "1536x1024", "1024x1024", "1536x864", "864x1536", "auto"]) {
    await h.execute({ prompt: "bird", size, save: "none" });
    assert.equal(h.calls.at(-1).body.tools[0].size, size);
  }
});

test("reference images and a matching alpha mask are uploaded in native edit fields", async () => {
  const h = await setup();
  writeFileSync(join(h.dir, "base.png"), await fixtureImage(16, 16));
  writeFileSync(join(h.dir, "reference.jpg"), await fixtureImage(32, 16, 1, "jpeg"));
  writeFileSync(join(h.dir, "mask.png"), await fixtureImage(16, 16, 0));
  const result = await h.execute({ prompt: "change only the masked area", referencePaths: ["base.png", "reference.jpg"], maskPath: "mask.png", save: "none" });
  const body = h.calls[0].body;
  assert.equal(body.tools[0].action, "edit");
  assert.match(body.tools[0].input_image_mask.image_url, /^data:image\/png;base64,/);
  assert.equal(body.input[0].content.length, 3);
  assert.match(body.input[0].content[1].image_url, /^data:image\/png;base64,/);
  assert.match(body.input[0].content[2].image_url, /^data:image\/jpeg;base64,/);
  assert.equal(h.permissions.filter((permission) => permission.permission === "read").length, 3);
  assert.deepEqual(result.metadata.referencePaths, [join(h.dir, "base.png"), join(h.dir, "reference.jpg")]);
  assert.equal(result.metadata.maskPath, join(h.dir, "mask.png"));
});

test("edit, mask and reference validation happens before calling the gateway", async () => {
  const h = await setup();
  writeFileSync(join(h.dir, "base.png"), await fixtureImage(16, 16));
  writeFileSync(join(h.dir, "opaque.png"), await fixtureImage(16, 16));
  writeFileSync(join(h.dir, "wrong-size.png"), await fixtureImage(32, 16, 0));
  writeFileSync(join(h.dir, "not-image.png"), "private non-image text");
  const rgb = await sharp({ create: { width: 16, height: 16, channels: 3, background: "white" } }).png().toBuffer();
  writeFileSync(join(h.dir, "no-alpha.png"), rgb);
  for (const [args, message] of [
    [{ action: "edit" }, /require referencePaths/],
    [{ maskPath: "opaque.png" }, /require referencePaths/],
    [{ action: "generate", referencePaths: ["base.png"], maskPath: "opaque.png" }, /requires action=edit/],
    [{ referencePaths: ["base.png"], maskPath: "opaque.png" }, /no transparent pixels/],
    [{ referencePaths: ["base.png"], maskPath: "no-alpha.png" }, /PNG with an alpha channel/],
    [{ referencePaths: ["base.png"], maskPath: "wrong-size.png" }, /dimensions must match/],
    [{ referencePaths: ["not-image.png"] }, /Could not decode image input/],
    [{ referencePaths: Array(17).fill("base.png") }, /At most 16/],
  ]) await assert.rejects(h.execute({ prompt: "edit", save: "none", ...args }), message);
  assert.equal(h.calls.length, 0);
});

test("OpenCode read denials prevent image upload", async () => {
  const h = await setup();
  writeFileSync(join(h.dir, "base.png"), await fixtureImage(16, 16));
  h.state.denyRead = true;
  await assert.rejects(h.execute({ prompt: "edit", action: "edit", referencePaths: ["base.png"] }), /read permission denied/);
  assert.equal(h.calls.length, 0);
});

test("external image inputs ask for directory and read permissions", async () => {
  const h = await setup();
  const outside = join(moduleFixture, "outside.png");
  writeFileSync(outside, await fixtureImage(16, 16));
  await h.execute({ prompt: "edit", action: "edit", referencePaths: [outside], save: "none" });
  assert.equal(h.permissions[0].permission, "external_directory");
  assert.equal(h.permissions[1].permission, "read");
});

test("actual transparent pixels and dimensions are verified from returned image bytes", async () => {
  const h = await setup();
  const transparent = (await fixtureImage(64, 32, 0)).toString("base64");
  globalThis.fetch = async () => responseFor(imageEvents(transparent)).response;
  const result = await h.execute({ prompt: "transparent", size: "64x32", background: "transparent", save: "none" });
  assert.equal(result.metadata.image.width, 64);
  assert.equal(result.metadata.image.height, 32);
  assert.equal(result.metadata.image.hasAlpha, true);
  assert.equal(result.metadata.image.transparent, true);
  assert.deepEqual(result.metadata.warnings, []);
});

test("opaque or incorrectly sized results report warnings without regenerating", async () => {
  const h = await setup();
  const result = await h.execute({ prompt: "transparent portrait", size: "1024x1536", background: "transparent", save: "none" });
  assert.equal(result.metadata.image.hasAlpha, true);
  assert.equal(result.metadata.image.transparent, false);
  assert.equal(result.metadata.warnings.length, 2);
  assert.match(result.output, /returned 1x1/);
  assert.match(result.output, /returned image is opaque/);
  assert.equal(h.calls.length, 1);
});

test("a format ignored by the gateway uses the actual file extension and MIME type", async () => {
  const h = await setup();
  globalThis.fetch = async () => responseFor(imageEvents()).response;
  const result = await h.execute({ prompt: "bird", outputFormat: "jpeg", save: "project" });
  assert.match(result.metadata.savedPath, /\.png$/);
  assert.equal(result.attachments[0].mime, "image/png");
  assert.equal(result.attachments[0].filename, "image_unsafe.png");
  assert.match(result.output, /Requested format jpeg; gateway returned png/);
});

test("WebP compression is forwarded and generation instructions load the dedicated skill", async () => {
  const h = await setup();
  await h.execute({ prompt: "bird", outputFormat: "webp", outputCompression: 85, save: "none" });
  assert.equal(h.calls[0].body.tools[0].output_compression, 85);
  const output = { system: [] };
  await h.hooks["experimental.chat.system.transform"]({}, output);
  assert.match(output.system.join("\n"), /gateway-image-generation skill/);
  assert.match(output.system.join("\n"), /actual image dimensions\/transparency/);
});
