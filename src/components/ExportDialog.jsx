import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Stack,
  TextField
} from "@mui/material";

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

  return (
    <Dialog open={open} onClose={running ? undefined : onCancel} maxWidth="md" fullWidth>
      <DialogTitle>Export options</DialogTitle>
      <DialogContent dividers>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ mt: 0.5 }}>
          <TextField
            fullWidth
            label="File name"
            value={fileName}
            onChange={(event) => setFileName(event.target.value)}
            disabled={running}
          />
          <TextField
            select
            fullWidth
            label="Format"
            value={format}
            onChange={(event) => {
              const nextFormat = event.target.value;
              setFormat(nextFormat);
              setFileName((prev) => ensureExtension(prev, nextFormat));
            }}
            disabled={running}
          >
            <MenuItem value="mp4">MP4 (H264)</MenuItem>
            <MenuItem value="mov">MOV (H264)</MenuItem>
            <MenuItem value="webm">WebM (VP9)</MenuItem>
          </TextField>
        </Stack>

        <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ mt: 1.5 }}>
          <TextField
            type="number"
            fullWidth
            label="Framerate (FPS)"
            inputProps={{ min: 1, max: 120, step: 1 }}
            value={fps}
            onChange={(event) => setFps(clampNumber(event.target.value, 1, 120, 30))}
            disabled={running}
          />
          <TextField
            type="number"
            fullWidth
            label="Bitrate (Mbps)"
            inputProps={{ min: 1, max: 80, step: 0.5 }}
            value={bitrateMbps}
            onChange={(event) => setBitrateMbps(clampNumber(event.target.value, 1, 80, 12))}
            disabled={running}
          />
        </Stack>

        <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ mt: 1.5 }}>
          <TextField
            type="number"
            fullWidth
            label="Width"
            inputProps={{ min: 64, max: 7680, step: 2 }}
            value={width}
            onChange={(event) => setWidth(clampNumber(event.target.value, 64, 7680, safeSource.width))}
            disabled={running}
          />
          <TextField
            type="number"
            fullWidth
            label="Height"
            inputProps={{ min: 64, max: 4320, step: 2 }}
            value={height}
            onChange={(event) => setHeight(clampNumber(event.target.value, 64, 4320, safeSource.height))}
            disabled={running}
          />
        </Stack>

        <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ mt: 1.5 }}>
          <TextField
            select
            fullWidth
            label="Encoder"
            value={encoderMode}
            onChange={(event) => setEncoderMode(event.target.value)}
            disabled={running}
          >
            <MenuItem value="auto">Auto (try GPU, then CPU)</MenuItem>
            <MenuItem value="software">CPU (libx264)</MenuItem>
            <MenuItem value="nvidia">NVIDIA NVENC</MenuItem>
            <MenuItem value="intel">Intel QSV</MenuItem>
            <MenuItem value="amd">AMD AMF</MenuItem>
          </TextField>
          <TextField
            select
            fullWidth
            label="Preset"
            value={preset}
            onChange={(event) => setPreset(event.target.value)}
            disabled={running}
          >
            <MenuItem value="veryfast">Very Fast</MenuItem>
            <MenuItem value="fast">Fast</MenuItem>
            <MenuItem value="medium">Medium</MenuItem>
            <MenuItem value="slow">Slow</MenuItem>
          </TextField>
        </Stack>

        <Stack
          direction={{ xs: "column", sm: "row" }}
          alignItems={{ xs: "flex-start", sm: "center" }}
          justifyContent="space-between"
          spacing={1}
          sx={{ mt: 2 }}
        >
          <FormControlLabel
            control={(
              <Checkbox
                checked={includeAudio}
                onChange={(event) => setIncludeAudio(event.target.checked)}
                disabled={running}
              />
            )}
            label="Include source audio when available"
          />
          <Button
            variant="outlined"
            onClick={() => {
              setWidth(Math.round(safeSource.width));
              setHeight(Math.round(safeSource.height));
              setFps(Math.round(safeSource.fps));
            }}
            disabled={running}
          >
            Reset to source values
          </Button>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} disabled={running}>Cancel</Button>
        <Button
          variant="contained"
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
          {running ? "Exporting..." : "Choose output and export"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default ExportDialog;
