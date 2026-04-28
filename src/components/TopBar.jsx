import {
  Box,
  Button,
  FormControl,
  MenuItem,
  Select,
  Stack,
  Typography
} from "@mui/material";

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
      <Stack className="actions-row" direction="row" flexWrap="wrap" gap={1}>
        <Button variant="contained" onClick={onOpenVideo}>
          Open video
        </Button>
        <Button variant="outlined" onClick={onAddVideo} disabled={!canAddVideo}>
          Add clip
        </Button>
        <Button variant="outlined" onClick={onSaveProject} disabled={disabled}>
          Save project
        </Button>
        <Button variant="outlined" onClick={onLoadProject}>
          Open project
        </Button>
        <Button variant="contained" color="secondary" onClick={onExportVideo} disabled={disabled || exportState.running}>
          {exportState.running ? "Exporting..." : "Export video"}
        </Button>
        <Button variant="text" onClick={onTogglePreviewDetach} disabled={disabled}>
          {isPreviewDetached ? "Dock preview" : "Detach preview"}
        </Button>
        <FormControl size="small" sx={{ minWidth: 120 }}>
          <Typography variant="caption" sx={{ color: "text.secondary", mb: 0.5 }}>
            Preview
          </Typography>
          <Select
            id="preview-scale-select"
            value={String(previewScale)}
            onChange={(event) => onPreviewScaleChange?.(Number(event.target.value))}
          >
            <MenuItem value="1">1x</MenuItem>
            <MenuItem value="0.75">3/4x</MenuItem>
            <MenuItem value="0.5">1/2x</MenuItem>
            <MenuItem value="0.25">1/4x</MenuItem>
          </Select>
        </FormControl>
      </Stack>

      <Box className="project-meta">
        <Typography variant="subtitle1" component="strong">
          {projectName || "No video clip loaded"}
        </Typography>
        <Typography variant="body2">{status}</Typography>
        {exportState.running ? (
          <Typography variant="caption">
            Export Progress: {(exportState.progress * 100).toFixed(1)}%
          </Typography>
        ) : null}
      </Box>
    </header>
  );
}

export default TopBar;
