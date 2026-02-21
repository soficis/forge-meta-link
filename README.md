<div align="center">
  <h1>ForgeMetaLink</h1>
  <p><strong> Desktop manager/gallery tool for large AI image libraries.</strong></p>
  <p>Scan folders, index metadata, search instantly, export sets, and round-trip images to Forge.</p>
  <img src="public/forge-meta-link.jpg" alt="ForgeMetaLink screenshot" width="900" />
</div>

ForgeMetaLink is built with React + TypeScript + Tauri + Rust and stores runtime data locally in SQLite.

## What You Can Do Quickly

- Re-find past generations fast: search by prompt phrases, model names, or seed values.
- Curate large folders: filter with include/exclude tags and generation-type controls.
- Build clean export packs: batch-select images and export metadata + converted images.
- Reuse strong prompts/settings: open an image and send tuned payloads back to Forge.

## Quick Setup (End Users First)

### 1) Install from Releases (fastest)

Download from: https://github.com/soficis/forge-meta-link/releases

- Windows x64: `forge-meta-link_0.1.0_x64-setup.exe` (or `.msi`)
- Windows ARM64: `forge-meta-link_0.1.0_arm64-setup.exe` (or `.msi`)
- Linux x64: `forge-meta-link_0.1.0_amd64.deb` or `forge-meta-link_0.1.0_amd64.AppImage`

### 2) One-click Build Wizard (recommended for Linux/macOS/source builds)

Verified launch commands:

- `npm run build:wizard`
- `./scripts/build-wizard.sh`
- `scripts\build-wizard.cmd`

Additional launcher:

- `.\scripts\build-wizard.ps1`

What it does:

- Detects available targets for your environment.
- Guides target selection interactively.
- Tracks progress in `.build-wizard/state.json` and resumes after interruption.

Quick non-interactive examples:

- Host-platform default build: `npm run build:wizard -- --targets=host-default --yes`
- Linux ARM64 local `.deb` build (completely untested): `npm run build:wizard -- --targets=linux-arm64-deb --yes`

Manual Linux ARM64 Docker path (local only, completely untested):

```bash
sudo apt update && sudo apt install -y docker.io qemu-user-static
sudo service docker start
docker run --privileged --rm tonistiigi/binfmt --install arm64
docker buildx create --use --name forgemetalink-arm64 || true
docker buildx build --platform linux/arm64 -f scripts/Dockerfile.arm64-deb -o type=local,dest=dist-arm64 .
```

Non-Docker ARM64 summary (advanced):

- Create an ARM64 sysroot (for example `debootstrap`).
- Install ARM64 GTK/WebKit/OpenSSL dev packages into that sysroot.
- Export cross-compile linker + `pkg-config` sysroot variables for `aarch64-unknown-linux-gnu`.
- Run `npm run tauri -- build --target aarch64-unknown-linux-gnu --bundles deb`.

### 3) First-Run Workflow (Start Here)

1. Click `Scan Folder` and choose your AI image directory.
2. Wait for `scanning`, `indexing`, and `thumbnails`.
3. Search by prompt/model/seed and apply filters.
4. Open an image and export or send to Forge.

### 4) Build from source

- Prereqs: Node.js 20+, Rust stable, Tauri OS prerequisites.
- Linux deps (Debian/Ubuntu): `sudo apt update && sudo apt install -y libglib2.0-dev libssl-dev libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf`
- Build: `npm ci && npm run tauri -- build`

### 5) Build only specific bundle targets (compact)

- Linux x64 (`.deb` + `.AppImage`): `npm run tauri -- build --bundles deb,appimage`
- Windows x64 (`.msi` + setup `.exe`): `npm run tauri -- build --bundles msi,nsis`
- Windows ARM64 (`.msi` + setup `.exe`): `npm run tauri -- build --target aarch64-pc-windows-msvc --bundles msi,nsis`
- Linux ARM64 `.deb` (local only, completely untested): `npm run build:wizard -- --targets=linux-arm64-deb --yes`
- Output dirs: `src-tauri/target/release/bundle/`, `src-tauri/target/aarch64-pc-windows-msvc/release/bundle/`, `dist-arm64/out/`

### Platform Compatibility Status

- Windows: primary platform, most tested.
- Linux: limited validation across distributions/desktops.
- macOS: limited validation.
- ARM64 build outputs (Windows/Linux) are completely untested.

## Feature Guide

### 1. Scanning and Metadata Indexing

What it supports:

- Image formats: `png`, `jpg`, `jpeg`, `webp`, `avif`, `gif`, `jxl`
- Incremental rescans using stored file modified time (`mtime`)
- PNG metadata chunk parsing (`tEXt`, `zTXt`, `iTXt`) without decoding full pixels
- Metadata parsing for Forge/Forge Neo text, ComfyUI JSON graphs (supported but untested), and NovelAI-style payloads
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
- Grid filtering includes fallback detection for Forge grid folders and filenames
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
- Bulk move selected images to another folder (organize without deleting)
- Bulk favorite/unfavorite and lock/unlock actions for selected images
- Delete safety flow:
  - Move to Recycle Bin/Trash mode or permanent delete mode
  - Undo delete grace window
  - Lock/Favorite protection against accidental deletion
