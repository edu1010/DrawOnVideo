import { PRESSURE_PRESETS, TOOL_BRUSH, TOOL_ERASER } from "../constants";

function Toolbar({
  brush,
  currentPressure,
  onionSkin,
  onBrushChange,
  onSetOnionSkin,
  onUndo,
  onRedo,
  onClearLayer,
  canDraw
}) {
  return (
    <aside className="toolbar-panel">
      <h2>Tools</h2>

      <div className="control-group">
        <label>Tool</label>
        <div className="tool-row">
          <button
            className={brush.tool === TOOL_BRUSH ? "active" : ""}
            onClick={() => onBrushChange({ tool: TOOL_BRUSH })}
            disabled={!canDraw}
          >
            Brush
          </button>
          <button
            className={brush.tool === TOOL_ERASER ? "active" : ""}
            onClick={() => onBrushChange({ tool: TOOL_ERASER })}
            disabled={!canDraw}
          >
            Eraser
          </button>
        </div>
      </div>

      <div className="control-group">
        <label htmlFor="brush-color">Color</label>
        <input
          id="brush-color"
          type="color"
          value={brush.color}
          onChange={(event) => onBrushChange({ color: event.target.value })}
          disabled={!canDraw || brush.tool === TOOL_ERASER}
        />
      </div>

      <div className="control-group">
        <label htmlFor="brush-size">Size ({brush.size.toFixed(1)})</label>
        <input
          id="brush-size"
          type="range"
          min={1}
          max={80}
          step={0.5}
          value={brush.size}
          onChange={(event) => onBrushChange({ size: Number(event.target.value) })}
          disabled={!canDraw}
        />
      </div>

      <div className="control-group">
        <label htmlFor="brush-opacity">Opacity ({brush.opacity.toFixed(2)})</label>
        <input
          id="brush-opacity"
          type="range"
          min={0.05}
          max={1}
          step={0.01}
          value={brush.opacity}
          onChange={(event) => onBrushChange({ opacity: Number(event.target.value) })}
          disabled={!canDraw || brush.tool === TOOL_ERASER}
        />
      </div>

      <div className="control-group checkbox-group">
        <label>
          <input
            type="checkbox"
            checked={brush.pressureEnabled}
            onChange={(event) => onBrushChange({ pressureEnabled: event.target.checked })}
            disabled={!canDraw}
          />
          Use pressure (pen tablets)
        </label>
      </div>

      {brush.pressureEnabled ? (
        <>
          <div className="control-group">
            <label>Current Pressure</label>
            <div className="pressure-live-value">
              {(Math.max(0, Math.min(1, Number(currentPressure) || 0)) * 100).toFixed(0)}%
            </div>
          </div>

          <div className="control-group">
            <label>Pressure Presets</label>
            <div className="tool-row wrap">
              {PRESSURE_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => onBrushChange(preset.values)}
                  disabled={!canDraw}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          <div className="control-group">
            <label htmlFor="pressure-sensitivity">
              Pressure Sensitivity ({Number(brush.pressureSensitivity || 1).toFixed(2)})
            </label>
            <input
              id="pressure-sensitivity"
              type="range"
              min={0.2}
              max={4}
              step={0.05}
              value={Number(brush.pressureSensitivity) || 1}
              onChange={(event) => onBrushChange({ pressureSensitivity: Number(event.target.value) })}
              disabled={!canDraw}
            />
          </div>

          <div className="control-group">
            <label htmlFor="pressure-curve">
              Pressure Curve ({Number(brush.pressureCurve || 1).toFixed(2)})
            </label>
            <input
              id="pressure-curve"
              type="range"
              min={0.2}
              max={4}
              step={0.05}
              value={Number(brush.pressureCurve) || 1}
              onChange={(event) => onBrushChange({ pressureCurve: Number(event.target.value) })}
              disabled={!canDraw}
            />
          </div>

          <div className="control-group">
            <label htmlFor="pressure-min-scale">
              Min Pressure Size ({Math.round((Number(brush.pressureMinScale) || 0.05) * 100)}%)
            </label>
            <input
              id="pressure-min-scale"
              type="range"
              min={0.02}
              max={0.95}
              step={0.01}
              value={Number(brush.pressureMinScale) || 0.05}
              onChange={(event) => onBrushChange({ pressureMinScale: Number(event.target.value) })}
              disabled={!canDraw}
            />
          </div>
        </>
      ) : null}

      <div className="control-group checkbox-group">
        <label>
          <input
            type="checkbox"
            checked={onionSkin}
            onChange={(event) => onSetOnionSkin(event.target.checked)}
            disabled={!canDraw}
          />
          Onion-skin preview (previous frame)
        </label>
      </div>

      <div className="tool-row wrap">
        <button onClick={onUndo} disabled={!canDraw}>
          Undo
        </button>
        <button onClick={onRedo} disabled={!canDraw}>
          Redo
        </button>
        <button onClick={onClearLayer} disabled={!canDraw}>
          Clear Layer
        </button>
      </div>
    </aside>
  );
}

export default Toolbar;
