import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import TopBar from "./components/TopBar";
import Toolbar from "./components/Toolbar";
import LayersPanel from "./components/LayersPanel";
import TimelineBar from "./components/TimelineBar";
import ExportDialog from "./components/ExportDialog";
import { DEFAULT_BRUSH, DEFAULT_VIDEO_META } from "./constants";
import {
  createLayer,
  addLayer,
  addStrokeToLayer,
  clearLayer,
  deleteLayer,
  moveStrokesToLayer,
  normalizeLayers,
  removeStrokesFromLayer,
  replaceStrokeOnLayer,
  redoLayer,
  toggleLayerVisibility,
  undoLayer,
  updateStrokeOnLayer
} from "./utils/layerOps";
import { buildProjectPayload, normalizeLoadedProject } from "./utils/projectSchema";
import { createId } from "./utils/id";
import { clamp, frameFromTimeMs } from "./utils/time";
import { createRenderState, renderAnnotationOverlay } from "./engine/rendering";
import { renderAndRecordAnnotatedVideo } from "./engine/exportRenderer";
import { shiftStrokeInTime, splitStrokeAtTime, strokeClipWindowMs, withStrokeClipWindow } from "./utils/strokeClip";
import {
  createVideoClip,
  findVideoClipAtTime,
  moveVideoClip,
  moveVideoClipsToLayer,
  normalizeVideoClips,
  removeVideoClips,
  sortVideoClips,
  splitVideoClip,
  totalTimelineDurationMs,
  trimVideoClip
} from "./utils/videoClipOps";
import {
  addVideoLayer,
  createVideoLayer,
  deleteVideoLayer,
  ensureClipVideoLayerIds,
  normalizeVideoLayers,
  reassignClipsFromDeletedLayer
} from "./utils/videoLayerOps";

const desktopAPI = window.desktopAPI;

// Stack rationale:
// Electron + React + Canvas gives a strong desktop MVP balance:
// 1) local desktop runtime + filesystem/ffmpeg access,
// 2) responsive modular UI composition,
// 3) high-frequency drawing + pointer pressure input on a GPU-accelerated canvas.

function fileNameFromPath(filePath) {
  if (!filePath) {
    return "";
  }

  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] || filePath;
}

function normalizePressure(pointerEvent, pressureEnabled) {
  if (!pressureEnabled || pointerEvent.pointerType === "mouse") {
    return 1;
  }

  const pressure = Number(pointerEvent.pressure);
  if (!Number.isFinite(pressure) || pressure <= 0) {
    return 1;
  }

  return Math.min(1, Math.max(0.05, pressure));
}

function mediaErrorMessage(mediaError) {
  if (!mediaError) {
    return "Unknown playback error.";
  }

  switch (mediaError.code) {
    case 1:
      return "Playback aborted by user or app.";
    case 2:
      return "Network/loading error while reading media file.";
    case 3:
      return "Decoding error. Codec is likely unsupported.";
    case 4:
      return "Unsupported source/codec for Chromium/Electron video playback.";
    default:
      return mediaError.message || "Unknown playback error.";
  }
}

function clipSelectionKey(layerId, strokeId) {
  return `${layerId}::${strokeId}`;
}

function clampDb(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.min(18, Math.max(-60, number));
}

function volumeFromDb(db) {
  const linear = 10 ** (clampDb(db) / 20);
  return Math.min(1, Math.max(0, linear));
}

function clipLocalRangeMs(clip, videoDurationMs = 0) {
  const startMs = Math.max(0, Number(clip?.sourceStartMs) || 0);
  const explicitEnd = Number(clip?.sourceEndMs);
  if (Number.isFinite(explicitEnd) && explicitEnd > startMs) {
    return { startMs, endMs: explicitEnd };
  }

  const sourceDuration = Number(clip?.sourceDurationMs);
  if (Number.isFinite(sourceDuration) && sourceDuration > startMs) {
    return { startMs, endMs: sourceDuration };
  }

  if (Number.isFinite(videoDurationMs) && videoDurationMs > 0) {
    return { startMs, endMs: startMs + videoDurationMs };
  }

  return { startMs, endMs: startMs + 1000 };
}

