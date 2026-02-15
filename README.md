# ForgeMetaLink

ForgeMetaLink is a local-first desktop app for managing large AI image libraries.
It scans your image folders, extracts generation metadata, builds a fast local index, and helps you search, filter, export, and resend images to Forge/A1111.

The app is built with React + TypeScript + Tauri + Rust, and stores data in local SQLite on your machine.

## Quick Start

### Prerequisites

- Node.js 20+
- Rust toolchain (stable)
- Tauri system prerequisites for your OS: https://v2.tauri.app/start/prerequisites/

### Run in development

```bash
npm ci
npm run tauri -- dev
```

### Build desktop binaries

```bash
npm ci
npm run tauri -- build
```

Build artifacts are generated under `src-tauri/target/release/`.

## First-Run Workflow

1. Launch the app and click `Scan Folder` in the sidebar.
2. Choose a directory that contains AI-generated images.
3. Wait for scan progress to complete (`scanning`, `indexing`, then `thumbnails`).
4. Use the top search bar to find images by prompt text, model, seed, or metadata.
5. Use sidebar `Tag Filters` for booru-style include/exclude filtering.
6. Open any image to inspect metadata, prompts, and file details.
7. Optionally save sidecar tags/notes per image.
8. Export metadata/images or send images back to Forge.

## Feature Guide

### 1. Scanning and Metadata Indexing

What it supports:

- Image formats: `png`, `jpg`, `jpeg`, `webp`, `avif`, `gif`, `jxl`
- Incremental rescans using stored file modified time (`mtime`)
- PNG metadata chunk parsing (`tEXt`, `zTXt`, `iTXt`) without decoding full pixels
- Metadata parsing for A1111/Forge text, ComfyUI JSON graphs, and NovelAI-style payloads
- Sidecar `.txt` fallback when embedded metadata is missing
- Prompt tag extraction including `lora:<name>` and `embedding:<name>`
- Generation type inference: `txt2img`, `img2img`, `inpaint`, `grid`, `upscale`, `unknown`

How to use:

1. Click `Scan Folder`.
2. Rescan the same folder anytime; unchanged files are skipped automatically.
3. Use `Storage Profile` (`HDD` or `SSD`) to tune scan and thumbnail behavior for your drive.

### 2. Search and Filtering

Search behavior:

- Porter FTS for ranked/prefix search
- Trigram FTS fallback for infix substring matches
- Searches prompt, negative prompt, raw metadata, and model name

Search examples:

```text
cat                # prefix match
cat*               # explicit wildcard
"best quality"     # exact phrase
cat dog            # AND terms
```

Tag filters (`Sidebar > Tag Filters`):

```text
tag1 -tag2 "multi word tag"
```

Filtering controls:

- Generation type dropdown
- Exact model dropdown
- LoRA dropdown (from indexed `lora:` tags)
- Grid filtering includes fallback detection for legacy Forge/A1111 grid folders and filenames
- Checkpoint family quick toggles:
  - PonyXL, SDXL, Flux, Z-Image Turbo, SD 1.5, SD 2.1, Chroma, VACE
- Sort options: newest, oldest, name A-Z, name Z-A, model, generation type

Top tags:

- Sidebar shows top tags (top 10 by default, with `Show More`).

### 3. Gallery and Viewer

Gallery:

- Virtualized infinite scroll for large libraries
- Grid density slider (`3` to `14` columns)
- Multi-select checkboxes
- Right-click context menu (gallery and viewer):
  - `Compress + Copy for Discord`
  - `Copy JPEG to Clipboard`

Viewer:

- Fullscreen image view with filmstrip
- Zoom, pan, fit reset, and slideshow (`2s`, `4s`, `6s`, `8s`)
- Metadata panel with prompt, negative prompt, parameters, and path
- `Search by seed` action
- `Open file location` action
- JPEG XL display support with automatic decoded proxy fallback when needed
- JPEG-preferred dedupe when both `.png` and `.jpg` share a basename

### 4. Sidecar Metadata

Supported sidecar formats:

- Read: `.yaml`, `.yml`, `.json`
- Write: `.yaml`

How to use:

1. Open an image in the viewer.
2. Add/remove sidecar tags and optional notes.
3. Click `Save Sidecar`.

Notes:

- Sidecar tag updates are synced back into the DB for indexed images.
- Existing sidecar fields (like rating) are preserved when saving.

### 5. Export Options

Metadata export (sidebar or viewer):

- JSON
- CSV

Image export (ZIP):

- Original files
- PNG
- JPEG
- WebP
- JPEG XL (`.jxl`)

Usage:

1. Select images in gallery (or export current image in viewer).
2. Pick format.
3. For JPEG/WebP, set quality with slider.
4. Save the generated ZIP.

