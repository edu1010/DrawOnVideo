import { createId } from "./id";
import { strokeDrawEndMs, strokeDrawStartMs } from "./strokeClip";

export const PROJECT_VERSION = 1;

export function createLayer(name = "Layer") {
  return {
    id: createId("layer"),
    name,
    visible: true,
    strokes: [],
    redoStack: []
  };
}

function cloneLayer(layer) {
  return {
    ...layer,
    strokes: [...(layer.strokes || [])],
    redoStack: [...(layer.redoStack || [])]
  };
}

function normalizeStroke(stroke) {
  const normalized = {
    ...stroke,
    id: stroke.id || createId("stroke"),
    tool: stroke.tool || "brush",
    color: stroke.color || "#ff6d5a",
    size: Number(stroke.size) || 6,
    opacity: Number(stroke.opacity) || 1,
    pressureEnabled: stroke.pressureEnabled !== false,
    pressureSensitivity: Number.isFinite(Number(stroke.pressureSensitivity))
      ? Math.max(0.2, Math.min(4, Number(stroke.pressureSensitivity)))
      : 1.7,
    pressureCurve: Number.isFinite(Number(stroke.pressureCurve))
      ? Math.max(0.2, Math.min(4, Number(stroke.pressureCurve)))
      : 1.75,
    pressureMinScale: Number.isFinite(Number(stroke.pressureMinScale))
      ? Math.max(0.02, Math.min(0.95, Number(stroke.pressureMinScale)))
      : 0.05,
    startFrame: Number(stroke.startFrame) || 0,
    endFrame: Number(stroke.endFrame) || Number(stroke.startFrame) || 0,
    points: Array.isArray(stroke.points) ? stroke.points : []
  };

  const hasStart = normalized.clipStartMs !== null && normalized.clipStartMs !== undefined;
  const hasEnd = normalized.clipEndMs !== null && normalized.clipEndMs !== undefined;
  const start = hasStart ? Number(normalized.clipStartMs) : Number.NaN;
  const end = hasEnd ? Number(normalized.clipEndMs) : Number.NaN;

  normalized.clipStartMs = Number.isFinite(start) ? Math.max(0, start) : strokeDrawStartMs(normalized);
  normalized.clipEndMs = Number.isFinite(end) ? Math.max(normalized.clipStartMs, end) : Number.POSITIVE_INFINITY;

  return normalized;
}

export function normalizeLayers(inputLayers) {
  if (!Array.isArray(inputLayers) || inputLayers.length === 0) {
    return [createLayer("Layer 1")];
  }

  return inputLayers.map((layer, index) => ({
    id: layer.id || createId("layer"),
    name: layer.name || `Layer ${index + 1}`,
    visible: layer.visible !== false,
    strokes: Array.isArray(layer.strokes) ? layer.strokes.map((stroke) => normalizeStroke(stroke)) : [],
    redoStack: []
  }));
}

export function addLayer(layers) {
  const next = [...layers, createLayer(`Layer ${layers.length + 1}`)];
  return next;
}

export function deleteLayer(layers, layerId) {
  const filtered = layers.filter((layer) => layer.id !== layerId);
  return filtered.length > 0 ? filtered : [createLayer("Layer 1")];
}

export function clearLayer(layers, layerId) {
  return layers.map((layer) => {
    if (layer.id !== layerId) {
      return layer;
    }

    return {
      ...layer,
      strokes: [],
      redoStack: []
    };
  });
}

export function toggleLayerVisibility(layers, layerId) {
  return layers.map((layer) => (layer.id === layerId ? { ...layer, visible: !layer.visible } : layer));
}

export function addStrokeToLayer(layers, layerId, stroke) {
  return layers.map((layer) => {
    if (layer.id !== layerId) {
      return layer;
    }

    const nextLayer = cloneLayer(layer);
    const normalizedStroke = normalizeStroke(stroke);
    if (!Number.isFinite(normalizedStroke.clipEndMs)) {
      normalizedStroke.clipEndMs = Math.max(
        normalizedStroke.clipStartMs,
        strokeDrawEndMs(normalizedStroke)
      );
    }

    nextLayer.strokes.push(normalizedStroke);
    nextLayer.redoStack = [];
    return nextLayer;
  });
}

