---
name: "imagegen"
description: "Generate raster images through the built-in Ruizhi image generation helper. Use when the user asks Codex to create bitmap assets such as illustrations, photos, product images, UI mockups, covers, sprites, banners, or other generated images."
---

# Ruizhi Image Generation Skill

Use this skill whenever the user invokes `$imagegen` or asks to generate a raster image. This build uses the Ruizhi backend image API and does not require the user to install Python packages or manually provide an `OPENAI_API_KEY`.

## Required execution path

Always use the packaged helper pointed to by `RUIZHI_IMAGEGEN_EXE`:

```powershell
& $env:RUIZHI_IMAGEGEN_EXE generate --prompt "..." --out "output/imagegen/output.png" --quality medium --size auto --force
# With a user-supplied or recently generated reference image:
& $env:RUIZHI_IMAGEGEN_EXE generate --prompt "..." --image "C:/absolute/path/reference.png" --out "output/imagegen/output.png" --quality medium --size auto --force
```

Execution chain:

```text
$user request / $imagegen
  -> this SKILL.md
  -> request network permission if the runtime asks for it
  -> call RUIZHI_IMAGEGEN_EXE
  -> ruizhi-imagegen helper
  -> if --image is present: POST https://gptauth.ruijie.com.cn/v1/responses to convert image(s) to a visual text description
  -> combine the visual description with the user prompt into the final image prompt
  -> POST https://gptauth.ruijie.com.cn/v1/images/generations
  -> save PNG/JPEG/WebP locally
  -> return the helper's Markdown image path
```

## Backend and authentication

- Endpoint: `https://gptauth.ruijie.com.cn/v1/images/generations`.
- Reference-image understanding endpoint: `https://gptauth.ruijie.com.cn/v1/responses`.
- Default base URL: `https://gptauth.ruijie.com.cn/v1`.
- Override only when explicitly needed: set `RUIZHI_OPENAI_BASE_URL`.
- Authentication is automatic. The helper reads credentials in this order:
  1. `RUIZHI_API_KEY`
  2. `auth.json` under `RUIZHI_HOME` / `CODEX_HOME` / `~/.ruizhi` / `~/.codex`, preferring `RUIZHI_API_KEY`, then `tokens.access_token`, then `OPENAI_API_KEY`
  3. `OPENAI_API_KEY`
- Do not print credentials or the contents of `auth.json`.
- If authentication fails, ask the user to sign in to Ruizhi again or set `RUIZHI_API_KEY`; never ask the user to paste secrets into chat.

## Output rules

- Save project-related images into the current workspace, usually `output/imagegen/` or a user-specified path.
- The helper creates parent directories automatically; do not run a separate `mkdir` unless needed for other files.
- Do not leave final project assets only in temporary folders or the Ruizhi home directory.
- After success, return the raw Markdown image line printed by the helper on its own line so the image renders inline. Do not replace it with a plain file path or a prose-only success message.
- Markdown image targets must be absolute file paths. On Windows, convert backslashes to forward slashes, for example:

```markdown
![generated image](C:/Users/name/project/output/imagegen/output.png)
```

- Do not wrap the final Markdown image in a code block.

## Single image generation

Use PowerShell on Windows:

```powershell
& $env:RUIZHI_IMAGEGEN_EXE generate --prompt "A clean product mockup on a white background" --out "output/imagegen/mockup.png" --quality high --size auto --force
```

Useful flags:

- `--prompt "..."` or `--prompt-file prompt.txt`
- `--image C:/absolute/path/reference.png` for image+text generation; repeat for multiple reference images
- `--out output/imagegen/name.png`
- `--size auto`, `1024x1024`, `1536x1024`, `1024x1536`, `2048x2048`, `3840x2160`, etc.
- `--quality low|medium|high|auto`
- `--output-format png|jpeg|webp`
- `--n 1` for one image; use multiple commands for distinct prompts
- `--force` to overwrite an existing output path when replacement is intended

## Batch generation

For multiple prompts, create a JSONL job file and run:

```powershell
& $env:RUIZHI_IMAGEGEN_EXE generate-batch --jobs "jobs.jsonl" --out-dir "output/imagegen" --force
```

Each JSONL line can be a string prompt or an object:

```json
{"prompt":"A clean product mockup on a white background","out":"output/imagegen/mockup.png","quality":"high"}
```

## Prompt guidance

Use a concise production prompt. Include only details that materially improve the output:

```text
Use case: <photo | illustration | product mockup | UI mockup | banner | sprite | cover>
Primary request: <user's request>
Style/medium: <photorealistic / illustration / 3D / flat UI / etc.>
Composition: <framing and layout>
Lighting/mood: <if relevant>
Text (verbatim): "<exact text, if any>"
Constraints: no watermark; avoid unwanted extra objects; preserve specified brand/text exactly
```

If the user gives a detailed prompt, preserve it and only normalize wording. Do not invent unrelated objects, brands, slogans, or text.

## Reference images

When the user uploads an image or asks to modify/optimize a previously generated image, pass the image path with `--image`. Do not describe the image yourself with local OCR or local vision tools first. The helper will use the Ruizhi model vision endpoint to extract the image content as text, combine that description with the user's prompt, and then call the Ruizhi image generation API.

Example:

```powershell
& $env:RUIZHI_IMAGEGEN_EXE generate --prompt "Add a red heart above the dog head; preserve the original pond scene and cartoon style" --image "C:/Users/name/project/output/imagegen/dog-pond.png" --out "output/imagegen/dog-pond-heart.png" --quality medium --size auto --force
```

## Transparent background

`gpt-image-2` does not support native `background=transparent`. For simple opaque subjects, generate on a flat chroma-key background and then remove the key locally with the installed helper if Python/Pillow are available. If local alpha extraction is unavailable or unsuitable, explain the limitation instead of pretending the result is transparent.

## Constraints

- Do not use local image models or the official built-in `image_gen` tool as the primary path in this Ruizhi build; always use `RUIZHI_IMAGEGEN_EXE` first so requests go through the Ruizhi backend.
- Treat any local model only as an explicit fallback after `RUIZHI_IMAGEGEN_EXE` fails with a clear API/auth/network error and the user agrees to fallback.
- For follow-up edits or modifications to a recently generated image, do not start a long analysis turn first; immediately call `RUIZHI_IMAGEGEN_EXE` again with the latest user instruction.
- Do not require users to install `openai`, `Pillow`, or other image dependencies for normal generation.
- Do not expose API keys, OAuth tokens, or auth files.
- If the API returns an error, report the HTTP status and concise error message.
