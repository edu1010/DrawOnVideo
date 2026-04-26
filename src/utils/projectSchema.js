import { PROJECT_VERSION, normalizeLayers } from "./layerOps";
import { normalizeVideoClips } from "./videoClipOps";
import { ensureClipVideoLayerIds, normalizeVideoLayers } from "./videoLayerOps";

export function buildProjectPayload({ videoPath, videoMeta, layers, videoClips, videoLayers }) {
  const serializableLayers = (layers || []).map((layer) => ({
    id: layer.id,
    name: layer.name,
    visible: layer.visible !== false,
    strokes: (layer.strokes || []).map((stroke) => ({
      id: stroke.id,
      tool: stroke.tool || "brush",
      color: stroke.color || "#ff5252",
      size: Number(stroke.size) || 6,
      opacity: Number(stroke.opacity) || 1,
      startFrame: Number(stroke.startFrame) || 0,
      endFrame: Number(stroke.endFrame) || Number(stroke.startFrame) || 0,
      clipStartMs: Number.isFinite(Number(stroke.clipStartMs)) ? Number(stroke.clipStartMs) : null,
      clipEndMs: Number.isFinite(Number(stroke.clipEndMs)) ? Number(stroke.clipEndMs) : null,
      points: (stroke.points || []).map((point) => ({
        x: Number(point.x) || 0,
        y: Number(point.y) || 0,
        timeMs: Number(point.timeMs) || 0,
        pressure: Number(point.pressure) || 1
      }))
    }))
  }));

  return {
    version: PROJECT_VERSION,
    createdAt: new Date().toISOString(),
    videoPath,
    videoLayers: (videoLayers || []).map((layer) => ({
      id: layer.id,
      name: layer.name || ""
    })),
    videoClips: (videoClips || []).map((clip) => ({
      id: clip.id,
      path: clip.path,
      name: clip.name || "",
      sourceDurationMs: Number(clip.sourceDurationMs) || 0,
      sourceStartMs: Number(clip.sourceStartMs) || 0,
      sourceEndMs: Number(clip.sourceEndMs) || 0,
      timelineStartMs: Number(clip.timelineStartMs) || 0,
      videoLayerId: clip.videoLayerId || "",
      audioMuted: Boolean(clip.audioMuted),
      audioGainDb: Number(clip.audioGainDb) || 0,
      fps: Number(clip.fps) || 30,
      width: Number(clip.width) || 1280,
      height: Number(clip.height) || 720
    })),
    videoMeta: {
      width: Number(videoMeta?.width) || 1280,
      height: Number(videoMeta?.height) || 720,
      fps: Number(videoMeta?.fps) || 30,
      duration: Number(videoMeta?.duration) || 0
    },
    layers: serializableLayers
  };
}

export function normalizeLoadedProject(project) {
  if (!project || typeof project !== "object") {
    throw new Error("Invalid project file.");
  }

  const hasVideoPath = Boolean(project.videoPath);
  const hasVideoClips = Array.isArray(project.videoClips) && project.videoClips.length > 0;
  if (!hasVideoPath && !hasVideoClips) {
    throw new Error("Project is missing video sources.");
  }

  const videoMeta = {
    width: Number(project.videoMeta?.width) || 1280,
    height: Number(project.videoMeta?.height) || 720,
    fps: Number(project.videoMeta?.fps) || 30,
    duration: Number(project.videoMeta?.duration) || 0
  };

  const layers = normalizeLayers(project.layers);
  const videoLayers = normalizeVideoLayers(project.videoLayers);
  const videoClips = ensureClipVideoLayerIds(normalizeVideoClips(project.videoClips), videoLayers);

  return {
    version: Number(project.version) || 1,
    videoPath: project.videoPath || (videoClips[0]?.path || ""),
    videoLayers,
    videoClips,
    videoMeta,
    layers
  };
}
