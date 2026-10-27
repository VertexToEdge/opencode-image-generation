import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, sep } from "node:path";
import { tool, type Plugin, type ToolContext } from "@opencode-ai/plugin";
import {
  dataDirectory,
  loadConfig,
  mimeForFormat,
  requestImage,
  resolveResponsesUrl,
  resolveSaveConfig,
  saveImage,
} from "./image-generation.js";
import { imageResultWarnings, inspectGeneratedImage, normalizeImageOptions, prepareImageInputs } from "./image-options.js";

async function authorizeImage(path: string, context: ToolContext): Promise<void> {
  const within = (root: string) => {
    const child = relative(root, path);
    return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
  };
  const worktree = context.worktree || context.directory;
  if (!within(context.directory) && (worktree === parse(worktree).root || !within(worktree))) {
    const pattern = join(dirname(path), "*");
    await context.ask({ permission: "external_directory", patterns: [pattern], always: [pattern], metadata: { filePath: path } });
  }
  await context.ask({ permission: "read", patterns: [relative(worktree, path)], always: ["*"], metadata: { filePath: path } });
}

function storedApiKey(providerID: string): string | undefined {
  try {
    const auth = JSON.parse(readFileSync(join(dataDirectory(), "auth.json"), "utf8"));
    const entry = auth[providerID];
    return entry?.type === "api" && typeof entry.key === "string" ? entry.key : undefined;
  } catch {
    return undefined;
  }
}