### 6. Forge/A1111 Integration

Connection and options:

- Connection test calls `sdapi/v1/samplers`
- Generation calls `sdapi/v1/txt2img`
- Base URL should be host root (example: `http://127.0.0.1:7860`)
- Optional API key support
- Dynamic sampler/scheduler/model options from Forge API

Model and LoRA discovery:

- Configurable models folder and LoRA folder
- Optional recursive subfolder scanning
- Model scan filters checkpoint-like files (`.safetensors`, `.ckpt`, `.gguf`)
- LoRA scan collects `.safetensors` and `.ckpt` tokens

Payload editing (viewer):

- Prompt and negative prompt
- Steps, sampler, scheduler, CFG scale
- Seed, width, height
- Model checkpoint override
- Resolution presets for PonyXL/SDXL, Flux, and Z-Image Turbo
- Preset manager (`Save`, `Load`, `Delete`)
- LoRA multi-select + global LoRA weight
- Per-send seed toggle
- Per-send ADetailer face fix toggle and model selector (`face_yolov8n.pt` / `face_yolov8s.pt`)

Forge send behavior:

- Single-image send from viewer
- Batch queue send from sidebar (`Send Selected to Forge`)
- Queue is globally serialized to avoid concurrent request collisions
- When ADetailer is enabled, app saves both unprocessed and ADetailer variants
- Custom selected LoRAs are injected into prompt as `<lora:name:weight>` tokens
- Existing LoRA tokens are removed before selected LoRAs are applied

Output behavior:

- Default output folder: `forge-outputs` under app data
- Leaving output blank uses the default folder
- Filenames are timestamped per source image

### 7. Performance and Cache Controls

- Storage profile toggle (`HDD`/`SSD`) tunes scan threads, DB pool behavior, and thumbnail throughput
- `Cache All Thumbnails` pre-generates cache entries for the full indexed library
- Thumbnail pipeline uses JPEG cache format and auto-migrates legacy WebP cache entries

## Recommended Forge Workflow

1. Start Forge/A1111 with API mode enabled (`--api`).
2. In sidebar `Forge API Settings`, set base URL and optional API key.
3. Configure output folder (or leave blank for default).
4. Configure models and LoRA folders, then enable subfolder scanning if needed.
5. Click `Test Connection`.
6. Open an image and adjust `Forge Payload` values.
7. Optionally save payload presets for reuse.
8. Click `Send to Forge` (single image) or `Send Selected to Forge` (batch queue).
9. Scan your Forge output folder if you want generated files indexed in ForgeMetaLink.

## Keyboard Shortcuts

### Gallery

- `Ctrl+A` / `Cmd+A`: Select all loaded images
- `Esc`: Clear current selection

### Viewer

- `Left` / `Right`: Previous/next image
- `+` / `=`: Zoom in
- `-`: Zoom out
- `0`: Reset zoom/pan
- `I`: Toggle info panel
- `S`: Toggle slideshow
- `Esc`: Stop slideshow or close viewer

## Data and Privacy

Local runtime data is stored in Tauri `app_data_dir`:

- `ForgeMetaLink.db`
- `thumbnails/`
- `storage_profile.json`
- `forge-outputs/`

Additional notes:

- App UI preferences are stored in local browser storage used by the Tauri webview.
- Forge URL/API key are saved locally for convenience.

## Optional Runtime Environment Variables

- `FORGE_SCAN_THREADS`
- `FORGE_IO_THREADS`
- `FORGE_DB_POOL_SIZE`
- `FORGE_THUMB_JPEG_QUALITY` (clamped to `40-95`)

## Scripts

- `npm run dev` - Vite frontend dev server
- `npm run build` - TypeScript + Vite production build
- `npm run lint` - ESLint
- `npm run tauri -- dev` - Run desktop app in development
- `npm run tauri -- build` - Build desktop binaries/installers

## Project Layout

```text
forge-meta-link/
  src/         React frontend
  src-tauri/   Rust backend + Tauri runtime
```

## Licensing

This project is licensed under **GNU General Public License v3.0 (GPLv3)** (official text: https://www.gnu.org/licenses/gpl-3.0.txt); based on a dependency license metadata review performed on **2026-02-14** using installed npm packages and `cargo metadata`, the dependency set is predominantly permissive (including MIT, Apache-2.0, BSD, ISC, Zlib, and Unlicense, with MPL-2.0 in transitives), which is generally compatible with GPLv3 (including Apache-2.0 with GPLv3), and no direct dependency was identified as GPLv3-incompatible, but this remains an engineering assessment rather than legal advice, and binary distributors should still provide corresponding source, build/repro instructions, and required third-party notices/attributions while accounting for platform runtime licenses (for example WebView2/WebKit/WebKitGTK) that are provided under their own terms.
