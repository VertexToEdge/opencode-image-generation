import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import sharp from "sharp";

export type ImageFormat = "png" | "jpeg" | "webp";
export type ImageQuality = "auto" | "low" | "medium" | "high" | "xhigh" | "max";
export type ImageBackground = "auto" | "opaque" | "transparent";
export type ImageAction = "auto" | "generate" | "edit";

export interface ImageOptions {
  size?: string;
  width?: number;
  height?: number;
  quality?: ImageQuality;
  background?: ImageBackground;
  action?: ImageAction;
  referencePaths?: string[];
  maskPath?: string;
  outputFormat?: ImageFormat;
  outputCompression?: number;
}

export interface NormalizedImageOptions extends ImageOptions {
  size: string;
  quality: ImageQuality;
  background: ImageBackground;
  action: ImageAction;
  outputFormat: ImageFormat;
}

export interface ImageInput {
  path: string;
  mime: string;
  dataUrl: string;
  width: number;
  height: number;
}

export interface ImageInputs {
  references: ImageInput[];
  mask?: ImageInput;
}

const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_REFERENCES = 16;
const MAX_EDGE = 3840;
const MAX_PIXELS = 3840 * 2160;

export function normalizeImageOptions(params: ImageOptions): NormalizedImageOptions {
  const format = params.outputFormat ?? "png";
  const background = params.background ?? "auto";
  const quality = params.quality ?? "auto";
  const references = params.referencePaths ?? [];
  const action = params.action ?? (params.maskPath ? "edit" : "auto");
  if (background === "transparent" && format === "jpeg") {
    throw new Error("Transparent backgrounds require outputFormat=png or webp; JPEG has no alpha channel.");
  }
  if (references.length > MAX_REFERENCES) throw new Error(`At most ${MAX_REFERENCES} reference images are supported per call.`);
  if ((action === "edit" || params.maskPath) && !references.length) {
    throw new Error("Image editing and masks require referencePaths; put the image to edit first.");
  }
  if (params.maskPath && action === "generate") throw new Error("maskPath requires action=edit or auto, not generate.");
  if (params.outputCompression !== undefined) {
    if (!Number.isInteger(params.outputCompression) || params.outputCompression < 0 || params.outputCompression > 100) {
      throw new Error("outputCompression must be an integer between 0 and 100.");
    }
    if (format === "png") throw new Error("outputCompression applies to JPEG/WebP; omit it for PNG.");
  }
  const hasDimensions = params.width !== undefined || params.height !== undefined;
  if (hasDimensions && (params.width === undefined || params.height === undefined)) {
    throw new Error("Provide both width and height, or use size.");
  }
  if (hasDimensions && params.size !== undefined) throw new Error("Use either size or width/height, not both.");
  const size = hasDimensions ? `${params.width}x${params.height}` : params.size ?? "auto";
  if (size !== "auto") {
    const match = /^(\d+)x(\d+)$/.exec(size);
    if (!match) throw new Error("size must be auto or WIDTHxHEIGHT, for example 1536x864.");
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!width || !height || width % 16 || height % 16) {
      throw new Error("Image width and height must be positive multiples of 16; use 1536x864 for 16:9. Exact sizes such as 1920x1080 need a separate resize/crop step.");
    }
    if (width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_PIXELS || width / height > 3 || height / width > 3) {
      throw new Error("Image size exceeds the supported bounds: longest edge 3840, at most 3840×2160 pixels, and aspect ratio between 1:3 and 3:1.");
    }
  }
  return { ...params, size, outputFormat: format, background, quality, action };
}

export async function prepareImageInputs(
  params: ImageOptions,
  cwd: string,
  signal: AbortSignal,
  authorize: (path: string) => Promise<void>,
): Promise<ImageInputs> {
  normalizeImageOptions(params);
  let totalBytes = 0;
  async function load(path: string, mask: boolean): Promise<ImageInput> {
    signal.throwIfAborted();
    const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
    const filePath = await realpath(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
    await authorize(filePath);
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error(`Image input is not a file: ${path}`);
    if (info.size > MAX_INPUT_BYTES - totalBytes) throw new Error("Reference images and mask must total at most 50 MiB.");
    const bytes = await readFile(filePath, { signal });
    totalBytes += bytes.length;
    if (totalBytes > MAX_INPUT_BYTES) throw new Error("Reference images and mask must total at most 50 MiB.");
    let image;
    try {
      image = await sharp(bytes, { animated: false }).metadata();
    } catch {
      throw new Error(`Could not decode image input: ${path}. Use a PNG, JPEG, or WebP image.`);
    }
    if (!["png", "jpeg", "webp"].includes(image.format ?? "") || !image.width || !image.height) {
      throw new Error(`Unsupported image input: ${path}. Use PNG, JPEG, or WebP.`);
    }
    if (mask) {
      if (image.format !== "png" || !image.hasAlpha) throw new Error("maskPath must be a PNG with an alpha channel; transparent areas mark the region to edit.");
      if ((await sharp(bytes).stats()).isOpaque) throw new Error("The mask has no transparent pixels; mark the editable region with transparency.");
    }
    signal.throwIfAborted();
    return {
      path: filePath,
      mime: `image/${image.format}`,
      dataUrl: `data:image/${image.format};base64,${bytes.toString("base64")}`,
      width: image.width,
      height: image.height,
    };
  }
  const references: ImageInput[] = [];
  for (const path of params.referencePaths ?? []) references.push(await load(path, false));
  const mask = params.maskPath ? await load(params.maskPath, true) : undefined;
  if (mask && (mask.width !== references[0].width || mask.height !== references[0].height)) {
    throw new Error("The mask dimensions must match the first reference image.");
  }
  return { references, mask };
}

export async function inspectGeneratedImage(base64: string) {
  const bytes = Buffer.from(base64, "base64");
  const image = sharp(bytes, { animated: false });
  const metadata = await image.metadata();
  if (!["png", "jpeg", "webp"].includes(metadata.format ?? "") || !metadata.width || !metadata.height) {
    throw new Error("Gateway returned an unsupported or invalid image.");
  }
  const transparent = metadata.hasAlpha ? !(await image.stats()).isOpaque : false;
  return {
    width: metadata.width,
    height: metadata.height,
    outputFormat: metadata.format as ImageFormat,
    hasAlpha: Boolean(metadata.hasAlpha),
    transparent,
  };
}

export function imageResultWarnings(
  requested: NormalizedImageOptions,
  image: Awaited<ReturnType<typeof inspectGeneratedImage>>,
): string[] {
  const warnings: string[] = [];
  if (requested.size !== "auto" && requested.size !== `${image.width}x${image.height}`) {
    warnings.push(`Requested size ${requested.size}; gateway returned ${image.width}x${image.height}.`);
  }
  if (requested.background === "transparent" && !image.transparent) {
    warnings.push("Transparent background was requested, but the returned image is opaque.");
  }
  if (requested.outputFormat !== image.outputFormat) {
    warnings.push(`Requested format ${requested.outputFormat}; gateway returned ${image.outputFormat}. The file and attachment use the actual format.`);
  }
  return warnings;
}
