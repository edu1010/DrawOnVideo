function TopBar({
  projectName,
  status,
  exportState,
  onOpenVideo,
  onAddVideo,
  onSaveProject,
  onLoadProject,
  onExportVideo,
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
