import { TOOL_BRUSH, TOOL_ERASER } from "../constants";

function Toolbar({
  brush,
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