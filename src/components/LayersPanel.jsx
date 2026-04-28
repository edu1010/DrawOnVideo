import {
  Button,
  Chip,
  IconButton,
  Stack,
  Typography
} from "@mui/material";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import DriveFileMoveRoundedIcon from "@mui/icons-material/DriveFileMoveRounded";
import VisibilityOffRoundedIcon from "@mui/icons-material/VisibilityOffRounded";
import VisibilityRoundedIcon from "@mui/icons-material/VisibilityRounded";

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
      <Stack className="panel-header" direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="h6" component="h2">
          Annotation layers
        </Typography>
        <Button variant="contained" size="small" startIcon={<AddRoundedIcon />} onClick={onAddLayer}>
          Add
        </Button>
      </Stack>

      <div className="layers-list">
        {layers.map((layer) => (
          <div
            className={`layer-row ${layer.id === activeLayerId ? "active" : ""}`}
            key={layer.id}
            onClick={() => onSelectLayer(layer.id)}
          >
            <IconButton
              className="visibility-btn"
              size="small"
              title={layer.visible ? "Hide layer" : "Show layer"}
              onClick={(event) => {
                event.stopPropagation();
                onToggleVisibility(layer.id);
              }}
            >
              {layer.visible ? <VisibilityRoundedIcon fontSize="small" /> : <VisibilityOffRoundedIcon fontSize="small" />}
            </IconButton>
            <div className="layer-name-wrap">
              <span className="layer-name">{layer.name}</span>
              <Chip
                size="small"
                variant="outlined"
                label={`${layer.strokes.length} strokes`}
                sx={{ width: "fit-content", color: "text.secondary" }}
              />
            </div>
                <Button
              size="small"
              variant="outlined"
              startIcon={<DriveFileMoveRoundedIcon />}
              disabled={!selectedClipCount}
              onClick={(event) => {
                event.stopPropagation();
                onMoveSelectedToLayer?.(layer.id);
              }}
            >
              Move selected
            </Button>
            <Button
              size="small"
              variant="outlined"
              color="error"
              startIcon={<DeleteOutlineRoundedIcon />}
              onClick={(event) => {
                event.stopPropagation();
                onDeleteLayer(layer.id);
              }}
            >
              Delete
            </Button>
          </div>
        ))}
      </div>
    </aside>
  );
}

export default LayersPanel;
