function TopBar({
  projectName,
  status,
  exportState,
  previewScale,
  isPreviewDetached,
  onOpenVideo,
  onAddVideo,
  onSaveProject,
  onLoadProject,
  onExportVideo,
  onPreviewScaleChange,
  onTogglePreviewDetach,
  disabled,
  canAddVideo
}) {
  return (
    <header className="top-bar">
      <div className="actions-row">
        <button onClick={onOpenVideo}>Open Video</button>
        <button onClick={onAddVideo} disabled={!canAddVideo}>
          Add Video
        </button>
        <button onClick={onSaveProject} disabled={disabled}>
          Save Project
        </button>
        <button onClick={onLoadProject}>Load Project</button>
        <button onClick={onExportVideo} disabled={disabled || exportState.running}>
          {exportState.running ? "Exporting..." : "Export Video"}
        </button>
        <button onClick={onTogglePreviewDetach} disabled={disabled}>
          {isPreviewDetached ? "Dock Preview" : "Undock Preview"}
        </button>
        <label className="preview-scale-control" htmlFor="preview-scale-select">
          Preview
          <select
            id="preview-scale-select"
            value={String(previewScale)}
            onChange={(event) => onPreviewScaleChange?.(Number(event.target.value))}
          >
            <option value="1">1x</option>
            <option value="0.75">3/4x</option>
            <option value="0.5">1/2x</option>
            <option value="0.25">1/4x</option>
          </select>
        </label>
      </div>

      <div className="project-meta">
        <strong>{projectName || "No video loaded"}</strong>
        <span>{status}</span>
        {exportState.running ? (
          <span>Export Progress: {(exportState.progress * 100).toFixed(1)}%</span>
        ) : null}
      </div>
    </header>
  );
}

export default TopBar;
