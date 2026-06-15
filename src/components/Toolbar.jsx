import { PRESSURE_PRESETS, TOOL_BRUSH, TOOL_ERASER } from "../constants";
import {
  Button,
  FormControlLabel,
  Slider,
  Stack,
  Switch,
  Typography
} from "@mui/material";

function Toolbar({
  brush,
  currentPressure,
  currentPressureInput,
  penDetected,
  tabletCapabilities,
  onionSkin,
  onBrushChange,
  onSetOnionSkin,
  onUndo,
  onRedo,
  onClearLayer,
  canDraw
}) {
  const safePressure = Math.max(0, Math.min(1, Number(currentPressure) || 0));
  const rawPressure = currentPressureInput?.rawPressure === null
    ? NaN
    : Number(currentPressureInput?.rawPressure);
  const rawPressureLabel = Number.isFinite(rawPressure)
    ? rawPressure.toFixed(rawPressure > 1 ? 0 : 3)
    : "--";
  const pointerLabel = currentPressureInput?.pointerType || "unknown";
  const hasHardwarePressure = Boolean(currentPressureInput?.hasHardwarePressure);
  const isStylusNow = Boolean(currentPressureInput?.isStylus);
  const hasTilt = Boolean(currentPressureInput?.hasTilt);
  const isMousePressureFallback = pointerLabel === "mouse"
    && Number.isFinite(rawPressure)
    && Math.abs(rawPressure - 0.5) < 0.0001
    && !hasHardwarePressure;
  const sourceLabel = currentPressureInput?.hasHardwarePressure
    ? currentPressureInput.source
    : "no real pressure";

  // Proactive device detection so the user knows their tablet is recognized
  // before they even draw a stroke.
  const finePointer = Boolean(tabletCapabilities?.finePointer);
  let deviceStatus;
  if (isStylusNow || penDetected) {
    deviceStatus = {
      tone: "ok",
      label: hasTilt ? "Stylus detected (tilt-capable)" : "Stylus detected",
      detail: "Pen pressure is active. Wacom / Huion ready."
    };
  } else if (isMousePressureFallback) {
    deviceStatus = {
      tone: "warn",
      label: "Tablet in mouse mode",
      detail: "Pressure is emulated. Enable \"Windows Ink\" and turn off \"Mouse mode\" in your Wacom / Huion driver."
    };
  } else if (finePointer) {
    deviceStatus = {
      tone: "idle",
      label: "Fine pointer detected",
      detail: "Touch the canvas with your pen to confirm pressure."
    };
  } else {
    deviceStatus = {
      tone: "idle",
      label: "No stylus detected yet",
      detail: "Connect your tablet and draw once. If it stays \"mouse\", enable Windows Ink in the driver."
    };
  }

  return (
    <aside className="toolbar-panel">
      <Typography variant="h6" component="h2" sx={{ mb: 1.5 }}>
        Drawing tools
      </Typography>

      <div className="control-group">
        <Typography variant="subtitle2" color="text.secondary">
          Tool
        </Typography>
        <Stack className="tool-row" direction="row" gap={1}>
          <Button
            size="small"
            variant={brush.tool === TOOL_BRUSH ? "contained" : "outlined"}
            className={brush.tool === TOOL_BRUSH ? "active" : ""}
            onClick={() => onBrushChange({ tool: TOOL_BRUSH })}
            disabled={!canDraw}
          >
            Brush
          </Button>
          <Button
            size="small"
            variant={brush.tool === TOOL_ERASER ? "contained" : "outlined"}
            className={brush.tool === TOOL_ERASER ? "active" : ""}
            onClick={() => onBrushChange({ tool: TOOL_ERASER })}
            disabled={!canDraw}
          >
            Eraser
          </Button>
        </Stack>
      </div>

      <div className="control-group">
        <Typography variant="subtitle2" color="text.secondary" component="label" htmlFor="brush-color">
          Color
        </Typography>
        <input
          id="brush-color"
          type="color"
          value={brush.color}
          onChange={(event) => onBrushChange({ color: event.target.value })}
          disabled={!canDraw || brush.tool === TOOL_ERASER}
        />
      </div>

      <div className="control-group">
        <Typography variant="subtitle2" color="text.secondary" component="label" htmlFor="brush-size">
          Size ({brush.size.toFixed(1)})
        </Typography>
        <Slider
          id="brush-size"
          min={1}
          max={80}
          step={0.5}
          value={brush.size}
          onChange={(_, value) => onBrushChange({ size: Number(value) })}
          disabled={!canDraw}
        />
      </div>

      <div className="control-group">
        <Typography variant="subtitle2" color="text.secondary" component="label" htmlFor="brush-opacity">
          Opacity ({brush.opacity.toFixed(2)})
        </Typography>
        <Slider
          id="brush-opacity"
          min={0.05}
          max={1}
          step={0.01}
          value={brush.opacity}
          onChange={(_, value) => onBrushChange({ opacity: Number(value) })}
          disabled={!canDraw || brush.tool === TOOL_ERASER}
        />
      </div>

      <div className={`control-group tablet-status tablet-status-${deviceStatus.tone}`}>
        <div className="tablet-status-head">
          <span className="tablet-status-dot" aria-hidden />
          <strong>{deviceStatus.label}</strong>
        </div>
        <span className="tablet-status-detail">{deviceStatus.detail}</span>
        <span className="tablet-status-meta">
          Pointer: {pointerLabel} | Pressure: {hasHardwarePressure ? "hardware" : "none"}
          {hasTilt ? " | tilt" : ""}
        </span>
      </div>

      <div className="control-group checkbox-group">
        <FormControlLabel
          control={
            <Switch
            checked={brush.pressureEnabled}
            onChange={(event) => onBrushChange({ pressureEnabled: event.target.checked })}
            disabled={!canDraw}
            />
          }
          label="Use stylus pressure"
        />
      </div>

      {brush.pressureEnabled ? (
        <>
          <div className="control-group">
            <label>Current Pressure</label>
            <div className="pressure-live-value">
              {(safePressure * 100).toFixed(1)}%
              <span>
                Input: {pointerLabel} | Raw: {rawPressureLabel} | Source: {sourceLabel}
              </span>
              {isMousePressureFallback ? (
                <span className="pressure-warning">
                  Mouse pressure emulation detected. In the Wacom / Huion driver, enable
                  "Windows Ink" and disable "Mouse mode" so real pen pressure is sent.
                </span>
              ) : null}
            </div>
          </div>

          <div className="control-group">
            <Typography variant="subtitle2" color="text.secondary">
              Pressure Presets
            </Typography>
            <Stack className="tool-row wrap" direction="row" gap={1}>
              {PRESSURE_PRESETS.map((preset) => (
                <Button
                  key={preset.id}
                  type="button"
                  size="small"
                  variant="outlined"
                  onClick={() => onBrushChange(preset.values)}
                  disabled={!canDraw}
                >
                  {preset.label}
                </Button>
              ))}
            </Stack>
          </div>

          <div className="control-group">
            <Typography variant="subtitle2" color="text.secondary" component="label" htmlFor="pressure-sensitivity">
              Pressure Sensitivity ({Number(brush.pressureSensitivity || 1).toFixed(2)})
            </Typography>
            <Slider
              id="pressure-sensitivity"
              min={0.2}
              max={4}
              step={0.05}
              value={Number(brush.pressureSensitivity) || 1}
              onChange={(_, value) => onBrushChange({ pressureSensitivity: Number(value) })}
              disabled={!canDraw}
            />
          </div>

          <div className="control-group">
            <Typography variant="subtitle2" color="text.secondary" component="label" htmlFor="pressure-curve">
              Pressure Curve ({Number(brush.pressureCurve || 1).toFixed(2)})
            </Typography>
            <Slider
              id="pressure-curve"
              min={0.2}
              max={4}
              step={0.05}
              value={Number(brush.pressureCurve) || 1}
              onChange={(_, value) => onBrushChange({ pressureCurve: Number(value) })}
              disabled={!canDraw}
            />
          </div>

          <div className="control-group">
            <Typography variant="subtitle2" color="text.secondary" component="label" htmlFor="pressure-min-scale">
              Min Pressure Size ({Math.round((Number(brush.pressureMinScale) || 0.05) * 100)}%)
            </Typography>
            <Slider
              id="pressure-min-scale"
              min={0.02}
              max={0.95}
              step={0.01}
              value={Number(brush.pressureMinScale) || 0.05}
              onChange={(_, value) => onBrushChange({ pressureMinScale: Number(value) })}
              disabled={!canDraw}
            />
          </div>
        </>
      ) : null}

      <div className="control-group checkbox-group">
        <FormControlLabel
          control={
            <Switch
            checked={onionSkin}
            onChange={(event) => onSetOnionSkin(event.target.checked)}
            disabled={!canDraw}
            />
          }
          label="Show previous frame (onion skin)"
        />
      </div>

      <Stack className="tool-row wrap" direction="row" gap={1}>
        <Button variant="outlined" onClick={onUndo} disabled={!canDraw}>
          Undo
        </Button>
        <Button variant="outlined" onClick={onRedo} disabled={!canDraw}>
          Redo
        </Button>
        <Button variant="outlined" color="error" onClick={onClearLayer} disabled={!canDraw}>
          Clear Layer
        </Button>
      </Stack>
    </aside>
  );
}

export default Toolbar;
