<div align="center">
  <h1>ForgeMetaLink</h1>
  <p><strong>Your best Forge Neo image already exists. You just can't find it.</strong></p>
</div>

You generate hundreds of images and keep a few. Weeks later you want one back. Or you want ten more like it.

The recipe sits inside each PNG, but nothing reads it for you. ForgeMetaLink does. It runs on your computer and uploads nothing.

## What it does

- **Searches your library in an instant.** Type a prompt word, model, LoRA, sampler, seed, or tag. Put `-` before a tag to exclude it. Filter by checkpoint family.
- **Compares up to four images side by side.** It highlights every setting that differs.
- **Makes variations of your winner.** Pick the image. Tick the changes: seed +1 to +4, higher or lower CFG or steps, another sampler or scheduler. It queues them all in Forge Neo. One sweep holds 16 images at most. Past 8, it asks first.
- **Sends any image back to Forge Neo.** Sampler, scheduler, CFG, seed, size, model, and LoRAs arrive unchanged. No PNG Info copy-paste. Resolution presets match your model family.
- **Upscales in place.** In the **Forge** tab, pick one of Forge Neo's upscalers, set the scale, and go.
- **Traces an image to its origin.** Variations made here remember their parent. You can walk back to the first prompt, even after you delete the images in between.
- **Deletes safely.** Images go to the Recycle Bin with a 6-second undo. Locked images never get deleted.
- **Stores your prompts.** Save the ones you reuse. Search them. Apply one to a new request.
- **Handles the chores.** Favorite, lock, move, tag, export to CSV or JSON, find duplicates.

## Get started

1. Download the installer from the [releases page](https://github.com/soficis/forge-meta-link/releases) and run it.
2. Click **Scan Folder** and pick your image folder.
3. Set **Storage Profile** to HDD or SSD to match your drive.
4. Wait for the scan. Then search, or open an image to see its settings.

To compare, press `1`–`4` on an image to pin it.

### Connect Forge Neo

1. Start Forge Neo with `--api`.
2. Open **Settings → Forge connection**. Enter the address (usually `http://127.0.0.1:7860`). Click **Test connection**.
3. Open an image. Go to the **Forge** tab. Change what you like. Press **Send to Forge**.

To send many at once, select the images and use **Send to Forge** in the bar that appears.

The model and LoRA folders are optional. A "LoRA directory not configured" note is harmless.

## Shortcuts

Press `?` in the app for the full list.

| Key | Action |
|---|---|
| `Ctrl+F` | Search |
| `1`–`4` | Pin to Compare Lab |
| `f` | Favorite |
| `Del` | Move to Recycle Bin (`Ctrl+Z` undoes within 6 seconds) |
| `Shift+Del` | Delete permanently (always asks first) |
| `j` / `k` or arrows | Next or previous image in the viewer |

## What deleting keeps

- **Trash** keeps a hidden record of the settings. Images made from it still show their history.
- **Permanent delete** removes the file, the prompt text, and the thumbnail. It keeps seed, CFG, steps, sampler, scheduler, and model for the history view.
- **Locked images** never get deleted. A favorite is only a marker, unless you turn on "Lock images when I favorite them" in Settings.

## Troubleshooting

- **Blank or outdated thumbnails:** wait a moment, rescan the folder, or run **Force Rebuild All** under Settings → Library.
- **"Asset protocol" errors:** rescan the folder inside the app. Use a normal local drive path.

## Your data

The app keeps one database (`ForgeMetaLink.db`, prompt library included), a thumbnail cache, and the images Forge sends back. Tags and notes live next to each image in a small `.yaml` file. A Forge API key goes into your system keyring.

## Build from source

You need Node.js 22, Rust (stable), and the [Tauri prerequisites](https://tauri.app/start/prerequisites/).

```bash
npm ci
npm run tauri -- dev         # run the app
npm run tauri -- build       # make an installer
npm test                     # frontend tests
cd src-tauri && cargo test   # backend tests
```

Windows gets the most testing. It needs WebView2 111 or newer. CI also builds Linux, macOS, and ARM64 installers. Those get little hands-on testing.

## License

GNU General Public License v3.0: https://www.gnu.org/licenses/gpl-3.0.txt
