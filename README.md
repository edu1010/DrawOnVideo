# DrawOnVideo (Electron + React + Canvas)

A desktop application to draw timeline-synced annotations directly on top of video.

## About

DrawOnVideo is a side project built to make it easy to draw over videos in real time.

The usual workflow for annotating video (exporting frames, using external tools, re-importing, etc.) is often slow and cumbersome. This tool aims to streamline that process into a single, interactive experience.

This project was also an opportunity to experiment with AI-assisted development workflows using tools like Codex, significantly accelerating the development process.

## Why Electron + React + Canvas for this MVP

This project uses **Electron + React + HTML Canvas** instead of PyQt because:

- Electron gives a fast path to desktop UI + hardware-accelerated video/canvas rendering.
- Pointer Events provide mouse + pen support (including `pressure`) in one input model.
- React keeps UI modules decoupled (`video`, `drawing`, `layers`, `timeline`, `export`) and scalable.
- IPC boundaries keep file system and ffmpeg logic in main process, renderer stays focused on UX.

(See inline comments in code where key tradeoffs are implemented.)

## Implemented Features

- Load local video files (`mp4`, `mov`, `mkv`, `avi`, `webm`, `m4v`)
- Add multiple video files to the same project timeline (`Add Video`)
- Video layer tracks (multiple video layers)
  - Add/remove video layers in timeline
  - Assign new clips to active video layer
  - Move selected video clips to active video layer
  - Drag video clips vertically between video layers
  - Overlaps respect layer order (top video layer is visible)
- Playback controls
  - Play / Pause
  - Scrub timeline
  - Previous / Next frame stepping
  - Current time / duration / fps readout
- Drawing overlay over video
  - Draw while paused or while playing
  - Freehand brush + optional eraser
  - Color / size / opacity
  - Pen pressure support via Pointer Events
- Layer system
  - Add / select / visibility toggle / delete / clear
  - Strokes stored independently per layer
  - Move selected annotation clips between draw layers
- Timeline-synced annotations
  - Every stroke stores `startFrame` + `endFrame`
  - Stores timed points (`timeMs`) to replay stroke growth progressively
  - On playback, strokes appear smoothly as they were drawn and then remain visible
- Editable annotation timeline
  - Per-layer clip lanes with selectable stroke clips
  - Multi-select clips with `Shift+click`
  - Delete selected clips with `Delete` / `Backspace`
  - Trim clip in/out (left/right handles)
  - Move clips in time by dragging
  - Cut/split clip at the clicked time (Cut tool)
  - Video clip lane with trim/move/cut support (non-destructive)
  - Per-video-clip audio controls (mute + dB gain)
  - Per-video-clip audio waveform preview in the timeline
  - Adaptive thumbnail strip generated from the source video
  - Zoom and track-height controls for detailed timeline editing
- Resizable UI regions
  - Drag vertical separators to resize tools panel and layers panel
  - Drag horizontal separator above timeline to change timeline viewport height
- Undo / Redo per active layer
- Project save/load (`.json`)
  - stores: video path, video metadata, layers, strokes data
- Export dialog with advanced options
  - File name + output container (`mp4`, `mov`, `webm`)
  - FPS, output resolution, and target bitrate (Mbps)
  - Encoder selection (`auto` GPU fallback chain, or force `CPU/NVIDIA/Intel/AMD`)
  - Optional source audio mix for single-source timeline exports
  - Render annotated stream in renderer, then encode via ffmpeg in Electron main process
- Performance-focused rendering
  - `requestAnimationFrame` loop
  - frame-aware redraw skipping
  - per-layer offscreen compositing cache

## Project Structure

```text
DrawOnVideo/
  electron/
    main.js                     # Electron window bootstrap
    preload.js                  # Safe renderer API bridge
    ipc/
      registerIpc.js            # IPC handlers (dialog/fs/export/probe)
    services/
      videoProbe.js             # ffprobe metadata extraction (fps/duration/resolution)
      exportService.js          # ffmpeg H264 conversion pipeline
  src/
    App.jsx                     # Main orchestration (state + input + workflow)
    main.jsx                    # React entrypoint
    styles.css                  # App styling/layout
    constants.js                # Shared constants/tool defaults
    components/
      TopBar.jsx                # File + export actions and status
      Toolbar.jsx               # Brush/eraser controls
      LayersPanel.jsx           # Layer management panel
      TimelineBar.jsx           # Timeline + transport controls
    engine/
      rendering.js              # Canvas render engine for timeline-synced layers
      exportRenderer.js         # Annotated stream recorder for export
    utils/
      id.js                     # ID helper
      time.js                   # Time/frame formatting + math
      layerOps.js               # Pure layer/stroke operations
      projectSchema.js          # Save/load project schema helpers
      strokeClip.js             # Annotation clip trim/move/split math
      videoClipOps.js           # Video clip timeline operations (multi-video)
      videoLayerOps.js          # Video layer track helpers
  index.html
  vite.config.js
  package.json
```

## Run Instructions

1. Install dependencies:

```bash
npm install
```

If your PowerShell blocks `npm.ps1`, use `npm.cmd` in all commands below.

2. Run in development mode (Vite + Electron):

```bash
npm run dev
```

3. Production renderer build:

```bash
npm run build
```

4. Start Electron against built renderer (`dist/`):

```bash
npm start
```

## Troubleshooting

- If `npm start` opens a blank window, run `npm run build` again and then `npm start`.
- For best playback compatibility, use videos encoded as `H.264 + AAC` in `.mp4`.
- The app maps local file paths to a custom `local-media://` protocol so local playback works in both dev and build modes.

## Notes / MVP Constraints

- Export speed is near real-time because the renderer records annotated playback before ffmpeg conversion.
- Frame-accurate stepping depends on source codec/keyframe structure and browser decoding behavior.
- Project files store the source video path by reference (they do not embed video bytes).

## License And Attribution

- Project license: `GPL-3.0-or-later` (see [`LICENSE`](./LICENSE)).
- Original author attribution: `edu1010` (GitHub: [edu1010](https://github.com/edu1010)).
- If you redistribute this project (modified or unmodified), keep these files in your distribution:
  - [`LICENSE`](./LICENSE)
  - [`NOTICE`](./NOTICE)
  - [`THIRD_PARTY_NOTICES`](./THIRD_PARTY_NOTICES)

### Third-party dependencies (direct)

- `electron` (MIT)
- `ffmpeg-static` (GPL-3.0-or-later)
- `ffprobe-static` (MIT)
- `react` (MIT)
- `react-dom` (MIT)
- `@vitejs/plugin-react` (MIT)
- `concurrently` (MIT)
- `cross-env` (MIT)
- `vite` (MIT)
- `wait-on` (MIT)

For transitive dependencies, check `package-lock.json`.

## Project JSON Example

```json
{
  "version": 1,
  "videoPath": "C:\\videos\\clip.mp4",
  "videoMeta": {
    "width": 1920,
    "height": 1080,
    "fps": 29.97,
    "duration": 12.04
  },
  "layers": [
    {
      "id": "layer-...",
      "name": "Layer 1",
      "visible": true,
      "strokes": [
        {
          "id": "stroke-...",
          "tool": "brush",
          "color": "#ff6d5a",
          "size": 6,
          "opacity": 1,
          "startFrame": 210,
          "endFrame": 228,
          "points": [
            { "x": 640, "y": 320, "timeMs": 7000, "pressure": 0.85 }
          ]
        }
      ]
    }
  ]
}
```