- Sidebar `Gallery Safety` panel with auto-lock favorites toggle and recently deleted activity
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

### 6. Forge

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
- Thumbnail pipeline uses JPEG cache format

## Recommended Forge Workflow

1. Start Forge with API mode enabled (`--api`).
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
- `Delete` / `Backspace`: Remove one selected image from multi-selection

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

- `FORGE_SCAN_THREADS`:
  Sets scanner worker thread count used while walking and parsing image files.
  Use this to reduce CPU pressure on slower systems or increase throughput on faster systems.
- `FORGE_IO_THREADS`:
  Sets thumbnail IO/generation thread count.
  Useful when tuning responsiveness on HDD-heavy libraries versus SSD-heavy libraries.
- `FORGE_DB_POOL_SIZE`:
  Sets SQLite connection pool size for backend DB operations.
  Increase carefully if you do many concurrent operations.
- `FORGE_THUMB_JPEG_QUALITY`:
  Sets JPEG quality for generated thumbnails.
  Value is clamped to `40-95` (`85` default).

How to use (Linux/macOS shell):

```bash
# one-off run
FORGE_SCAN_THREADS=6 FORGE_IO_THREADS=8 npm run tauri -- dev

# persistent for current shell session
export FORGE_DB_POOL_SIZE=12
export FORGE_THUMB_JPEG_QUALITY=82
npm run tauri -- dev
```

How to use (Windows PowerShell):

```powershell
$env:FORGE_SCAN_THREADS = "6"
$env:FORGE_IO_THREADS = "8"
npm run tauri -- dev
```

## WSL2 Support (Experimental)

WSL2 GUI support is experimental.

- WSLg is required for Linux GUI rendering.
- Hardware acceleration may not be available on every Windows/driver/WSLg combination.
- If rendering is blank or unstable, try:

```bash
WEBKIT_DISABLE_DMABUF_RENDERER=1 ./src-tauri/target/release/forge-meta-link
```

## Scripts

- `npm run dev` - Vite frontend dev server
- `npm run build` - TypeScript + Vite production build
- `npm run fmt:check` - Rust formatting check (`cargo fmt --check`)
- `npm run lint` - ESLint
- `npm run test:rust` - Rust test suite (`cargo test`)
- `npm run clippy` - Rust lint gate (`cargo clippy -D warnings`)
- `npm run tauri -- dev` - Run desktop app in development
- `npm run tauri -- build` - Build all desktop binaries/installers
- `npm run build:wizard` - Launch interactive resumable cross-platform build wizard
- `npm run build:wizard -- --targets=host-default --yes` - One-shot host-platform wizard build
- `./scripts/build-wizard.sh --targets=linux-arm64-deb --yes` - One-shot Linux ARM64 `.deb` wizard build (local only, untested)
- `npm run tauri -- build --bundles deb,appimage` - Build Linux `.deb` + `.AppImage`
- `npm run tauri -- build --bundles msi,nsis` - Build Windows `.msi` + setup `.exe` (run in Windows shell)

## Release Docs

- `docs/performance-and-scale.md` - Phase 9 instrumentation, query-plan notes, benchmark snapshot
- `docs/smoke-tests.md` - manual package verification checklist
- `docs/release-checklist.md` - repeatable release process

## Project Layout

```text
forge-meta-link/
  src/         React frontend
  src-tauri/   Rust backend + Tauri runtime
```

## Estimated System Requirements (Full Hardware Acceleration)

- CPU: 4+ modern cores (8+ recommended for large scans).
- RAM: 8 GB minimum, 16 GB recommended.
- GPU: hardware-accelerated WebView-capable GPU/driver stack (DirectX 12 on Windows, Metal on macOS, Vulkan/OpenGL on Linux).
- VRAM: 2 GB minimum, 4 GB+ recommended for very large image grids/thumbnails.
- Storage: SSD strongly recommended (HDD works, but scans/thumbnails are slower).
- Display: 1080p minimum; 1440p+ recommended for dense gallery layouts.
- Linux desktop: modern Wayland/X11 session with current Mesa/NVIDIA/Intel drivers.
- WSL2: WSLg required; hardware acceleration depends on Windows GPU driver + WSLg compatibility.

## Licensing

This project is licensed under **GNU General Public License v3.0 (GPLv3)** (official text: https://www.gnu.org/licenses/gpl-3.0.txt); based on a dependency license metadata review performed on **2026-02-14** using installed npm packages and `cargo metadata`, the dependency set is predominantly permissive (including MIT, Apache-2.0, BSD, ISC, Zlib, and Unlicense, with MPL-2.0 in transitives), which is generally compatible with GPLv3 (including Apache-2.0 with GPLv3), and no direct dependency was identified as GPLv3-incompatible, but this remains an engineering assessment rather than legal advice, and binary distributors should still provide corresponding source, build/repro instructions, and required third-party notices/attributions while accounting for platform runtime licenses (for example WebView2/WebKit/WebKitGTK) that are provided under their own terms.
