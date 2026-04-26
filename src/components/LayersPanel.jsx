function LayersPanel({
  layers,
  activeLayerId,
  onSelectLayer,
  onAddLayer,
  onDeleteLayer,
  onToggleVisibility,
  selectedClipCount,
  onMoveSelectedToLayer
}) {
  return (
    <aside className="layers-panel">
      <div className="panel-header">
        <h2>Layers</h2>
        <button onClick={onAddLayer}>+ Layer</button>
      </div>

      <div className="layers-list">
        {layers.map((layer) => (
          <div
            className={`layer-row ${layer.id === activeLayerId ? "active" : ""}`}
            key={layer.id}
            onClick={() => onSelectLayer(layer.id)}
          >
            <button
              className="visibility-btn"
              title={layer.visible ? "Hide layer" : "Show layer"}
              onClick={(event) => {
                event.stopPropagation();
                onToggleVisibility(layer.id);
              }}
            >
              {layer.visible ? "On" : "Off"}
            </button>
            <div className="layer-name-wrap">
              <span className="layer-name">{layer.name}</span>
              <span className="layer-meta">{layer.strokes.length} strokes</span>
            </div>
            <button
              disabled={!selectedClipCount}
              onClick={(event) => {
                event.stopPropagation();
                onMoveSelectedToLayer?.(layer.id);
              }}
            >
              Move Sel
            </button>
            <button
              className="danger"
              onClick={(event) => {
                event.stopPropagation();
                onDeleteLayer(layer.id);
              }}
            >
              Delete
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}

export default LayersPanel;