function App() {
  const initialLayer = useMemo(() => createLayer("Layer 1"), []);
  const initialVideoLayer = useMemo(() => createVideoLayer("Video 1"), []);

  const [videoPath, setVideoPath] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [videoLayers, setVideoLayers] = useState([initialVideoLayer]);
  const [activeVideoLayerId, setActiveVideoLayerId] = useState(initialVideoLayer.id);
  const [videoClips, setVideoClips] = useState([]);
  const [currentVideoClipId, setCurrentVideoClipId] = useState(null);
  const [videoMeta, setVideoMeta] = useState(DEFAULT_VIDEO_META);
  const [layers, setLayers] = useState([initialLayer]);
  const [activeLayerId, setActiveLayerId] = useState(initialLayer.id);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [brush, setBrush] = useState(DEFAULT_BRUSH);
  const [onionSkin, setOnionSkin] = useState(false);
  const [status, setStatus] = useState("Ready. Open a local video to start annotating.");
  const [exportState, setExportState] = useState({ running: false, progress: 0 });
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [selectedClips, setSelectedClips] = useState([]);
  const [selectedVideoClipIds, setSelectedVideoClipIds] = useState([]);
  const [leftPanelWidth, setLeftPanelWidth] = useState(270);
  const [rightPanelWidth, setRightPanelWidth] = useState(300);
  const [timelineViewportHeight, setTimelineViewportHeight] = useState(260);

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const videoLayersRef = useRef(videoLayers);
  const activeVideoLayerIdRef = useRef(activeVideoLayerId);
  const videoClipsRef = useRef(videoClips);
  const currentVideoClipIdRef = useRef(currentVideoClipId);
  const layersRef = useRef(layers);
  const activeLayerIdRef = useRef(activeLayerId);
  const videoMetaRef = useRef(videoMeta);
  const brushRef = useRef(brush);
  const onionSkinRef = useRef(onionSkin);
  const currentTimeRef = useRef(0);

  const activeStrokeRef = useRef(null);
  const pointerIdRef = useRef(null);
  const renderStateRef = useRef(createRenderState());
  const dirtyRef = useRef(true);
  const lastFrameRef = useRef(-1);
  const resizeRef = useRef(null);
  const pendingVideoSeekRef = useRef(null);

  useEffect(() => {
    videoLayersRef.current = videoLayers;
    dirtyRef.current = true;
  }, [videoLayers]);

  useEffect(() => {
    activeVideoLayerIdRef.current = activeVideoLayerId;
    dirtyRef.current = true;
  }, [activeVideoLayerId]);

  useEffect(() => {
    videoClipsRef.current = videoClips;
    dirtyRef.current = true;
  }, [videoClips]);

  useEffect(() => {
    currentVideoClipIdRef.current = currentVideoClipId;
    dirtyRef.current = true;
  }, [currentVideoClipId]);

  useEffect(() => {
    layersRef.current = layers;
    dirtyRef.current = true;
  }, [layers]);

  useEffect(() => {
    activeLayerIdRef.current = activeLayerId;
    dirtyRef.current = true;
  }, [activeLayerId]);

  useEffect(() => {
    videoMetaRef.current = videoMeta;
    dirtyRef.current = true;
  }, [videoMeta]);

  useEffect(() => {
    brushRef.current = brush;
  }, [brush]);

  useEffect(() => {
    onionSkinRef.current = onionSkin;
    dirtyRef.current = true;
  }, [onionSkin]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    canvas.width = Math.max(1, Math.round(videoMeta.width || DEFAULT_VIDEO_META.width));
    canvas.height = Math.max(1, Math.round(videoMeta.height || DEFAULT_VIDEO_META.height));
    renderStateRef.current = createRenderState();
    dirtyRef.current = true;
  }, [videoMeta.width, videoMeta.height]);

  useEffect(() => {
    const ordered = sortVideoClips(videoClips);
    if (ordered.length === 0) {
      return;
    }

    const totalMs = totalTimelineDurationMs(ordered);
    const first = ordered[0];

    setVideoMeta((prev) => ({
      width: Number(first.width) || prev.width || DEFAULT_VIDEO_META.width,
      height: Number(first.height) || prev.height || DEFAULT_VIDEO_META.height,
      fps: Number(first.fps) || prev.fps || DEFAULT_VIDEO_META.fps,
      duration: totalMs / 1000
    }));

    if (!videoPath) {
      setVideoPath(first.path || "");
    }
  }, [videoClips, videoPath]);

  const seekGlobalTimeMs = useCallback((targetMs, options = {}) => {
    const { autoplay = false } = options;
    const ordered = sortVideoClips(videoClipsRef.current);
    const totalMs = totalTimelineDurationMs(ordered);
    const video = videoRef.current;
    const metaDurationMs = Math.max(0, (Number(videoMetaRef.current.duration) || 0) * 1000);
    const mediaDurationMs = Number.isFinite(Number(video?.duration))
      ? Number(video.duration) * 1000
      : 0;
    const requestedTargetMs = Math.max(0, Number(targetMs) || 0);
    let effectiveTotalMs = Math.max(totalMs, metaDurationMs, mediaDurationMs);

    if (effectiveTotalMs <= 0 && ordered.length > 0) {
      const activeClip = ordered.find((clip) => clip.id === currentVideoClipIdRef.current) || ordered[0];
      if (activeClip) {
        const activeRange = clipLocalRangeMs(activeClip, mediaDurationMs);
        const activeClipDurationMs = Math.max(0, activeRange.endMs - activeRange.startMs);
        effectiveTotalMs = Math.max(
          effectiveTotalMs,
          (Number(activeClip.timelineStartMs) || 0) + activeClipDurationMs
        );
      }
    }

    if (effectiveTotalMs <= 0) {
      effectiveTotalMs = requestedTargetMs;
    }

    const safeTargetMs = effectiveTotalMs > 0
      ? clamp(requestedTargetMs, 0, effectiveTotalMs)
      : requestedTargetMs;
    const clip = findVideoClipAtTime(ordered, safeTargetMs, {
      preferredLayerId: activeVideoLayerIdRef.current,
      layerOrderIds: (videoLayersRef.current || []).map((layer) => layer.id)
    });

    if (!clip || !video) {
      currentTimeRef.current = safeTargetMs / 1000;
      setCurrentTime(safeTargetMs / 1000);
      return;
    }

    const safeGlobalMs = safeTargetMs;
    const timelineStartMs = Number(clip.timelineStartMs) || 0;
    const loadedVideoDurationMs = Number.isFinite(Number(video.duration)) ? Number(video.duration) * 1000 : 0;
    const localRange = clipLocalRangeMs(clip, loadedVideoDurationMs);
    const unclampedLocalMs = localRange.startMs + (safeGlobalMs - timelineStartMs);
    const localMs = clamp(unclampedLocalMs, localRange.startMs, localRange.endMs);

    currentTimeRef.current = safeGlobalMs / 1000;
    setCurrentTime(safeGlobalMs / 1000);
    dirtyRef.current = true;

    const needsSourceSwap = videoUrl !== clip.url;
    if (needsSourceSwap) {
      pendingVideoSeekRef.current = {
        clipId: clip.id,
        localMs,
        autoplay
      };
      setCurrentVideoClipId(clip.id);
      setVideoUrl(clip.url);
      return;
    }

    if (currentVideoClipIdRef.current !== clip.id) {
      setCurrentVideoClipId(clip.id);
    }
    if (clip.videoLayerId && clip.videoLayerId !== activeVideoLayerIdRef.current) {
      setActiveVideoLayerId(clip.videoLayerId);
    }

    video.currentTime = localMs / 1000;
    if (autoplay) {
      video.play().catch(() => {});
    }
  }, [videoUrl]);

  const drawOverlay = useCallback((timeSeconds) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) {
      return;
    }

    renderAnnotationOverlay({
      targetCtx: ctx,
      width: canvas.width,
      height: canvas.height,
      layers: layersRef.current,
      timeSeconds,
      fps: videoMetaRef.current.fps,
      renderState: renderStateRef.current,
      activeStroke: activeStrokeRef.current,
      onionSkin: onionSkinRef.current
    });
  }, []);

  useEffect(() => {
    let rafId;

    const tick = () => {
      const video = videoRef.current;

      if (video && videoUrl) {
        const orderedClips = sortVideoClips(videoClipsRef.current);
        const activeClip = orderedClips.find((clip) => clip.id === currentVideoClipIdRef.current) || null;

        const localMs = (Number(video.currentTime) || 0) * 1000;
        const globalMs = activeClip
          ? (Number(activeClip.timelineStartMs) || 0) + (localMs - (Number(activeClip.sourceStartMs) || 0))
          : localMs;
        const now = Math.max(0, globalMs / 1000);
        const frame = Math.round(now * (videoMetaRef.current.fps || 30));
        const shouldRender =
          dirtyRef.current ||
          isPlaying ||
          activeStrokeRef.current !== null ||
          frame !== lastFrameRef.current;

        if (shouldRender) {
          drawOverlay(now);
          dirtyRef.current = false;
          lastFrameRef.current = frame;
        }

        if (Math.abs(currentTimeRef.current - now) >= 1 / 120) {
          currentTimeRef.current = now;
          setCurrentTime(now);
        }

        const visibleClip = findVideoClipAtTime(orderedClips, globalMs, {
          preferredLayerId: activeVideoLayerIdRef.current,
          layerOrderIds: (videoLayersRef.current || []).map((layer) => layer.id)
        });
        const audioClip = visibleClip || activeClip;

        if (audioClip) {
          const isMuted = Boolean(audioClip.audioMuted);
          video.muted = isMuted;
          video.volume = isMuted ? 0 : volumeFromDb(audioClip.audioGainDb);
        } else {
          video.muted = false;
          video.volume = 1;
        }

        if (
          isPlaying
          && pendingVideoSeekRef.current === null
          && visibleClip
          && visibleClip.id !== currentVideoClipIdRef.current
        ) {
          seekGlobalTimeMs(globalMs, { autoplay: true });
        }

        if (isPlaying && activeClip) {
          const activeEndMs = Number(activeClip.sourceEndMs) || Number.POSITIVE_INFINITY;
          const toleranceMs = 1000 / Math.max(videoMetaRef.current.fps || 30, 1);
          if (localMs >= activeEndMs - toleranceMs) {
            const timelineEndMs = Math.max(0, (Number(videoMetaRef.current.duration) || 0) * 1000);
            const nextGlobalMs = Math.min(timelineEndMs, globalMs + toleranceMs * 1.2);

            if (nextGlobalMs > globalMs + 0.1 && nextGlobalMs < timelineEndMs - 0.1) {
              seekGlobalTimeMs(nextGlobalMs, { autoplay: true });
            } else {
              video.pause();
            }
          }
        }
      } else if (dirtyRef.current) {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");
        if (canvas && ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
        dirtyRef.current = false;
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [drawOverlay, isPlaying, seekGlobalTimeMs, videoUrl]);

  useEffect(() => {
    if (!layers.some((layer) => layer.id === activeLayerId)) {
      setActiveLayerId(layers[0]?.id || createLayer("Layer 1").id);
    }
  }, [activeLayerId, layers]);

  useEffect(() => {
    if (!videoLayers.some((layer) => layer.id === activeVideoLayerId)) {
      setActiveVideoLayerId(videoLayers[0]?.id || null);
    }
  }, [activeVideoLayerId, videoLayers]);

  const mapPointerToVideo = useCallback((event) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return null;
    }

    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }

    const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((event.clientY - rect.top) / rect.height) * canvas.height;

    return {
      x: clamp(x, 0, canvas.width),
      y: clamp(y, 0, canvas.height)
    };
  }, []);

  const finalizeStroke = useCallback(() => {
    const stroke = activeStrokeRef.current;
    const targetLayerId = activeLayerIdRef.current;

    if (!stroke || !targetLayerId) {
      activeStrokeRef.current = null;
      pointerIdRef.current = null;
      dirtyRef.current = true;
      return;
    }

    const drawStartMs = Number(stroke.points?.[0]?.timeMs) || 0;
    const drawEndMs = Number(stroke.points?.[stroke.points.length - 1]?.timeMs) || drawStartMs;
    const videoDurationMs = Number(videoMetaRef.current.duration) > 0
      ? Number(videoMetaRef.current.duration) * 1000
      : drawEndMs;

    const finalizedStroke = {
      ...stroke,
      clipStartMs: drawStartMs,
      clipEndMs: Math.max(drawEndMs, videoDurationMs)
    };

    setLayers((prevLayers) => addStrokeToLayer(prevLayers, targetLayerId, finalizedStroke));
    setSelectedClips([{ layerId: targetLayerId, strokeId: finalizedStroke.id }]);

    activeStrokeRef.current = null;
    pointerIdRef.current = null;
    dirtyRef.current = true;
  }, []);

  const handleCanvasPointerDown = useCallback(
    (event) => {
      if (!videoPath || exportState.running) {
        return;
      }

      if (pointerIdRef.current !== null) {
        return;
      }

      if (event.button !== 0 && event.pointerType !== "pen") {
        return;
      }

      const point = mapPointerToVideo(event);
      if (!point) {
        return;
      }

      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);

      const nowSeconds = videoRef.current?.currentTime || 0;
      const nowMs = nowSeconds * 1000;
      const frame = frameFromTimeMs(nowMs, videoMetaRef.current.fps);

      activeStrokeRef.current = {
        id: createId("stroke"),
        tool: brushRef.current.tool,
        color: brushRef.current.color,
        size: brushRef.current.size,
        opacity: brushRef.current.opacity,
        pressureEnabled: brushRef.current.pressureEnabled,
        startFrame: frame,
        endFrame: frame,
        clipStartMs: nowMs,
        clipEndMs: Number.isFinite(videoMetaRef.current.duration) && videoMetaRef.current.duration > 0
          ? videoMetaRef.current.duration * 1000
          : nowMs,
        points: [
          {
            ...point,
            timeMs: nowMs,
            pressure: normalizePressure(event, brushRef.current.pressureEnabled)
          }
        ]
      };

      pointerIdRef.current = event.pointerId;
      dirtyRef.current = true;
    },
    [exportState.running, mapPointerToVideo, videoPath]
  );

  const handleCanvasPointerMove = useCallback(
    (event) => {
      if (pointerIdRef.current !== event.pointerId || !activeStrokeRef.current) {
        return;
      }

      const point = mapPointerToVideo(event);
      if (!point) {
        return;
      }

      const stroke = activeStrokeRef.current;
      const previousPoint = stroke.points[stroke.points.length - 1];
      const deltaX = point.x - previousPoint.x;
      const deltaY = point.y - previousPoint.y;

      if (Math.hypot(deltaX, deltaY) < 0.15) {
        return;
      }

      const nowSeconds = videoRef.current?.currentTime || 0;
      const nowMs = nowSeconds * 1000;
      const frame = frameFromTimeMs(nowMs, videoMetaRef.current.fps);

      stroke.points.push({
        ...point,
        timeMs: nowMs,
        pressure: normalizePressure(event, stroke.pressureEnabled)
      });
      stroke.endFrame = Math.max(stroke.endFrame, frame);

      dirtyRef.current = true;
    },
    [mapPointerToVideo]
  );

  const handleCanvasPointerUp = useCallback(
    (event) => {
      if (pointerIdRef.current !== event.pointerId) {
        return;
      }

      event.preventDefault();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      finalizeStroke();
    },
    [finalizeStroke]
  );

  const handleCanvasPointerCancel = useCallback(
    (event) => {
      if (pointerIdRef.current !== event.pointerId) {
        return;
      }

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      finalizeStroke();
    },
    [finalizeStroke]
  );

  const handleOpenVideo = useCallback(async () => {
    if (!desktopAPI) {
      setStatus("Desktop API is unavailable. Launch this app through Electron.");
      return;
    }

    try {
      const selected = await desktopAPI.openVideoDialog();
      if (!selected) {
        return;
      }

      const [probedMeta, mediaUrl] = await Promise.all([
        desktopAPI.probeVideo(selected).catch(() => DEFAULT_VIDEO_META),
        desktopAPI.pathToMediaUrl(selected)
      ]);

      const mergedMeta = {
        width: Number(probedMeta?.width) || DEFAULT_VIDEO_META.width,
        height: Number(probedMeta?.height) || DEFAULT_VIDEO_META.height,
        fps: Number(probedMeta?.fps) || DEFAULT_VIDEO_META.fps,
        duration: Number(probedMeta?.duration) || DEFAULT_VIDEO_META.duration
      };
      const baseVideoLayer = createVideoLayer("Video 1");

      const initialClip = createVideoClip({
        path: selected,
        url: mediaUrl,
        name: fileNameFromPath(selected),
        sourceDurationMs: mergedMeta.duration * 1000,
        sourceStartMs: 0,
        sourceEndMs: mergedMeta.duration * 1000,
        timelineStartMs: 0,
        videoLayerId: baseVideoLayer.id,
        fps: mergedMeta.fps,
        width: mergedMeta.width,
        height: mergedMeta.height
      });

      const baseLayer = createLayer("Layer 1");
      setLayers([baseLayer]);
      setActiveLayerId(baseLayer.id);
      setVideoPath(selected);
      setVideoUrl(mediaUrl);
      setVideoLayers([baseVideoLayer]);
      setActiveVideoLayerId(baseVideoLayer.id);
      setVideoClips([initialClip]);
      setCurrentVideoClipId(initialClip.id);
      setVideoMeta(mergedMeta);
      setSelectedClips([]);
      setSelectedVideoClipIds([]);
      const initialTime = (initialClip?.timelineStartMs || 0) / 1000;
      setCurrentTime(initialTime);
      currentTimeRef.current = initialTime;
      renderStateRef.current = createRenderState();
      dirtyRef.current = true;
      setStatus(`Loaded video: ${selected}`);

      const video = videoRef.current;
      if (video) {
        video.pause();
        video.currentTime = 0;
      }
    } catch (error) {
      setStatus(`Failed to open video: ${error.message}`);
    }
  }, []);

  const handleSaveProject = useCallback(async () => {
    if (!desktopAPI || !videoPath) {
      return;
    }

    try {
      const payload = buildProjectPayload({
        videoPath,
        videoMeta: videoMetaRef.current,
        layers: layersRef.current,
        videoLayers: videoLayersRef.current,
        videoClips: videoClipsRef.current
      });

      const savedAt = await desktopAPI.saveProject(payload);
      if (savedAt) {
        setStatus(`Project saved: ${savedAt}`);
      }
    } catch (error) {
      setStatus(`Failed to save project: ${error.message}`);
    }
  }, [videoPath]);

  const handleAddVideo = useCallback(async () => {
    if (!desktopAPI || videoClipsRef.current.length === 0) {
      return;
    }

    try {
      const selected = await desktopAPI.openVideoDialog();
      if (!selected) {
        return;
      }

      const [probedMeta, mediaUrl] = await Promise.all([
        desktopAPI.probeVideo(selected).catch(() => DEFAULT_VIDEO_META),
        desktopAPI.pathToMediaUrl(selected)
      ]);

      const clip = createVideoClip({
        path: selected,
        url: mediaUrl,
        name: fileNameFromPath(selected),
        sourceDurationMs: (Number(probedMeta?.duration) || DEFAULT_VIDEO_META.duration) * 1000,
        sourceStartMs: 0,
        sourceEndMs: (Number(probedMeta?.duration) || DEFAULT_VIDEO_META.duration) * 1000,
        timelineStartMs: totalTimelineDurationMs(videoClipsRef.current),
        videoLayerId: activeVideoLayerIdRef.current || videoLayersRef.current[0]?.id || "",
        fps: Number(probedMeta?.fps) || videoMetaRef.current.fps || DEFAULT_VIDEO_META.fps,
        width: Number(probedMeta?.width) || videoMetaRef.current.width || DEFAULT_VIDEO_META.width,
        height: Number(probedMeta?.height) || videoMetaRef.current.height || DEFAULT_VIDEO_META.height
      });

      setVideoClips((prev) => [...prev, clip]);
      setStatus(`Video added: ${selected}`);
    } catch (error) {
      setStatus(`Failed to add video: ${error.message}`);
    }
  }, []);

  const handleLoadProject = useCallback(async () => {
    if (!desktopAPI) {
      return;
    }

    try {
      const loaded = await desktopAPI.loadProject();
      if (!loaded) {
        return;
      }

      const normalized = normalizeLoadedProject(loaded.project);
      const normalizedClips = normalizeVideoClips(normalized.videoClips);
      const normalizedVideoLayers = normalizeVideoLayers(normalized.videoLayers);

      let projectClips = ensureClipVideoLayerIds(normalizedClips, normalizedVideoLayers);
      if (projectClips.length === 0 && normalized.videoPath) {
        const fallbackProbe = await desktopAPI.probeVideo(normalized.videoPath).catch(() => null);
        const fallbackMeta = {
          width: fallbackProbe?.width || normalized.videoMeta.width,
          height: fallbackProbe?.height || normalized.videoMeta.height,
          fps: fallbackProbe?.fps || normalized.videoMeta.fps,
          duration: fallbackProbe?.duration || normalized.videoMeta.duration
        };

        const fallbackUrl = await desktopAPI.pathToMediaUrl(normalized.videoPath);
        const fallbackVideoLayerId = normalizedVideoLayers[0]?.id || createVideoLayer("Video 1").id;
        projectClips = [createVideoClip({
          path: normalized.videoPath,
          url: fallbackUrl,
          name: fileNameFromPath(normalized.videoPath),
          sourceDurationMs: (Number(fallbackMeta.duration) || 0) * 1000,
          sourceStartMs: 0,
          sourceEndMs: (Number(fallbackMeta.duration) || 0) * 1000,
          timelineStartMs: 0,
          videoLayerId: fallbackVideoLayerId,
          fps: fallbackMeta.fps,
          width: fallbackMeta.width,
          height: fallbackMeta.height
        })];
      }

      const clipsWithUrls = await Promise.all(
        projectClips.map(async (clip) => ({
          ...clip,
          url: await desktopAPI.pathToMediaUrl(clip.path)
        }))
      );

      const orderedClips = sortVideoClips(clipsWithUrls);
      const validClips = ensureClipVideoLayerIds(orderedClips, normalizedVideoLayers);
      const firstClip = validClips[0] || null;
      const nextMeta = {
        width: firstClip?.width || normalized.videoMeta.width,
        height: firstClip?.height || normalized.videoMeta.height,
        fps: firstClip?.fps || normalized.videoMeta.fps,
        duration: totalTimelineDurationMs(validClips) / 1000
      };

      const nextLayers = normalizeLayers(normalized.layers);
      setVideoPath(firstClip?.path || normalized.videoPath);
      setVideoUrl(firstClip?.url || "");
      setVideoLayers(normalizedVideoLayers);
      setActiveVideoLayerId(firstClip?.videoLayerId || normalizedVideoLayers[0]?.id || null);
      setVideoClips(validClips);
      setCurrentVideoClipId(firstClip?.id || null);
      setVideoMeta(nextMeta);
      setLayers(nextLayers);
      setActiveLayerId(nextLayers[0]?.id || createLayer("Layer 1").id);
      setSelectedClips([]);
      setSelectedVideoClipIds([]);
      setCurrentTime(0);
      currentTimeRef.current = 0;
      renderStateRef.current = createRenderState();
      dirtyRef.current = true;
      setStatus(`Project loaded: ${loaded.filePath}`);

      const video = videoRef.current;
      if (video) {
        video.pause();
        video.currentTime = 0;
      }
    } catch (error) {
      setStatus(`Failed to load project: ${error.message}`);
    }
  }, []);

  const handleTogglePlay = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !videoUrl || videoClipsRef.current.length === 0) {
      return;
    }

    try {
      if (video.paused) {
        const globalMs = Math.max(0, (Number(currentTimeRef.current) || 0) * 1000);
        const ordered = sortVideoClips(videoClipsRef.current);
        const expectedClip = findVideoClipAtTime(ordered, globalMs, {
          preferredLayerId: activeVideoLayerIdRef.current,
          layerOrderIds: (videoLayersRef.current || []).map((layer) => layer.id)
        });
        if (!expectedClip || expectedClip.id !== currentVideoClipIdRef.current || expectedClip.url !== videoUrl) {
          seekGlobalTimeMs(globalMs, { autoplay: true });
          return;
        }
        await video.play();
      } else {
        video.pause();
      }
    } catch (error) {
      setStatus(`Playback error: ${error.message}`);
    }
  }, [seekGlobalTimeMs, videoUrl]);

  const handleSeek = useCallback((nextTime) => {
    if (videoClipsRef.current.length === 0) {
      return;
    }

    const timelineDuration = totalTimelineDurationMs(videoClipsRef.current) / 1000;
    const mediaDuration = Number.isFinite(Number(videoRef.current?.duration))
      ? Number(videoRef.current.duration)
      : 0;
    const duration = Math.max(Number(videoMetaRef.current.duration) || 0, timelineDuration, mediaDuration);
    const safeTime = clamp(nextTime, 0, duration);
    seekGlobalTimeMs(safeTime * 1000, { autoplay: false });
  }, [seekGlobalTimeMs]);

  const handleStepFrame = useCallback(
    (direction) => {
      const video = videoRef.current;
      if (!video || videoClipsRef.current.length === 0) {
        return;
      }

      const safeDirection = Number(direction) >= 0 ? 1 : -1;
      const safeFps = Math.max(Number(videoMetaRef.current.fps) || 30, 1);
      const ordered = sortVideoClips(videoClipsRef.current);
      const clipFromCurrent = ordered.find((clip) => clip.id === currentVideoClipIdRef.current) || null;
      const localMs = (Number(video.currentTime) || 0) * 1000;
      const baseGlobalMs = clipFromCurrent
        ? (Number(clipFromCurrent.timelineStartMs) || 0) + (localMs - (Number(clipFromCurrent.sourceStartMs) || 0))
        : Math.max(0, (Number(currentTimeRef.current) || Number(currentTime) || 0) * 1000);
      const nextGlobalMs = Math.max(0, baseGlobalMs + safeDirection * (1000 / safeFps));

      video.pause();
      setIsPlaying(false);
      seekGlobalTimeMs(nextGlobalMs, { autoplay: false });
    },
    [currentTime, seekGlobalTimeMs]
  );

  const activeLayer = layers.find((layer) => layer.id === activeLayerId);
  const activeVideoLayer = videoLayers.find((layer) => layer.id === activeVideoLayerId);

  const handleBrushChange = useCallback((patch) => {
    setBrush((prev) => ({ ...prev, ...patch }));
    dirtyRef.current = true;
  }, []);

  const handleAddLayer = useCallback(() => {
    setLayers((prevLayers) => {
      const nextLayers = addLayer(prevLayers);
      setActiveLayerId(nextLayers[nextLayers.length - 1].id);
      return nextLayers;
    });
  }, []);

  const handleDeleteLayer = useCallback((layerId) => {
    setLayers((prevLayers) => {
      const nextLayers = deleteLayer(prevLayers, layerId);
      if (!nextLayers.some((layer) => layer.id === activeLayerIdRef.current)) {
        setActiveLayerId(nextLayers[0].id);
      }
      return nextLayers;
    });
  }, []);

  const handleToggleLayerVisibility = useCallback((layerId) => {
    setLayers((prevLayers) => toggleLayerVisibility(prevLayers, layerId));
  }, []);

  const handleUndo = useCallback(() => {
    if (!activeLayerIdRef.current) {
      return;
    }
    setLayers((prevLayers) => undoLayer(prevLayers, activeLayerIdRef.current));
  }, []);

  const handleRedo = useCallback(() => {
    if (!activeLayerIdRef.current) {
      return;
    }
    setLayers((prevLayers) => redoLayer(prevLayers, activeLayerIdRef.current));
  }, []);

  const handleClearLayer = useCallback(() => {
    if (!activeLayerIdRef.current) {
      return;
    }
    setLayers((prevLayers) => clearLayer(prevLayers, activeLayerIdRef.current));
  }, []);

  const handleMoveSelectedClipsToLayer = useCallback((targetLayerId) => {
    if (!targetLayerId || selectedClips.length === 0) {
      return;
    }

    setLayers((prevLayers) => moveStrokesToLayer(prevLayers, selectedClips, targetLayerId));
    setSelectedClips((prevSelection) =>
      prevSelection.map((selection) => ({
        ...selection,
        layerId: targetLayerId
      }))
    );
    setActiveLayerId(targetLayerId);
  }, [selectedClips]);

  const handleSelectClip = useCallback((nextSelection, options = {}) => {
    if (!nextSelection?.layerId || !nextSelection?.strokeId) {
      setSelectedClips([]);
      return;
    }

    const { additive = false, toggle = false } = options;
    if (!additive) {
      setSelectedVideoClipIds([]);
    }

    setSelectedClips((prevSelection) => {
      if (!additive) {
        return [nextSelection];
      }

      const key = clipSelectionKey(nextSelection.layerId, nextSelection.strokeId);
      const exists = prevSelection.some(
        (entry) => clipSelectionKey(entry.layerId, entry.strokeId) === key
      );

      if (exists && toggle) {
        return prevSelection.filter(
          (entry) => clipSelectionKey(entry.layerId, entry.strokeId) !== key
        );
      }

      if (exists) {
        return prevSelection;
      }

      return [...prevSelection, nextSelection];
    });

    if (nextSelection.layerId !== activeLayerIdRef.current) {
      setActiveLayerId(nextSelection.layerId);
    }
  }, []);

  const handleSelectVideoLayer = useCallback((layerId) => {
    if (!layerId) {
      return;
    }

    setActiveVideoLayerId(layerId);
  }, []);

  const handleSelectVideoClip = useCallback((clipId, options = {}) => {
    if (!clipId) {
      setSelectedVideoClipIds([]);
      return;
    }

    const { additive = false, toggle = false } = options;
    if (!additive) {
      setSelectedClips([]);
    }
    setSelectedVideoClipIds((prev) => {
      if (!additive) {
        return [clipId];
      }

      const exists = prev.includes(clipId);
      if (exists && toggle) {
        return prev.filter((id) => id !== clipId);
      }
      if (exists) {
        return prev;
      }
      return [...prev, clipId];
    });

    const clip = videoClipsRef.current.find((entry) => entry.id === clipId);
    if (clip?.videoLayerId) {
      setActiveVideoLayerId(clip.videoLayerId);
    }
  }, []);

  const handleAddVideoLayer = useCallback(() => {
    setVideoLayers((prev) => {
      const next = addVideoLayer(prev);
      const created = next[next.length - 1];
      if (created) {
        setActiveVideoLayerId(created.id);
      }
      return next;
    });
  }, []);

  const handleDeleteVideoLayer = useCallback(() => {
    const currentLayers = videoLayersRef.current;
    if (!currentLayers || currentLayers.length <= 1) {
      return;
    }

    const deletingLayerId = activeVideoLayerIdRef.current || currentLayers[0]?.id;
    const nextLayers = deleteVideoLayer(currentLayers, deletingLayerId);
    const fallbackLayerId = nextLayers[0]?.id || null;

    setVideoLayers(nextLayers);
    setActiveVideoLayerId(fallbackLayerId);
    setVideoClips((prev) => reassignClipsFromDeletedLayer(prev, deletingLayerId, fallbackLayerId));
  }, []);

  const handleMoveSelectedVideoToActiveLayer = useCallback(() => {
    const targetLayerId = activeVideoLayerIdRef.current;
    if (!targetLayerId || selectedVideoClipIds.length === 0) {
      return;
    }

    setVideoClips((prev) => moveVideoClipsToLayer(prev, selectedVideoClipIds, targetLayerId));
  }, [selectedVideoClipIds]);

  const handleAssignVideoClipLayer = useCallback((clipId, layerId) => {
    if (!clipId || !layerId) {
      return;
    }

    setVideoClips((prev) => moveVideoClipsToLayer(prev, [clipId], layerId));
    setActiveVideoLayerId(layerId);
  }, []);

  const handleUpdateVideoClipAudio = useCallback((clipId, patch) => {
    if (!clipId || !patch || typeof patch !== "object") {
      return;
    }

    setVideoClips((prev) => prev.map((clip) => {
      if (clip.id !== clipId) {
        return clip;
      }

      const nextMuted = Object.prototype.hasOwnProperty.call(patch, "audioMuted")
        ? Boolean(patch.audioMuted)
        : Boolean(clip.audioMuted);
      const nextDb = Object.prototype.hasOwnProperty.call(patch, "audioGainDb")
        ? clampDb(patch.audioGainDb)
        : clampDb(clip.audioGainDb);

      return {
        ...clip,
        audioMuted: nextMuted,
        audioGainDb: nextDb
      };
    }));
  }, []);

  const handleMoveVideoClip = useCallback((clipId, nextWindow) => {
    setVideoClips((prev) => moveVideoClip(prev, clipId, Number(nextWindow?.startMs) || 0));
  }, []);

  const handleTrimVideoClip = useCallback((clipId, nextWindow) => {
    setVideoClips((prev) =>
      trimVideoClip(prev, clipId, {
        startMs: Number(nextWindow?.startMs),
        endMs: Number(nextWindow?.endMs)
      })
    );
  }, []);

  const handleSplitVideoClip = useCallback((clipId, cutMs) => {
    setVideoClips((prev) => splitVideoClip(prev, clipId, Number(cutMs)));
  }, []);

  const handleMoveClip = useCallback((layerId, strokeId, nextWindow) => {
    const durationMs = Number(videoMetaRef.current.duration) > 0
      ? Number(videoMetaRef.current.duration) * 1000
      : Number.POSITIVE_INFINITY;

    setLayers((prevLayers) =>
      updateStrokeOnLayer(prevLayers, layerId, strokeId, (stroke) => {
        const currentWindow = strokeClipWindowMs(stroke, videoMetaRef.current.fps, durationMs);
        const deltaMs = (Number(nextWindow?.startMs) || 0) - currentWindow.clipStartMs;
        return shiftStrokeInTime(stroke, deltaMs, videoMetaRef.current.fps, durationMs);
      })
    );
  }, []);

  const handleTrimClip = useCallback((layerId, strokeId, nextWindow) => {
    const durationMs = Number(videoMetaRef.current.duration) > 0
      ? Number(videoMetaRef.current.duration) * 1000
      : Number.POSITIVE_INFINITY;

    setLayers((prevLayers) =>
      updateStrokeOnLayer(prevLayers, layerId, strokeId, (stroke) =>
        withStrokeClipWindow(
          stroke,
          {
            clipStartMs: Number(nextWindow?.startMs),
            clipEndMs: Number(nextWindow?.endMs)
          },
          videoMetaRef.current.fps,
          durationMs
        )
      )
    );
  }, []);

  const handleSplitClip = useCallback((layerId, strokeId, cutMs) => {
    const durationMs = Number(videoMetaRef.current.duration) > 0
      ? Number(videoMetaRef.current.duration) * 1000
      : Number.POSITIVE_INFINITY;
    let nextSelected = null;

    setLayers((prevLayers) =>
      replaceStrokeOnLayer(prevLayers, layerId, strokeId, (() => {
        const layer = prevLayers.find((entry) => entry.id === layerId);
        const stroke = layer?.strokes?.find((entry) => entry.id === strokeId);
        if (!stroke) {
          return [];
        }

        const split = splitStrokeAtTime(
          stroke,
          Number(cutMs),
          videoMetaRef.current.fps,
          durationMs
        );

        if (!split) {
          return [stroke];
        }

        nextSelected = { layerId, strokeId: split[1].id };
        return split;
      })())
    );

    if (nextSelected) {
      setSelectedClips([nextSelected]);
    }
  }, []);

  useEffect(() => {
    if (selectedClips.length === 0) {
      return;
    }

    const existingKeys = new Set();
    for (const layer of layers) {
      for (const stroke of layer.strokes || []) {
        existingKeys.add(clipSelectionKey(layer.id, stroke.id));
      }
    }

    setSelectedClips((prevSelection) => {
      const filtered = prevSelection.filter((entry) =>
        existingKeys.has(clipSelectionKey(entry.layerId, entry.strokeId))
      );
      if (filtered.length === prevSelection.length) {
        return prevSelection;
      }
      return filtered;
    });
  }, [layers, selectedClips.length]);

  useEffect(() => {
    if (selectedVideoClipIds.length === 0) {
      return;
    }

    const existing = new Set((videoClips || []).map((clip) => clip.id));
    setSelectedVideoClipIds((prev) => {
      const filtered = prev.filter((id) => existing.has(id));
      if (filtered.length === prev.length) {
        return prev;
      }
      return filtered;
    });
  }, [videoClips, selectedVideoClipIds.length]);

  useEffect(() => {
    const ordered = sortVideoClips(videoClips);
    if (ordered.length === 0) {
      setCurrentVideoClipId(null);
      setVideoUrl("");
      setVideoPath("");
      setCurrentTime(0);
      currentTimeRef.current = 0;
      return;
    }

    const exists = ordered.some((clip) => clip.id === currentVideoClipIdRef.current);
    if (!exists) {
      const first = ordered[0];
      setCurrentVideoClipId(first.id);
      setVideoUrl(first.url);
      setVideoPath(first.path);
      seekGlobalTimeMs(first.timelineStartMs || 0, { autoplay: false });
    }
  }, [seekGlobalTimeMs, videoClips]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (selectedClips.length === 0 && selectedVideoClipIds.length === 0) {
        return;
      }

      const key = String(event.key || "").toLowerCase();
      const isDeleteKey = key === "delete" || key === "del" || key === "supr" || key === "backspace";
      if (!isDeleteKey) {
        return;
      }

      const target = event.target;
      const isEditable = target instanceof HTMLElement
        && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if (isEditable) {
        return;
      }

      event.preventDefault();

      const grouped = new Map();
      for (const selection of selectedClips) {
        if (!grouped.has(selection.layerId)) {
          grouped.set(selection.layerId, new Set());
        }
        grouped.get(selection.layerId).add(selection.strokeId);
      }

      setLayers((prevLayers) => {
        let next = prevLayers;
        for (const [layerId, ids] of grouped.entries()) {
          next = removeStrokesFromLayer(next, layerId, Array.from(ids));
        }
        return next;
      });
      if (selectedVideoClipIds.length > 0) {
        setVideoClips((prev) => removeVideoClips(prev, selectedVideoClipIds));
      }
      setSelectedClips([]);
      setSelectedVideoClipIds([]);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedClips, selectedVideoClipIds]);

  useEffect(() => {
    const onPointerMove = (event) => {
      const activeResize = resizeRef.current;
      if (!activeResize) {
        return;
      }

      event.preventDefault();

      if (activeResize.mode === "left-panel") {
        const next = clamp(
          activeResize.startLeftWidth + (event.clientX - activeResize.startX),
          180,
          560
        );
        setLeftPanelWidth(next);
      } else if (activeResize.mode === "right-panel") {
        const next = clamp(
          activeResize.startRightWidth - (event.clientX - activeResize.startX),
          220,
          620
        );
        setRightPanelWidth(next);
      } else if (activeResize.mode === "timeline-height") {
        const next = clamp(
          activeResize.startTimelineHeight - (event.clientY - activeResize.startY),
          150,
          560
        );
        setTimelineViewportHeight(next);
      }
    };

    const onPointerUp = () => {
      resizeRef.current = null;
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, []);

  const beginUiResize = useCallback((event, mode) => {
    event.preventDefault();
    resizeRef.current = {
      mode,
      startX: event.clientX,
      startY: event.clientY,
      startLeftWidth: leftPanelWidth,
      startRightWidth: rightPanelWidth,
      startTimelineHeight: timelineViewportHeight
    };
  }, [leftPanelWidth, rightPanelWidth, timelineViewportHeight]);

  const handleOpenExportDialog = useCallback(() => {
    if (!videoClipsRef.current.length || exportState.running) {
      return;
    }
    setExportDialogOpen(true);
  }, [exportState.running]);

  const handleConfirmExportOptions = useCallback(async (options) => {
    if (!desktopAPI || videoClipsRef.current.length === 0) {
      return;
    }

    try {
      const baseFileName = options?.fileName
        || `${fileNameFromPath(videoPath).replace(/\.[^/.]+$/, "") || "annotated"}-annotated.mp4`;

      const outputPath = await desktopAPI.pickExportPath({
        suggestedName: baseFileName,
        format: options?.format || "mp4"
      });
      if (!outputPath) {
        return;
      }

      setExportDialogOpen(false);
      setExportState({ running: true, progress: 0 });
      setStatus("Rendering annotation overlay stream...");

      const exportFps = Number(options?.fps) > 0 ? Number(options.fps) : (videoMetaRef.current.fps || 30);
      const bitrateMbps = Number(options?.bitrateMbps) > 0 ? Number(options.bitrateMbps) : 12;

      const recordingBytes = await renderAndRecordAnnotatedVideo({
        videoUrl,
        videoClips: videoClipsRef.current,
        layers: layersRef.current,
        videoMeta: videoMetaRef.current,
        onionSkin: false,
        outputFps: exportFps,
        recordingBitrate: Math.round(bitrateMbps * 1_000_000),
        onProgress: (ratio) => {
          setExportState({ running: true, progress: ratio * 0.75 });
        }
      });

      setStatus("Encoding output with ffmpeg...");
      setExportState({ running: true, progress: 0.82 });

      const singleClipOnly = videoClipsRef.current.length === 1;
      const firstClipPath = videoClipsRef.current[0]?.path || videoPath;

      await desktopAPI.convertRecordingToMp4({
        recordingBytes,
        sourceVideoPath: singleClipOnly ? firstClipPath : null,
        outputPath,
        fps: exportFps,
        includeAudio: Boolean(options?.includeAudio && singleClipOnly),
        preset: options?.preset || "medium",
        encoderMode: options?.encoderMode || "auto",
        bitrateMbps,
        outputFormat: options?.format || "mp4",
        outputWidth: Number(options?.width) || videoMetaRef.current.width,
        outputHeight: Number(options?.height) || videoMetaRef.current.height,
        audioBitrate: "192k"
      });

      setExportState({ running: false, progress: 1 });
      setStatus(`Export completed: ${outputPath}`);
    } catch (error) {
      setExportState({ running: false, progress: 0 });
      setStatus(`Export failed: ${error.message}`);
    }
  }, [videoPath, videoUrl]);

  const hasVideo = videoClips.length > 0;
  const projectName = fileNameFromPath(videoPath);

  return (
    <div className="app-shell">
      <TopBar
        projectName={projectName}
        status={status}
        exportState={exportState}
        onOpenVideo={handleOpenVideo}
        onAddVideo={handleAddVideo}
        onSaveProject={handleSaveProject}
        onLoadProject={handleLoadProject}
        onExportVideo={handleOpenExportDialog}
        disabled={!hasVideo}
        canAddVideo={hasVideo}
      />

      <main
        className="main-layout"
        style={{
          "--left-panel-width": `${leftPanelWidth}px`,
          "--right-panel-width": `${rightPanelWidth}px`
        }}
      >
        <Toolbar
          brush={brush}
          onionSkin={onionSkin}
          onBrushChange={handleBrushChange}
          onSetOnionSkin={setOnionSkin}
          onUndo={handleUndo}
          onRedo={handleRedo}
          onClearLayer={handleClearLayer}
          canDraw={hasVideo && !exportState.running}
        />

        <div
          className="panel-resizer vertical"
          onPointerDown={(event) => beginUiResize(event, "left-panel")}
          title="Resize tools panel"
        />

        <section className="stage-section">
          <div className="stage-wrapper">
            {hasVideo ? (
              <div
                className="video-stage"
                style={{
                  aspectRatio: `${videoMeta.width || 16}/${videoMeta.height || 9}`
                }}
              >
                <video
                  ref={videoRef}
                  className="video-layer"
                  src={videoUrl}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  onEnded={() => setIsPlaying(false)}
                  onLoadedMetadata={(event) => {
                    const video = event.currentTarget;
                    const pendingSeek = pendingVideoSeekRef.current;
                    if (pendingSeek) {
                      if (pendingSeek.clipId && pendingSeek.clipId !== currentVideoClipIdRef.current) {
                        setCurrentVideoClipId(pendingSeek.clipId);
                      }
                      video.currentTime = (Number(pendingSeek.localMs) || 0) / 1000;
                      if (pendingSeek.autoplay) {
                        video.play().catch(() => {});
                      }
                      pendingVideoSeekRef.current = null;
                    }

                    const loadedDurationSeconds = Number(video.duration);
                    const loadedDurationMs = Number.isFinite(loadedDurationSeconds) && loadedDurationSeconds > 0
                      ? loadedDurationSeconds * 1000
                      : null;
                    const loadedWidth = Number(video.videoWidth) || 0;
                    const loadedHeight = Number(video.videoHeight) || 0;
                    let activeClipId = currentVideoClipIdRef.current;
                    if (!activeClipId) {
                      const fallbackClip = (videoClipsRef.current || []).find(
                        (clip) => clip.url && clip.url === videoUrl
                      );
                      activeClipId = fallbackClip?.id || null;
                    }

                    if (activeClipId && loadedDurationMs) {
                      setVideoClips((prev) => {
                        let changed = false;
                        const next = (prev || []).map((clip) => {
                          if (clip.id !== activeClipId) {
                            return clip;
                          }

                          const currentStart = Number(clip.sourceStartMs) || 0;
                          const currentEnd = Number(clip.sourceEndMs);
                          const hasValidRange = Number.isFinite(currentEnd) && currentEnd > currentStart;
                          const currentDuration = Number(clip.sourceDurationMs) || 0;

                          const patch = {};
                          if (Math.abs(currentDuration - loadedDurationMs) > 1) {
                            patch.sourceDurationMs = loadedDurationMs;
                          }
                          if (!hasValidRange) {
                            patch.sourceStartMs = currentStart;
                            patch.sourceEndMs = currentStart + loadedDurationMs;
                          } else if (currentEnd > loadedDurationMs && currentStart <= 0) {
                            patch.sourceEndMs = loadedDurationMs;
                          }
                          if (loadedWidth > 0 && loadedWidth !== Number(clip.width)) {
                            patch.width = loadedWidth;
                          }
                          if (loadedHeight > 0 && loadedHeight !== Number(clip.height)) {
                            patch.height = loadedHeight;
                          }

                          if (Object.keys(patch).length === 0) {
                            return clip;
                          }

                          changed = true;
                          return { ...clip, ...patch };
                        });

                        return changed ? next : prev;
                      });
                    }

                    const clipTimelineDurationSeconds = totalTimelineDurationMs(videoClipsRef.current) / 1000;
                    const nextMeta = {
                      width: loadedWidth || videoMetaRef.current.width,
                      height: loadedHeight || videoMetaRef.current.height,
                      fps: Number(videoMetaRef.current.fps) || DEFAULT_VIDEO_META.fps,
                      duration: clipTimelineDurationSeconds > 0
                        ? clipTimelineDurationSeconds
                        : (loadedDurationMs ? loadedDurationMs / 1000 : (Number(videoMetaRef.current.duration) || DEFAULT_VIDEO_META.duration))
                    };
                    setVideoMeta(nextMeta);
                    videoMetaRef.current = nextMeta;
                    dirtyRef.current = true;
                  }}
                  onError={() => {
                    const detail = mediaErrorMessage(videoRef.current?.error);
                    setStatus(`Video failed to load: ${detail}`);
                  }}
                />

                <canvas
                  ref={canvasRef}
                  className="draw-layer"
                  onPointerDown={handleCanvasPointerDown}
                  onPointerMove={handleCanvasPointerMove}
                  onPointerUp={handleCanvasPointerUp}
                  onPointerCancel={handleCanvasPointerCancel}
                />
              </div>
            ) : (
              <div className="empty-stage">
                <p>Load a local video file to begin annotation.</p>
              </div>
            )}
          </div>
        </section>

        <div
          className="panel-resizer vertical"
          onPointerDown={(event) => beginUiResize(event, "right-panel")}
          title="Resize layers panel"
        />

        <LayersPanel
          layers={layers}
          activeLayerId={activeLayerId}
          onSelectLayer={setActiveLayerId}
          onAddLayer={handleAddLayer}
          onDeleteLayer={handleDeleteLayer}
          onToggleVisibility={handleToggleLayerVisibility}
          selectedClipCount={selectedClips.length}
          onMoveSelectedToLayer={handleMoveSelectedClipsToLayer}
        />
      </main>

      <div
        className="timeline-resizer"
        onPointerDown={(event) => beginUiResize(event, "timeline-height")}
        title="Resize timeline"
      />

      <TimelineBar
        currentTime={currentTime}
        duration={videoMeta.duration}
        fps={videoMeta.fps}
        isPlaying={isPlaying}
        videoUrl={videoUrl}
        videoLayers={videoLayers}
        activeVideoLayerId={activeVideoLayerId}
        videoClips={videoClips}
        layers={layers}
        activeLayerId={activeLayerId}
        selectedClips={selectedClips}
        selectedVideoClipIds={selectedVideoClipIds}
        onTogglePlay={handleTogglePlay}
        onSeek={handleSeek}
        onStepFrame={handleStepFrame}
        onSelectClip={handleSelectClip}
        onSelectVideoLayer={handleSelectVideoLayer}
        onSelectVideoClip={handleSelectVideoClip}
        onAddVideoLayer={handleAddVideoLayer}
        onDeleteVideoLayer={handleDeleteVideoLayer}
        onMoveSelectedVideoToActiveLayer={handleMoveSelectedVideoToActiveLayer}
        onAssignVideoClipLayer={handleAssignVideoClipLayer}
        onUpdateVideoClipAudio={handleUpdateVideoClipAudio}
        onMoveVideoClip={handleMoveVideoClip}
        onTrimVideoClip={handleTrimVideoClip}
        onSplitVideoClip={handleSplitVideoClip}
        onMoveClip={handleMoveClip}
        onTrimClip={handleTrimClip}
        onSplitClip={handleSplitClip}
        viewportHeight={timelineViewportHeight}
        disabled={!hasVideo || exportState.running}
      />

      <ExportDialog
        open={exportDialogOpen}
        defaultBaseName={`${fileNameFromPath(videoPath).replace(/\.[^/.]+$/, "") || "annotated"}-annotated`}
        sourceMeta={videoMeta}
        running={exportState.running}
        onCancel={() => setExportDialogOpen(false)}
        onConfirm={handleConfirmExportOptions}
      />

      {activeLayer ? (
        <div className="active-layer-tag">
          Active Draw Layer: {activeLayer.name}
          {activeVideoLayer ? ` | Active Video Layer: ${activeVideoLayer.name}` : ""}
        </div>
      ) : null}
    </div>
  );
}

export default App;
