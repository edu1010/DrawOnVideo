import { createId } from "./id";

function safeText(value, fallback) {
  const text = String(value || "").trim();
  return text || fallback;
}

export function createVideoLayer(name = "Video 1") {
  return {
    id: createId("vlayer"),
    name: safeText(name, "Video 1")
  };
}

export function normalizeVideoLayers(inputLayers) {
  if (!Array.isArray(inputLayers) || inputLayers.length === 0) {
    return [createVideoLayer("Video 1")];
  }

  return inputLayers.map((layer, index) => ({
    id: layer?.id || createId("vlayer"),
    name: safeText(layer?.name, `Video ${index + 1}`)
  }));
}

export function addVideoLayer(layers) {
  const nextIndex = (layers || []).length + 1;
  return [...(layers || []), createVideoLayer(`Video ${nextIndex}`)];
}

export function deleteVideoLayer(layers, layerId) {
  const filtered = (layers || []).filter((layer) => layer.id !== layerId);
  return filtered.length > 0 ? filtered : [createVideoLayer("Video 1")];
}

export function ensureClipVideoLayerIds(clips, layers) {
  const normalizedLayers = normalizeVideoLayers(layers);
  const ids = new Set(normalizedLayers.map((layer) => layer.id));
  const fallbackId = normalizedLayers[0].id;

  return (clips || []).map((clip) => {
    const clipLayerId = String(clip?.videoLayerId || "");
    if (ids.has(clipLayerId)) {
      return clip;
    }

    return {
      ...clip,
      videoLayerId: fallbackId
    };
  });
}

export function reassignClipsFromDeletedLayer(clips, deletedLayerId, fallbackLayerId) {
  const deleted = String(deletedLayerId || "");
  const fallback = String(fallbackLayerId || "");

  if (!deleted || !fallback || deleted === fallback) {
    return clips || [];
  }

  return (clips || []).map((clip) => {
    if (String(clip?.videoLayerId || "") !== deleted) {
      return clip;
    }

    return {
      ...clip,
      videoLayerId: fallback
    };
  });
}