export const GatewayImageGenerationPlugin: Plugin = async ({ client }) => {
  const generateImage = tool({
    description:
      "Generate or edit a bitmap image through an OpenAI-compatible Responses API provider with native image_generation support. " +
      "Use this only for an explicit user request to generate or edit an image; it consumes the provider's image quota. " +
      "Load the gateway-image-generation skill before use. Set structured size/width/height, quality, background, referencePaths, and maskPath options to match the request. " +
      "Supports gpt-image-2.5-flare and gpt-image-2.5-sunburst: pass the exact requested route as model. " +
      "Returns the image, measured dimensions/transparency, and warnings if the API did not honor requested options. Report those warnings to the user.",
    args: {
      prompt: tool.schema.string().min(1).describe("The image prompt: subject, composition, style, text, and constraints."),
      model: tool.schema.string().min(1).optional().describe(
        "API model, such as gpt-image-2.5-flare or gpt-image-2.5-sunburst. Defaults to the configured image model or the active chat model.",
      ),
      size: tool.schema.string().optional().describe(
        "auto or WIDTHxHEIGHT. Common: 1024x1024 square, 1536x1024 landscape, 1024x1536 portrait; use 1536x864 for 16:9. Dimensions must be multiples of 16; model limits apply. Do not combine with width/height.",
      ),
      width: tool.schema.number().int().min(16).max(3840).optional().describe("Output width in pixels, a multiple of 16. Supply height too; omit size."),
      height: tool.schema.number().int().min(16).max(3840).optional().describe("Output height in pixels, a multiple of 16. Supply width too; omit size."),
      quality: tool.schema.enum(["auto", "low", "medium", "high", "xhigh", "max"]).optional().describe(
        "Image quality, separate from chat reasoning effort. xhigh/max are supported by the 2.5 Flare/Sunburst routes; other models may reject them.",
      ),
      background: tool.schema.enum(["auto", "opaque", "transparent"]).optional().describe("Request actual alpha transparency with transparent; use PNG or WebP, never JPEG."),
      action: tool.schema.enum(["auto", "generate", "edit"]).optional().describe("Use edit to modify the first reference image, generate for a new image, or auto. A mask defaults to edit."),
      referencePaths: tool.schema.array(tool.schema.string().min(1)).max(16).optional().describe(
        "Local PNG/JPEG/WebP image paths to upload. For edits, put the base image first; additional images are references. Relative paths use the project directory; ~/ is supported.",
      ),
      maskPath: tool.schema.string().min(1).optional().describe(
        "Optional PNG inpainting mask with an alpha channel and dimensions matching the first reference. Transparent areas are edited; opaque areas are preserved.",
      ),
      outputFormat: tool.schema.enum(["png", "jpeg", "webp"]).optional(),
      outputCompression: tool.schema.number().int().min(0).max(100).optional().describe("JPEG/WebP output compression setting, 0–100. Omit for PNG."),
      save: tool.schema.enum(["none", "project", "global", "custom"]).optional().describe(
        "Save mode. Default: global. project saves under .opencode/generated-images; none returns only an attachment.",
      ),
      saveDir: tool.schema.string().optional().describe(
        "Output directory for save=custom. Relative paths resolve under the current project; ~/ is supported.",
      ),
    },
    async execute(params, context) {
      context.abort.throwIfAborted();
      const cwd = context.directory;
      const settings = loadConfig(cwd);
      const requested = normalizeImageOptions(params);
      // Validate save settings before making a request that consumes image quota.
      const saveConfig = resolveSaveConfig(params, cwd, context.sessionID, settings);
      const [messageResult, configResult] = await Promise.all([
        client.session.message({ path: { id: context.sessionID, messageID: context.messageID } }),
        client.config.get(),
      ]);
      const config = configResult.data;
      if (!config) throw new Error("Could not resolve the OpenCode provider configuration.");
      const info = messageResult.data?.info;
      const fullDefault = config.model || "";
      const separator = fullDefault.indexOf("/");
      const defaultProvider = separator > 0 ? fullDefault.slice(0, separator) : undefined;
      const defaultModel = separator > 0 ? fullDefault.slice(separator + 1) : undefined;
      const activeProvider = info?.role === "assistant" ? info.providerID : info?.model.providerID;
      const activeModel = info?.role === "assistant" ? info.modelID : info?.model.modelID;
      const providerID = settings.provider || activeProvider || defaultProvider;
      if (!providerID) throw new Error("Select an OpenCode model before using codex_generate_image.");
      const provider = config.provider?.[providerID];
      const baseURL = provider?.options?.baseURL;
      if (typeof baseURL !== "string" || !baseURL) {
        throw new Error(`Configure provider.${providerID}.options.baseURL in opencode.json before generating images.`);
      }
      const configuredKey = provider?.options?.apiKey;
      const apiKey = typeof configuredKey === "string" && configuredKey ? configuredKey : storedApiKey(providerID);
      if (!apiKey) throw new Error(`No API key found for OpenCode provider "${providerID}". Connect that provider first.`);
      const model = params.model || settings.model || activeModel || defaultModel;
      if (!model) throw new Error("No image model selected. Pass model or configure image-generation.json.");
      const outputFormat = requested.outputFormat;
      const images = await prepareImageInputs(params, cwd, context.abort, (path) => authorizeImage(path, context));
      context.metadata({ title: `Generating image: ${model}`, metadata: { model, outputFormat, size: requested.size, background: requested.background, action: requested.action } });
      const parsed = await requestImage(
        params,
        resolveResponsesUrl(baseURL),
        apiKey,
        model,
        outputFormat,
        context.sessionID,
        context.abort,
        images,
      );
      if (!parsed.image) {
        const text = parsed.text.join("").trim();
        throw new Error(text ? `Gateway did not return an image. Response text: ${text}` : "Gateway did not return an image.");
      }
      context.abort.throwIfAborted();
      const image = await inspectGeneratedImage(parsed.image.result);
      const warnings = imageResultWarnings(requested, image);
      const savedPath = saveConfig.outputDir
        ? await saveImage(parsed.image.result, image.outputFormat, saveConfig.outputDir, parsed.image.id)
        : undefined;
      const metadata = {
        provider: providerID,
        model,
        outputFormat: image.outputFormat,
        requested: {
          size: requested.size,
          quality: requested.quality,
          background: requested.background,
          action: requested.action,
          outputFormat,
          outputCompression: requested.outputCompression,
        },
        image,
        warnings,
        referencePaths: images.references.map((reference) => reference.path),
        maskPath: images.mask?.path,
        saveMode: saveConfig.mode,
        savedPath,
        responseId: parsed.responseId,
        imageGenerationId: parsed.image.id,
        revisedPrompt: parsed.image.revisedPrompt,
        usage: parsed.usage,
      };
      context.metadata({ title: `Image generated: ${model}`, metadata });
      const mime = mimeForFormat(image.outputFormat);
      return {
        title: `Image generated: ${model}`,
        output: [
          `Generated image via ${providerID}/${model}.`,
          `Status: ${parsed.image.status}.`,
          `Actual image: ${image.width}x${image.height}, ${image.outputFormat}, ${image.transparent ? "contains transparent pixels" : "opaque"}.`,
          ...warnings.map((warning) => `Warning: ${warning}`),
          parsed.image.revisedPrompt ? `Revised prompt: ${parsed.image.revisedPrompt}` : undefined,
          savedPath ? `Saved image to: ${savedPath}` : "Image returned as an attachment without saving to disk.",
        ].filter(Boolean).join("\n"),
        metadata,
        attachments: [{
          type: "file" as const,
          mime,
          url: `data:${mime};base64,${parsed.image.result}`,
          filename: savedPath ? basename(savedPath) : `image.${image.outputFormat === "jpeg" ? "jpg" : image.outputFormat}`,
        }],
      };
    },
  });

  await client.app.log({
    body: { service: "gateway-image-generation", level: "info", message: "Gateway image generation tool loaded" },
  }).catch(() => {});

  return {
    tool: { codex_generate_image: generateImage },
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(
        "For explicit bitmap generation/edit requests, use codex_generate_image and first load the gateway-image-generation skill if available. " +
        "Translate requested resolution, quality, transparency, reference images, and masks into structured tool arguments. " +
        "Report actual image dimensions/transparency and any tool warnings; do not claim an ignored option succeeded or generate test images without a user request.",
      );
    },
  };
};
