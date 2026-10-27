---
name: gateway-image-generation
description: Generate or edit bitmap images with codex_generate_image through an OpenAI-compatible Responses API provider with image_generation support. Use for image references, inpainting masks, resolution/orientation, quality, transparent backgrounds, and PNG/JPEG/WebP output, including gpt-image-2.5-flare and gpt-image-2.5-sunburst.
compatibility: opencode
---

# Image generation and editing

Use `codex_generate_image` for an explicit user request to generate or edit a raster/bitmap image through an OpenAI-compatible Responses API that supports the `image_generation` tool. Reuse the current OpenCode provider authentication. Do not call the tool just to test configuration or speculate about assets: each generation consumes image quota.

## Choose the request

- When the user names `gpt-image-2.5-flare` or `gpt-image-2.5-sunburst`, pass that exact ID as `model`.
- Put subject, composition, style, lighting, any exact visible text, and constraints in `prompt`.
- Set structured options for requested dimensions, quality, transparency, references, and masks; do not rely only on words in the prompt.
- Use `action=generate` for a new image. Use `action=edit` when modifying an existing image, and describe what must change and what must remain consistent. `auto` is also available.
- Do not invent a local input path. Use images supplied by the user, relevant project assets, or images generated earlier for the task.

## Resolution and orientation

Use either `size` or the pair `width` and `height`, never both forms.

| Request | Options |
| --- | --- |
| Automatic | `size="auto"` or omit |
| Square | `size="1024x1024"` |
| Landscape | `size="1536x1024"` |
| Portrait | `size="1024x1536"` |
| 16:9 landscape | `size="1536x864"` |
| 9:16 portrait | `size="864x1536"` |
| Custom pixels | e.g. `width=2048`, `height=1152` |

For GPT Image 2/2.5 routes, custom widths and heights must be positive multiples of 16, aspect ratio must be between 1:3 and 3:1, the longest edge must not exceed 3840, and the image must not exceed 3840×2160 total pixels. Sizes above 2560×1440 are experimental and model-specific limits can still apply. Older routes may support only the three standard sizes and `auto`.

An exact target such as 1920×1080 is not a valid native size because 1080 is not divisible by 16. An explicit local resize/crop step is needed for such a target; this tool does not resize the returned image automatically. Report any postprocessing and the actual resulting size instead of silently substituting a different resolution.

## Quality and format

- `quality`: `auto`, `low`, `medium`, `high`, `xhigh`, or `max`.
- `xhigh` and `max` quality are supported by the GPT Image 2.5 Flare/Sunburst routes. Other routes may reject them.
- Image quality is separate from the chat model's reasoning effort. Set the tool's `quality` argument to control image quality.
- `outputFormat`: `png`, `jpeg`, or `webp`; default is `png`.
- `outputCompression`: optional integer 0–100 for JPEG/WebP. Omit for PNG.
- Leave unspecified preferences at `auto`; do not automatically choose maximum quality for every request.

## Transparent backgrounds

- Request real alpha transparency with `background="transparent"` and `outputFormat="png"` or `"webp"`.
- JPEG does not support transparency; transparent+JPEG is rejected before sending a generation request.
- GPT Image 2.5 Flare/Sunburst support native transparent backgrounds. Availability still depends on the configured API honoring the option.
- Describe whether the subject should be isolated, which details/edges to preserve, and whether shadows are wanted.
- Do not describe a white or checkerboard background as transparent. The tool inspects the returned alpha channel and actual transparent pixels.
- If `metadata.image.transparent` is false or a warning says the returned image is opaque, tell the user that transparency was not produced. Do not silently regenerate or claim background removal succeeded.

## Reference images and edits

- Supply local PNG/JPEG/WebP paths in `referencePaths`.
- For edits, the first path is the base image to modify; remaining paths are additional references. Use `action="edit"` and explicitly describe the requested changes and the details to preserve.
- For new generation inspired by references, use `action="generate"` or `"auto"` and explain each reference's purpose in the prompt.
- Relative paths resolve under the current project directory, and `~/` is supported.
- The plugin follows OpenCode read/external-directory permissions. There can be at most 16 references, and references plus mask must total at most 50 MiB.
- The plugin uploads image bytes as `input_image` content. An output image attachment is not automatically reused as input; pass its saved path for the next edit.

## Masked edits

- Set `maskPath` to a PNG with an alpha channel and at least one transparent pixel.
- The mask dimensions must exactly match the first reference image.
- Transparent mask areas identify regions to edit; opaque areas should be preserved.
- A mask requires a base image in `referencePaths`. Do not combine a mask with `action="generate"`; an unspecified action defaults to `edit` when a mask is supplied.

## Saving and reporting

- `save="global"` is the default: `~/.local/share/opencode/generated-images/<session-id>/` (or the corresponding XDG data directory).
- `save="project"` writes under the project's `.opencode/generated-images/<session-id>/`.
- `save="custom"` requires `saveDir`; `save="none"` returns only an attachment and cannot provide a saved path for a later edit.
- Return the saved file link and describe the actual image dimensions and transparency from `metadata.image` when relevant.
- Always disclose `metadata.warnings`, such as an API ignoring requested dimensions, transparency, or output format. Filenames and attachment MIME types follow the actual returned format.
- An API rejection of an option is a failed request, not proof that the option succeeded. Do not discard requested options or generate another image without a corresponding user request.