export function updateStrokeOnLayer(layers, layerId, strokeId, updater) {
  return layers.map((layer) => {
    if (layer.id !== layerId) {
      return layer;
    }

    const nextLayer = cloneLayer(layer);
    nextLayer.strokes = nextLayer.strokes.map((stroke) => {
      if (stroke.id !== strokeId) {
        return stroke;
      }

      const updated = updater(stroke);
      return updated ? normalizeStroke(updated) : stroke;
    });
    return nextLayer;
  });
}

export function replaceStrokeOnLayer(layers, layerId, strokeId, replacementStrokes) {
  return layers.map((layer) => {
    if (layer.id !== layerId) {
      return layer;
    }

    const nextLayer = cloneLayer(layer);
    const replaced = [];
    for (const stroke of nextLayer.strokes) {
      if (stroke.id === strokeId) {
        for (const candidate of replacementStrokes || []) {
          replaced.push(normalizeStroke(candidate));
        }
      } else {
        replaced.push(stroke);
      }
    }

    nextLayer.strokes = replaced;
    return nextLayer;
  });
}

export function removeStrokeFromLayer(layers, layerId, strokeId) {
  return layers.map((layer) => {
    if (layer.id !== layerId) {
      return layer;
    }

    const nextLayer = cloneLayer(layer);
    nextLayer.strokes = nextLayer.strokes.filter((stroke) => stroke.id !== strokeId);
    nextLayer.redoStack = [];
    return nextLayer;
  });
}

export function removeStrokesFromLayer(layers, layerId, strokeIds) {
  const ids = new Set(strokeIds || []);
  if (ids.size === 0) {
    return layers;
  }

  return layers.map((layer) => {
    if (layer.id !== layerId) {
      return layer;
    }

    const nextLayer = cloneLayer(layer);
    nextLayer.strokes = nextLayer.strokes.filter((stroke) => !ids.has(stroke.id));
    nextLayer.redoStack = [];
    return nextLayer;
  });
}

export function moveStrokesToLayer(layers, selections, targetLayerId) {
  const targetId = String(targetLayerId || "");
  if (!targetId || !Array.isArray(selections) || selections.length === 0) {
    return layers;
  }

  const grouped = new Map();
  for (const selection of selections) {
    if (!selection?.layerId || !selection?.strokeId) {
      continue;
    }

    if (!grouped.has(selection.layerId)) {
      grouped.set(selection.layerId, new Set());
    }
    grouped.get(selection.layerId).add(selection.strokeId);
  }

  if (grouped.size === 0) {
    return layers;
  }

  const moved = [];
  const baseLayers = (layers || []).map((layer) => {
    const ids = grouped.get(layer.id);
    if (!ids || ids.size === 0) {
      return layer;
    }

    const kept = [];
    for (const stroke of layer.strokes || []) {
      if (ids.has(stroke.id)) {
        moved.push(stroke);
      } else {
        kept.push(stroke);
      }
    }

    return {
      ...layer,
      strokes: kept,
      redoStack: []
    };
  });

  if (moved.length === 0) {
    return layers;
  }

  return baseLayers.map((layer) => {
    if (layer.id !== targetId) {
      return layer;
    }

    return {
      ...layer,
      strokes: [...(layer.strokes || []), ...moved],
      redoStack: []
    };
  });
}

export function undoLayer(layers, layerId) {
  return layers.map((layer) => {
    if (layer.id !== layerId || layer.strokes.length === 0) {
      return layer;
    }

    const nextLayer = cloneLayer(layer);
    const stroke = nextLayer.strokes.pop();
    nextLayer.redoStack.push(stroke);
    return nextLayer;
  });
}

export function redoLayer(layers, layerId) {
  return layers.map((layer) => {
    if (layer.id !== layerId || layer.redoStack.length === 0) {
      return layer;
    }

    const nextLayer = cloneLayer(layer);
    const stroke = nextLayer.redoStack.pop();
    nextLayer.strokes.push(stroke);
    return nextLayer;
  });
}
