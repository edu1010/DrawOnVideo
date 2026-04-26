import { useEffect, useMemo, useState } from "react";

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, num));
}

function ensureExtension(fileName, format) {
  const safeFormat = format === "mov" ? "mov" : (format === "webm" ? "webm" : "mp4");
  const base = String(fileName || "annotated-output").replace(/\.[^/.]+$/, "");
  return `${base}.${safeFormat}`;
}

function ExportDialog({
  open,
  defaultBaseName,
  sourceMeta,
  onCancel,
  onConfirm,
  running
}) {
  const [fileName, setFileName] = useState("annotated-output.mp4");
  const [format, setFormat] = useState("mp4");
  const [fps, setFps] = useState(30);
  const [width, setWidth] = useState(1280);
  const [height, setHeight] = useState(720);
  const [bitrateMbps, setBitrateMbps] = useState(12);
  const [includeAudio, setIncludeAudio] = useState(true);
  const [encoderMode, setEncoderMode] = useState("auto");
  const [preset, setPreset] = useState("medium");

  const safeSource = useMemo(() => ({
    width: Number(sourceMeta?.width) || 1280,
    height: Number(sourceMeta?.height) || 720,
    fps: Number(sourceMeta?.fps) || 30
  }), [sourceMeta]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const base = defaultBaseName || "annotated-output";
    setFormat("mp4");
    setFileName(`${base}.mp4`);
    setFps(Math.round(safeSource.fps));
    setWidth(Math.round(safeSource.width));
    setHeight(Math.round(safeSource.height));
    setBitrateMbps(12);
    setIncludeAudio(true);
    setEncoderMode("auto");
    setPreset("medium");
  }, [defaultBaseName, open, safeSource.fps, safeSource.height, safeSource.width]);

  if (!open) {
    return null;
  }

  return (
    <div className="export-dialog-backdrop" onClick={running ? undefined : onCancel}>
      <div className="export-dialog" onClick={(event) => event.stopPropagation()}>
        <h3>Export Options</h3>

        <div className="export-grid">
          <label>
            File name
            <input
              type="text"
              value={fileName}
              onChange={(event) => setFileName(event.target.value)}
              disabled={running}
            />
          </label>

          <label>
            Format
            <select
              value={format}
              onChange={(event) => {
                const nextFormat = event.target.value;
                setFormat(nextFormat);
                setFileName((prev) => ensureExtension(prev, nextFormat));
              }}
              disabled={running}
            >
              <option value="mp4">MP4 (H264)</option>
              <option value="mov">MOV (H264)</option>
              <option value="webm">WebM (VP9)</option>
            </select>
          </label>

          <label>
            Framerate (FPS)
            <input
              type="number"
              min={1}
              max={120}
              step={1}
              value={fps}
              onChange={(event) => setFps(clampNumber(event.target.value, 1, 120, 30))}
              disabled={running}
            />
          </label>

          <label>
            Bitrate (Mbps)
            <input
              type="number"
              min={1}
              max={80}
              step={0.5}
              value={bitrateMbps}
              onChange={(event) => setBitrateMbps(clampNumber(event.target.value, 1, 80, 12))}
              disabled={running}
            />
          </label>

          <label>
            Width
            <input
              type="number"
              min={64}
              max={7680}
              step={2}
              value={width}
              onChange={(event) => setWidth(clampNumber(event.target.value, 64, 7680, safeSource.width))}
              disabled={running}
            />
          </label>

          <label>
            Height
            <input
              type="number"
              min={64}
              max={4320}
              step={2}
              value={height}
              onChange={(event) => setHeight(clampNumber(event.target.value, 64, 4320, safeSource.height))}
              disabled={running}
            />
          </label>

          <label>
            Encoder
            <select
              value={encoderMode}
              onChange={(event) => setEncoderMode(event.target.value)}
              disabled={running}
            >
              <option value="auto">Auto (try GPU, then CPU)</option>
              <option value="software">CPU (libx264)</option>
              <option value="nvidia">NVIDIA NVENC</option>
              <option value="intel">Intel QSV</option>
              <option value="amd">AMD AMF</option>
            </select>
          </label>

          <label>
            Preset
            <select
              value={preset}
              onChange={(event) => setPreset(event.target.value)}
              disabled={running}
            >
              <option value="veryfast">Very Fast</option>
              <option value="fast">Fast</option>
              <option value="medium">Medium</option>
              <option value="slow">Slow</option>
            </select>
          </label>
        </div>

        <div className="export-inline-options">
          <label>
            <input
              type="checkbox"
              checked={includeAudio}
              onChange={(event) => setIncludeAudio(event.target.checked)}
              disabled={running}
            />
            Include source audio (when available)
          </label>

          <button
            onClick={() => {
              setWidth(Math.round(safeSource.width));
              setHeight(Math.round(safeSource.height));
              setFps(Math.round(safeSource.fps));
            }}
            disabled={running}
          >
            Reset to source
          </button>
        </div>

        <div className="export-actions">
          <button onClick={onCancel} disabled={running}>Cancel</button>
          <button
            className="active"
            onClick={() => {
              onConfirm({
                fileName: ensureExtension(fileName, format),
                format,
                fps: clampNumber(fps, 1, 120, Math.round(safeSource.fps)),
                width: clampNumber(width, 64, 7680, safeSource.width),
                height: clampNumber(height, 64, 4320, safeSource.height),
                bitrateMbps: clampNumber(bitrateMbps, 1, 80, 12),
                includeAudio,
                encoderMode,
                preset
              });
            }}
            disabled={running}
          >
            {running ? "Exporting..." : "Choose Output & Export"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ExportDialog;
