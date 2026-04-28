import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  clipTimelineEndMs,
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
const PREVIEW_SCALES = [1, 0.75, 0.5, 0.25];

function normalizePreviewScale(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 1;
  }

  const candidate = PREVIEW_SCALES.find((scale) => Math.abs(scale - numeric) < 0.0001);
  return candidate ?? 1;
}

function copyDocumentStyles(targetDoc) {
  if (!targetDoc?.head) {
    return;
  }

  targetDoc.querySelectorAll("style[data-preview-clone],link[data-preview-clone]").forEach((node) => {
    node.remove();
  });

  const styleNodes = document.querySelectorAll("link[rel='stylesheet'], style");
  styleNodes.forEach((node) => {
    const clone = node.cloneNode(true);
    clone.setAttribute("data-preview-clone", "1");
    targetDoc.head.appendChild(clone);
  });
}

function readWindowRect(win) {
  if (!win) {
    return null;
  }

  const x = Number(win.screenX);
  const y = Number(win.screenY);
  const width = Number(win.outerWidth);
  const height = Number(win.outerHeight);

  if (![x, y, width, height].every((value) => Number.isFinite(value))) {
    return null;
  }

  return {
    left: x,
    top: y,
    right: x + Math.max(0, width),
    bottom: y + Math.max(0, height),
    width: Math.max(0, width),
    height: Math.max(0, height)
  };
}

function rectDistance(a, b) {
  if (!a || !b) {
    return Number.POSITIVE_INFINITY;
  }

  const dx = Math.max(0, Math.max(a.left - b.right, b.left - a.right));
  const dy = Math.max(0, Math.max(a.top - b.bottom, b.top - a.bottom));
  return Math.hypot(dx, dy);
}

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

function readPointerPressureInfo(pointerEvent) {
  const samples = typeof pointerEvent.getCoalescedEvents === "function"
    ? pointerEvent.getCoalescedEvents()
    : [];
  const candidates = [...samples, pointerEvent];
  const pointerType = pointerEvent.pointerType || "unknown";
  const rawPressure = Number(pointerEvent.pressure);
  let hardwarePressure = null;
  let source = "none";

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    const directPressure = Number(candidate.pressure);
    if (Number.isFinite(directPressure) && directPressure > 0) {
      const normalizedPressure = directPressure > 1 ? directPressure / 8191 : directPressure;
      // Mouse pointers usually report 0.5 while pressed, which is not real pressure data.
      if (pointerType === "mouse" && Math.abs(normalizedPressure - 0.5) < 0.0001) {
        continue;
      }
      hardwarePressure = clamp(normalizedPressure, 0.05, 1);
      source = candidate === pointerEvent ? "event.pressure" : "coalesced.pressure";
      break;
    }
  }

  const fallbackForce = Number(pointerEvent.force ?? pointerEvent.webkitForce);
  if (hardwarePressure === null && Number.isFinite(fallbackForce) && fallbackForce > 0) {
    hardwarePressure = clamp(fallbackForce, 0.05, 1);
    source = "force";
  }

  return {
    pointerType,
    rawPressure: Number.isFinite(rawPressure) ? rawPressure : null,
    hardwarePressure,
    source,
    sampleCount: candidates.length,
    hasHardwarePressure: hardwarePressure !== null
  };
}

function normalizePressure(pointerEvent, pressureEnabled, options = {}) {
  if (!pressureEnabled) {
    return 1;
  }

  const pressureInfo = options.pressureInfo || readPointerPressureInfo(pointerEvent);
  const hardwarePressure = pressureInfo.hardwarePressure;
  if (hardwarePressure !== null) {
    const previousPressure = Number(options.fallbackPressure);
    if (Number.isFinite(previousPressure) && previousPressure > 0) {
      // Smooth rapid pressure oscillations from tablet drivers.
      const smoothed = previousPressure * 0.35 + hardwarePressure * 0.65;
      return clamp(smoothed, 0.05, 1);
    }
    return hardwarePressure;
  }

  if (pointerEvent.pointerType === "mouse") {
    return 1;
  }

  const fallbackPressure = Number(options.fallbackPressure);
  if (Number.isFinite(fallbackPressure) && fallbackPressure > 0) {
    return clamp(fallbackPressure, 0.05, 1);
  }

  return 1;
}

const IDLE_PRESSURE_INPUT = {
  pointerType: "idle",
  rawPressure: null,
  hardwarePressure: null,
  source: "none",
  sampleCount: 0,
  hasHardwarePressure: false
};

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

function normalizeBrushPatch(patch) {
  const next = { ...patch };
  if (Object.hasOwn(next, "pressureSensitivity")) {
    next.pressureSensitivity = clamp(Number(next.pressureSensitivity) || 1, 0.2, 4);
  }
  if (Object.hasOwn(next, "pressureCurve")) {
    next.pressureCurve = clamp(Number(next.pressureCurve) || 1, 0.2, 4);
  }
  if (Object.hasOwn(next, "pressureMinScale")) {
    next.pressureMinScale = clamp(Number(next.pressureMinScale) || 0.05, 0.02, 0.95);
  }
  return next;
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
  if (Number.isFinite(explicitEnd) && explicitEnd >= startMs) {
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

function clipLocalMsAtTimelineMs(clip, globalMs, videoDurationMs = 0) {
  const timelineStartMs = Number(clip?.timelineStartMs) || 0;
  const localRange = clipLocalRangeMs(clip, videoDurationMs);
  return clamp(
    localRange.startMs + (Math.max(0, Number(globalMs) || 0) - timelineStartMs),
    localRange.startMs,
    localRange.endMs
  );
}

function resolveSameLayerCrossfade(clips, activeClip, globalMs) {
  if (!activeClip) {
    return null;
  }

  const t = Math.max(0, Number(globalMs) || 0);
  const activeStartMs = Number(activeClip.timelineStartMs) || 0;
  const activeEndMs = clipTimelineEndMs(activeClip);
  const activeLayerId = String(activeClip.videoLayerId || "");

  const outgoingClip = sortVideoClips(clips)
    .filter((clip) => {
      if (clip.id === activeClip.id || String(clip.videoLayerId || "") !== activeLayerId) {
        return false;
      }

      const startMs = Number(clip.timelineStartMs) || 0;
      const endMs = clipTimelineEndMs(clip);
      return startMs <= activeStartMs && t >= startMs && t < endMs;
    })
    .sort((a, b) => (Number(b.timelineStartMs) || 0) - (Number(a.timelineStartMs) || 0))[0];

  if (!outgoingClip) {
    return null;
  }

  const outgoingStartMs = Number(outgoingClip.timelineStartMs) || 0;
  const overlapStartMs = Math.max(activeStartMs, outgoingStartMs);
  const overlapEndMs = Math.min(activeEndMs, clipTimelineEndMs(outgoingClip));
  const overlapDurationMs = overlapEndMs - overlapStartMs;

  if (overlapDurationMs <= 1 || t < overlapStartMs || t >= overlapEndMs) {
    return null;
  }

  const progress = clamp((t - overlapStartMs) / overlapDurationMs, 0, 1);
  return {
    outgoingClip,
    outgoingOpacity: 1 - progress,
    activeOpacity: progress
  };
}

function annotationTimelineDurationMs(layers, fps = 30) {
  let maxEnd = 0;
  for (const layer of layers || []) {
    for (const stroke of layer.strokes || []) {
      const windowMs = strokeClipWindowMs(stroke, fps, Number.POSITIVE_INFINITY);
      const candidateEnd = Number.isFinite(windowMs.clipEndMs)
        ? windowMs.clipEndMs
        : windowMs.drawEndMs;
      maxEnd = Math.max(maxEnd, Number(candidateEnd) || 0);
    }
  }
  return maxEnd;
}

function playVideoWhenReady(video) {
  if (!video) {
    return;
  }

  let requested = false;

  const requestPlay = () => {
    if (requested) {
      return;
    }

    requested = true;
    video.removeEventListener("loadeddata", requestPlay);
    video.removeEventListener("canplay", requestPlay);

    video.play().catch(() => { });
  };

  // 2 = HAVE_CURRENT_DATA
  if (video.readyState >= 2) {
    requestPlay();
    return;
  }

  video.addEventListener("loadeddata", requestPlay, { once: true });
  video.addEventListener("canplay", requestPlay, { once: true });
}

function seekVideoElement(video, targetSeconds, options = {}) {
  const { autoplay = false, onSettled = null } = options;

  const durationSeconds = Number(video.duration);
  const maxSeekSeconds = Number.isFinite(durationSeconds) && durationSeconds > 0
    ? Math.max(0, durationSeconds - 1 / 240)
    : Number.POSITIVE_INFINITY;

  const desiredSeconds = clamp(
    Math.max(0, Number(targetSeconds) || 0),
    0,
    maxSeekSeconds
  );

  const currentSeconds = Math.max(0, Number(video.currentTime) || 0);
  const epsilon = 1 / 240;

  const finish = () => {
    if (typeof onSettled === "function") {
      onSettled();
    }

    if (autoplay) {
      playVideoWhenReady(video);
    }
  };

  if (Math.abs(currentSeconds - desiredSeconds) <= epsilon) {
    finish();
    return;
  }

  let fallbackId = null;
  let settled = false;

  const cleanup = () => {
    if (settled) {
      return;
    }

    settled = true;
    video.removeEventListener("seeked", onSeeked);

    if (fallbackId !== null) {
      window.clearTimeout(fallbackId);
    }

    finish();
  };

  const onSeeked = () => {
    cleanup();
  };

  video.addEventListener("seeked", onSeeked, { once: true });

  fallbackId = window.setTimeout(() => {
    cleanup();
  }, 250);

  try {
    video.currentTime = desiredSeconds;
  } catch {
    cleanup();
  }
}

function playAfterSeek(video, targetSeconds, options = {}) {
  seekVideoElement(video, targetSeconds, {
    ...options,
    autoplay: true
  });
}

function App() {
  const initialLayer = useMemo(() => createLayer("Layer 1"), []);
  const initialVideoLayer = useMemo(() => createVideoLayer("Video 1"), []);

  const [videoPath, setVideoPath] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [blendVideoUrl, setBlendVideoUrl] = useState("");
  const [blendVideoOpacity, setBlendVideoOpacity] = useState(0);
  const [mainVideoOpacity, setMainVideoOpacity] = useState(1);
  const [videoLayers, setVideoLayers] = useState([initialVideoLayer]);
  const [activeVideoLayerId, setActiveVideoLayerId] = useState(initialVideoLayer.id);
  const [videoClips, setVideoClips] = useState([]);
  const [currentVideoClipId, setCurrentVideoClipId] = useState(null);
  const [videoMeta, setVideoMeta] = useState(DEFAULT_VIDEO_META);
  const [previewScale, setPreviewScale] = useState(1);
  const [layers, setLayers] = useState([initialLayer]);
  const [activeLayerId, setActiveLayerId] = useState(initialLayer.id);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isGapPreview, setIsGapPreview] = useState(false);
  const [currentPressure, setCurrentPressure] = useState(0);
  const [currentPressureInput, setCurrentPressureInput] = useState(IDLE_PRESSURE_INPUT);
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
  const [isPreviewDetached, setIsPreviewDetached] = useState(false);
  const [previewPortalNode, setPreviewPortalNode] = useState(null);

  const videoRef = useRef(null);
  const blendVideoRef = useRef(null);
  const canvasRef = useRef(null);
  const previewWindowRef = useRef(null);
  const previewPopoutOpenedAtRef = useRef(null);
  const previewPopoutMovedRef = useRef(false);
  const previewPopoutNearSinceRef = useRef(null);
  const videoLayersRef = useRef(videoLayers);
  const activeVideoLayerIdRef = useRef(activeVideoLayerId);
  const videoClipsRef = useRef(videoClips);
  const currentVideoClipIdRef = useRef(currentVideoClipId);
  const layersRef = useRef(layers);
  const activeLayerIdRef = useRef(activeLayerId);
  const videoMetaRef = useRef(videoMeta);
  const previewScaleRef = useRef(previewScale);
  const brushRef = useRef(brush);
  const onionSkinRef = useRef(onionSkin);
  const currentTimeRef = useRef(0);
  const playheadMsRef = useRef(0);

  const activeStrokeRef = useRef(null);
  const pointerIdRef = useRef(null);
  const renderStateRef = useRef(createRenderState());
  const dirtyRef = useRef(true);
  const lastFrameRef = useRef(-1);
  const resizeRef = useRef(null);
  const pendingVideoSeekRef = useRef(null);
  const pendingBlendSeekRef = useRef(null);
  const blendVideoUrlRef = useRef("");
  const blendVideoOpacityRef = useRef(0);
  const mainVideoOpacityRef = useRef(1);
  const playbackTickLastPerfRef = useRef(null);
  const gapPlaybackRef = useRef(false);
  const gapTickLastPerfRef = useRef(null);
  const isPlayingRef = useRef(false);
  const justResumedRef = useRef(false);
  const currentPressureUiRef = useRef(0);
  const pressureUiUpdatedAtRef = useRef(0);

  const setPlayheadMs = useCallback((nextMs) => {
    const safeMs = Math.max(0, Number(nextMs) || 0);
    playheadMsRef.current = safeMs;
    const safeSeconds = safeMs / 1000;
    currentTimeRef.current = safeSeconds;
    setCurrentTime(safeSeconds);
  }, []);

  const resolveTimelineEndMs = useCallback(() => {
    const clipMs = totalTimelineDurationMs(videoClipsRef.current);
    const fps = Number(videoMetaRef.current.fps) || DEFAULT_VIDEO_META.fps;
    const drawMs = annotationTimelineDurationMs(layersRef.current, fps);
    const metaMs = Math.max(0, (Number(videoMetaRef.current.duration) || 0) * 1000);
    return Math.max(clipMs, drawMs, metaMs);
  }, []);

  const updateCurrentPressure = useCallback((value, options = {}) => {
    const { force = false, input = null } = options;
    const safe = clamp(Number(value) || 0, 0, 1);
    const now = performance.now();
    const prevUi = currentPressureUiRef.current;
    if (force || now - pressureUiUpdatedAtRef.current >= 33 || Math.abs(safe - prevUi) >= 0.05) {
      currentPressureUiRef.current = safe;
      pressureUiUpdatedAtRef.current = now;
      setCurrentPressure(safe);
      if (input) {
        setCurrentPressureInput(input);
      }
    }
  }, []);

  const dockPreview = useCallback((options = {}) => {
    const { closeWindow = true } = options;
    const previewWindow = previewWindowRef.current;
    if (previewWindow && closeWindow && !previewWindow.closed) {
      previewWindow.close();
    }

    previewWindowRef.current = null;
    previewPopoutOpenedAtRef.current = null;
    previewPopoutMovedRef.current = false;
    previewPopoutNearSinceRef.current = null;
    setPreviewPortalNode(null);
    setIsPreviewDetached(false);
  }, []);

  const undockPreview = useCallback(() => {
    if (videoClipsRef.current.length === 0) {
      return;
    }

    const existingWindow = previewWindowRef.current;
    if (existingWindow && !existingWindow.closed) {
      existingWindow.focus();
      setIsPreviewDetached(true);
      return;
    }

    const sourceWidth = Math.max(640, Math.round((videoMetaRef.current.width || DEFAULT_VIDEO_META.width) * 0.85));
    const sourceHeight = Math.max(360, Math.round((videoMetaRef.current.height || DEFAULT_VIDEO_META.height) * 0.85));
    const previewWindow = window.open(
      "",
      "drawonvideo-preview",
      `popup=yes,width=${sourceWidth},height=${sourceHeight}`
    );

    if (!previewWindow) {
      setStatus("Preview pop-out blocked by the system/browser.");
      return;
    }

    const doc = previewWindow.document;
    doc.title = "DrawOnVideo - Preview";
    doc.body.innerHTML = "";
    copyDocumentStyles(doc);
    doc.body.style.margin = "0";
    doc.body.style.background = "#000";
    doc.body.style.overflow = "hidden";

    const host = doc.createElement("div");
    host.className = "preview-popout-root";
    host.style.width = "100vw";
    host.style.height = "100vh";
    doc.body.appendChild(host);

    previewWindowRef.current = previewWindow;
    previewPopoutOpenedAtRef.current = performance.now();
    previewPopoutMovedRef.current = false;
    previewPopoutNearSinceRef.current = null;
    setPreviewPortalNode(host);
    setIsPreviewDetached(true);
    previewWindow.focus();

    const onPreviewClosed = () => {
      if (previewWindowRef.current === previewWindow) {
        dockPreview({ closeWindow: false });
      }
    };

    previewWindow.addEventListener("beforeunload", onPreviewClosed, { once: true });
  }, [dockPreview]);

  const handleTogglePreviewDetach = useCallback(() => {
    if (isPreviewDetached) {
      dockPreview();
      return;
    }

    undockPreview();
  }, [dockPreview, isPreviewDetached, undockPreview]);

  const setCompositeOpacity = useCallback((mainOpacity, blendOpacity) => {
    const safeMain = clamp(Number(mainOpacity), 0, 1);
    const safeBlend = clamp(Number(blendOpacity), 0, 1);

    if (Math.abs(mainVideoOpacityRef.current - safeMain) >= 0.01) {
      mainVideoOpacityRef.current = safeMain;
      setMainVideoOpacity(safeMain);
    }
    if (Math.abs(blendVideoOpacityRef.current - safeBlend) >= 0.01) {
      blendVideoOpacityRef.current = safeBlend;
      setBlendVideoOpacity(safeBlend);
    }
  }, []);

  const hideBlendVideo = useCallback(() => {
    setCompositeOpacity(1, 0);
    pendingBlendSeekRef.current = null;
    const blendVideo = blendVideoRef.current;
    if (blendVideo && !blendVideo.paused) {
      blendVideo.pause();
    }
  }, [setCompositeOpacity]);

  const syncBlendVideo = useCallback((globalMs, activeClip, shouldPlay) => {
    const blendVideo = blendVideoRef.current;
    if (!blendVideo || !activeClip) {
      hideBlendVideo();
      return;
    }

    const crossfade = resolveSameLayerCrossfade(videoClipsRef.current, activeClip, globalMs);
    const outgoingClip = crossfade?.outgoingClip || null;
    if (!outgoingClip?.url) {
      hideBlendVideo();
      return;
    }

    setCompositeOpacity(crossfade.activeOpacity, crossfade.outgoingOpacity);

    const targetLocalMs = clipLocalMsAtTimelineMs(
      outgoingClip,
      globalMs,
      Number.isFinite(Number(blendVideo.duration)) ? Number(blendVideo.duration) * 1000 : 0
    );
    const targetSeconds = targetLocalMs / 1000;

    const clearPendingBlendSeek = () => {
      const pending = pendingBlendSeekRef.current;
      if (
        pending?.clipId === outgoingClip.id
        && Math.abs((Number(pending.localMs) || 0) - targetLocalMs) <= 0.5
      ) {
        pendingBlendSeekRef.current = null;
      }
    };

    pendingBlendSeekRef.current = {
      clipId: outgoingClip.id,
      localMs: targetLocalMs,
      autoplay: shouldPlay
    };

    if (blendVideoUrlRef.current !== outgoingClip.url) {
      blendVideoUrlRef.current = outgoingClip.url;
      setBlendVideoUrl(outgoingClip.url);
      return;
    }

    if (Math.abs((Number(blendVideo.currentTime) || 0) - targetSeconds) > 0.08) {
      seekVideoElement(blendVideo, targetSeconds, {
        autoplay: shouldPlay,
        onSettled: clearPendingBlendSeek
      });
      return;
    }

    clearPendingBlendSeek();
    if (shouldPlay && blendVideo.paused) {
      blendVideo.play().catch(() => { });
    } else if (!shouldPlay && !blendVideo.paused) {
      blendVideo.pause();
    }
  }, [hideBlendVideo, setCompositeOpacity]);

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
    previewScaleRef.current = normalizePreviewScale(previewScale);
    dirtyRef.current = true;
  }, [previewScale]);

  useEffect(() => {
    if (isPreviewDetached && videoClips.length === 0) {
      dockPreview();
    }
  }, [dockPreview, isPreviewDetached, videoClips.length]);

  useEffect(() => {
    if (!isPreviewDetached) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      const previewWindow = previewWindowRef.current;
      if (!previewWindow) {
        return;
      }

      if (previewWindow.closed) {
        dockPreview({ closeWindow: false });
        return;
      }

      const mainRect = readWindowRect(window);
      const previewRect = readWindowRect(previewWindow);
      if (!mainRect || !previewRect) {
        return;
      }

      const now = performance.now();
      const openedAt = Number(previewPopoutOpenedAtRef.current);
      if (Number.isFinite(openedAt) && now - openedAt < 1500) {
        return;
      }

      const nearDistance = rectDistance(mainRect, previewRect);
      const farThresholdPx = 200;
      if (!previewPopoutMovedRef.current) {
        if (nearDistance >= farThresholdPx) {
          previewPopoutMovedRef.current = true;
          previewPopoutNearSinceRef.current = null;
        }
        return;
      }

      const nearThresholdPx = 28;
      if (nearDistance > nearThresholdPx) {
        previewPopoutNearSinceRef.current = null;
        return;
      }

      if (!Number.isFinite(Number(previewPopoutNearSinceRef.current))) {
        previewPopoutNearSinceRef.current = now;
        return;
      }

      if (now - previewPopoutNearSinceRef.current >= 280) {
        dockPreview();
      }
    }, 120);

    return () => window.clearInterval(intervalId);
  }, [dockPreview, isPreviewDetached]);

  useEffect(() => () => {
    const previewWindow = previewWindowRef.current;
    if (previewWindow && !previewWindow.closed) {
      previewWindow.close();
    }
  }, []);

  useEffect(() => {
    brushRef.current = brush;
  }, [brush]);

  useEffect(() => {
    onionSkinRef.current = onionSkin;
    dirtyRef.current = true;
  }, [onionSkin]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const safeScale = normalizePreviewScale(previewScale);
    const sourceWidth = Math.max(1, Math.round(videoMeta.width || DEFAULT_VIDEO_META.width));
    const sourceHeight = Math.max(1, Math.round(videoMeta.height || DEFAULT_VIDEO_META.height));
    canvas.width = Math.max(1, Math.round(sourceWidth * safeScale));
    canvas.height = Math.max(1, Math.round(sourceHeight * safeScale));
    renderStateRef.current = createRenderState();
    dirtyRef.current = true;
  }, [previewScale, videoMeta.width, videoMeta.height]);

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
      duration: Math.max(totalMs, annotationTimelineDurationMs(layersRef.current, Number(first.fps) || prev.fps || DEFAULT_VIDEO_META.fps)) / 1000
    }));

    if (!videoPath) {
      setVideoPath(first.path || "");
    }
  }, [videoClips, videoPath]);

  useEffect(() => {
    const videoMs = totalTimelineDurationMs(videoClips);
    const drawMs = annotationTimelineDurationMs(layers, videoMeta.fps);
    const nextDuration = Math.max(videoMs, drawMs) / 1000;

    setVideoMeta((prev) => {
      const prevDuration = Number(prev.duration) || 0;
      if (Math.abs(prevDuration - nextDuration) <= 0.0005) {
        return prev;
      }
      return {
        ...prev,
        duration: nextDuration
      };
    });
  }, [layers, videoClips, videoMeta.fps]);

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
      setPlayheadMs(safeTargetMs);
      if (!clip) {
        hideBlendVideo();
        pendingVideoSeekRef.current = null;
        dirtyRef.current = true;
        if (autoplay) {
          gapPlaybackRef.current = true;
          gapTickLastPerfRef.current = performance.now();
          setIsGapPreview(true);
          setIsPlaying(true);
        } else {
          gapPlaybackRef.current = false;
          gapTickLastPerfRef.current = null;
          setIsGapPreview(true);
          setIsPlaying(false);
        }
        currentVideoClipIdRef.current = null;
        setCurrentVideoClipId(null);
        if (video) {
          video.pause();
        }
      }
      return;
    }

    const safeGlobalMs = safeTargetMs;
    const timelineStartMs = Number(clip.timelineStartMs) || 0;
    const loadedVideoDurationMs = Number.isFinite(Number(video.duration)) ? Number(video.duration) * 1000 : 0;
    const localRange = clipLocalRangeMs(clip, loadedVideoDurationMs);
    const unclampedLocalMs = localRange.startMs + (safeGlobalMs - timelineStartMs);
    const localMs = clamp(unclampedLocalMs, localRange.startMs, localRange.endMs);

    setPlayheadMs(safeGlobalMs);
    dirtyRef.current = true;
    gapPlaybackRef.current = false;
    gapTickLastPerfRef.current = null;
    setIsGapPreview(false);

    const needsSourceSwap = videoUrl !== clip.url;
    if (needsSourceSwap) {
      pendingVideoSeekRef.current = {
        clipId: clip.id,
        localMs,
        autoplay
      };
      currentVideoClipIdRef.current = clip.id;
      setCurrentVideoClipId(clip.id);
      setVideoUrl(clip.url);
      return;
    }

    if (currentVideoClipIdRef.current !== clip.id) {
      currentVideoClipIdRef.current = clip.id;
      setCurrentVideoClipId(clip.id);
    }
    if (clip.videoLayerId && clip.videoLayerId !== activeVideoLayerIdRef.current) {
      setActiveVideoLayerId(clip.videoLayerId);
    }

    pendingVideoSeekRef.current = {
      clipId: clip.id,
      localMs,
      autoplay
    };
    const clearPendingSeek = () => {
      const pending = pendingVideoSeekRef.current;
      if (pending?.clipId === clip.id && Math.abs((Number(pending.localMs) || 0) - localMs) <= 0.5) {
        pendingVideoSeekRef.current = null;
      }
    };

    if (autoplay) {
      playAfterSeek(video, localMs / 1000, { onSettled: clearPendingSeek });
    } else {
      seekVideoElement(video, localMs / 1000, { onSettled: clearPendingSeek });
    }
  }, [hideBlendVideo, videoUrl]);

  const continueTimelineAfterVideoEnded = useCallback(() => {
    const video = videoRef.current;
    const fps = Math.max(videoMetaRef.current.fps || 30, 1);
    const frameStepMs = 1000 / fps;
    const ordered = sortVideoClips(videoClipsRef.current);
    const activeClip = ordered.find((clip) => clip.id === currentVideoClipIdRef.current) || null;
    const timelineEndMs = resolveTimelineEndMs();
    const mediaDurationMs = Number.isFinite(Number(video?.duration)) ? Number(video.duration) * 1000 : 0;
    let currentMs = Math.max(playheadMsRef.current, currentTimeRef.current * 1000);

    if (activeClip) {
      const sourceStartMs = Number(activeClip.sourceStartMs) || 0;
      const sourceEndMs = Number.isFinite(Number(activeClip.sourceEndMs))
        ? Number(activeClip.sourceEndMs)
        : Math.max(sourceStartMs, mediaDurationMs);
      const activeEndMs = (Number(activeClip.timelineStartMs) || 0) + Math.max(0, sourceEndMs - sourceStartMs);
      currentMs = Math.max(currentMs, activeEndMs);
    }

    const nextGlobalMs = Math.min(timelineEndMs, currentMs + frameStepMs);
    if (timelineEndMs > 0 && nextGlobalMs < timelineEndMs - 0.5) {
      const nextClip = findVideoClipAtTime(ordered, nextGlobalMs, {
        preferredLayerId: activeVideoLayerIdRef.current,
        layerOrderIds: (videoLayersRef.current || []).map((layer) => layer.id)
      });
      if (nextClip) {
        seekGlobalTimeMs(nextGlobalMs, { autoplay: true });
        return;
      }

      setPlayheadMs(nextGlobalMs);
      currentVideoClipIdRef.current = null;
      setCurrentVideoClipId(null);
      setIsGapPreview(true);
      gapPlaybackRef.current = true;
      gapTickLastPerfRef.current = performance.now();
      setIsPlaying(true);
      return;
    }

    gapPlaybackRef.current = false;
    gapTickLastPerfRef.current = null;
    setIsGapPreview(false);
    setIsPlaying(false);
  }, [resolveTimelineEndMs, seekGlobalTimeMs, setPlayheadMs]);

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
      onionSkin: onionSkinRef.current,
      coordinateScale: previewScaleRef.current
    });
  }, []);

  useEffect(() => {
    let rafId;

    const tick = () => {
      const video = videoRef.current;
      const nowPerf = performance.now();

      if (pendingVideoSeekRef.current !== null) {
        playbackTickLastPerfRef.current = nowPerf;
        const timelineNow = Math.max(0, Number(currentTimeRef.current) || 0);
        const frame = Math.round(timelineNow * (videoMetaRef.current.fps || 30));
        const shouldRender =
          dirtyRef.current ||
          activeStrokeRef.current !== null ||
          frame !== lastFrameRef.current;

        if (shouldRender) {
          drawOverlay(timelineNow);
          dirtyRef.current = false;
          lastFrameRef.current = frame;
        }
      } else if (video && videoUrl && !gapPlaybackRef.current) {
        const orderedClips = sortVideoClips(videoClipsRef.current);
        const activeClip = orderedClips.find((clip) => clip.id === currentVideoClipIdRef.current) || null;
        const videoLocalMs = (Number(video.currentTime) || 0) * 1000;
        const derivedGlobalMs = activeClip
          ? (() => {
            const activeClipDurationMs = Number.isFinite(Number(activeClip.sourceDurationMs))
              ? Number(activeClip.sourceDurationMs)
              : 0;
            const activeLocalRange = clipLocalRangeMs(activeClip, activeClipDurationMs);
            const clampedLocalMs = clamp(
              videoLocalMs,
              activeLocalRange.startMs,
              activeLocalRange.endMs
            );
            return (Number(activeClip.timelineStartMs) || 0)
              + (clampedLocalMs - activeLocalRange.startMs);
          })()
          : videoLocalMs;
        let globalMs = derivedGlobalMs;

        if (isPlaying) {
          if (justResumedRef.current) {
            justResumedRef.current = false;
          }

          playbackTickLastPerfRef.current = nowPerf;

          const timelineEndMs = resolveTimelineEndMs();
          globalMs = timelineEndMs > 0
            ? Math.min(timelineEndMs, derivedGlobalMs)
            : derivedGlobalMs;
        }

        const mediaNow = Math.max(0, globalMs / 1000);
        const timelineNow = isPlaying
          ? mediaNow
          : Math.max(0, Number(currentTimeRef.current) || 0);
        const frame = Math.round(timelineNow * (videoMetaRef.current.fps || 30));
        const shouldRender =
          dirtyRef.current ||
          isPlaying ||
          activeStrokeRef.current !== null ||
          frame !== lastFrameRef.current;

        if (shouldRender) {
          drawOverlay(timelineNow);
          dirtyRef.current = false;
          lastFrameRef.current = frame;
        }

        if (isPlaying && Math.abs(currentTimeRef.current - mediaNow) >= 1 / 120) {
          setPlayheadMs(mediaNow * 1000);
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

        if (isPlaying && !visibleClip) {
          setPlayheadMs(globalMs);
          currentVideoClipIdRef.current = null;
          setCurrentVideoClipId(null);
          setIsGapPreview(true);
          gapPlaybackRef.current = true;
          gapTickLastPerfRef.current = nowPerf;
          playbackTickLastPerfRef.current = null;
          hideBlendVideo();
          video.pause();
        } else if (
          isPlaying
          && visibleClip
          && (!activeClip || visibleClip.id !== currentVideoClipIdRef.current)
        ) {
          seekGlobalTimeMs(globalMs, { autoplay: true });
        } else if (activeClip) {

          syncBlendVideo(globalMs, activeClip, isPlaying && !video.paused);
        } else {
          hideBlendVideo();
        }
      } else if (isPlaying && (video || videoClipsRef.current.length > 0)) {
        hideBlendVideo();
        const previousPerf = Number(gapTickLastPerfRef.current);
        const elapsedMs = Number.isFinite(previousPerf)
          ? clamp(nowPerf - previousPerf, 0, 120)
          : (1000 / Math.max(videoMetaRef.current.fps || 30, 1));
        gapTickLastPerfRef.current = nowPerf;
        gapPlaybackRef.current = true;

        const timelineEndMs = resolveTimelineEndMs();
        const nextGlobalMs = timelineEndMs > 0
          ? Math.min(timelineEndMs, Math.max(0, playheadMsRef.current + elapsedMs))
          : Math.max(0, playheadMsRef.current + elapsedMs);
        const nextSeconds = nextGlobalMs / 1000;
        const frame = Math.round(nextSeconds * (videoMetaRef.current.fps || 30));
        const shouldRender =
          dirtyRef.current ||
          activeStrokeRef.current !== null ||
          frame !== lastFrameRef.current;

        if (Math.abs(playheadMsRef.current - nextGlobalMs) >= 0.1) {
          setPlayheadMs(nextGlobalMs);
        }

        if (shouldRender) {
          drawOverlay(nextSeconds);
          dirtyRef.current = false;
          lastFrameRef.current = frame;
        }

        const orderedClips = sortVideoClips(videoClipsRef.current);
        const visibleClip = findVideoClipAtTime(orderedClips, nextGlobalMs, {
          preferredLayerId: activeVideoLayerIdRef.current,
          layerOrderIds: (videoLayersRef.current || []).map((layer) => layer.id)
        });

        if (visibleClip && pendingVideoSeekRef.current === null) {
          gapPlaybackRef.current = false;
          gapTickLastPerfRef.current = null;
          setIsGapPreview(false);
          seekGlobalTimeMs(nextGlobalMs, { autoplay: true });
        } else if (timelineEndMs > 0 && nextGlobalMs >= timelineEndMs - 0.5) {
          gapPlaybackRef.current = false;
          gapTickLastPerfRef.current = null;
          setIsGapPreview(false);
          setIsPlaying(false);
        }
      } else if (dirtyRef.current) {
        drawOverlay(Math.max(0, Number(currentTimeRef.current) || 0));
        dirtyRef.current = false;
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [
    drawOverlay,
    hideBlendVideo,
    isPlaying,
    resolveTimelineEndMs,
    seekGlobalTimeMs,
    setPlayheadMs,
    syncBlendVideo,
    videoUrl
  ]);

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

    const logicalWidth = Math.max(1, Math.round(videoMetaRef.current.width || DEFAULT_VIDEO_META.width));
    const logicalHeight = Math.max(1, Math.round(videoMetaRef.current.height || DEFAULT_VIDEO_META.height));
    const x = ((event.clientX - rect.left) / rect.width) * logicalWidth;
    const y = ((event.clientY - rect.top) / rect.height) * logicalHeight;

    return {
      x: clamp(x, 0, logicalWidth),
      y: clamp(y, 0, logicalHeight)
    };
  }, []);

  const finalizeStroke = useCallback(() => {
    const stroke = activeStrokeRef.current;
    const targetLayerId = activeLayerIdRef.current;

    if (!stroke || !targetLayerId) {
      activeStrokeRef.current = null;
      pointerIdRef.current = null;
      dirtyRef.current = true;
      updateCurrentPressure(0, { force: true, input: IDLE_PRESSURE_INPUT });
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
    updateCurrentPressure(0, { force: true, input: IDLE_PRESSURE_INPUT });
  }, [updateCurrentPressure]);

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

      const nowSeconds = currentTimeRef.current || videoRef.current?.currentTime || 0;
      const nowMs = nowSeconds * 1000;
      const frame = frameFromTimeMs(nowMs, videoMetaRef.current.fps);
      const pressureInfo = readPointerPressureInfo(event);
      const startPressure = normalizePressure(event, brushRef.current.pressureEnabled, {
        pressureInfo
      });

      activeStrokeRef.current = {
        id: createId("stroke"),
        tool: brushRef.current.tool,
        color: brushRef.current.color,
        size: brushRef.current.size,
        opacity: brushRef.current.opacity,
        pressureEnabled: brushRef.current.pressureEnabled,
        pressureSensitivity: brushRef.current.pressureSensitivity,
        pressureCurve: brushRef.current.pressureCurve,
        pressureMinScale: brushRef.current.pressureMinScale,
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
            pressure: startPressure
          }
        ]
      };

      pointerIdRef.current = event.pointerId;
      dirtyRef.current = true;
      updateCurrentPressure(startPressure, { force: true, input: pressureInfo });
    },
    [exportState.running, mapPointerToVideo, updateCurrentPressure, videoPath]
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
      const motionDistancePx = Math.hypot(deltaX, deltaY);

      if (motionDistancePx < 0.15) {
        return;
      }

      const nowSeconds = currentTimeRef.current || videoRef.current?.currentTime || 0;
      const nowMs = nowSeconds * 1000;
      const frame = frameFromTimeMs(nowMs, videoMetaRef.current.fps);
      const pressureInfo = readPointerPressureInfo(event);
      const nextPressure = normalizePressure(event, stroke.pressureEnabled, {
        fallbackPressure: previousPoint.pressure,
        pressureInfo
      });

      stroke.points.push({
        ...point,
        timeMs: nowMs,
        pressure: nextPressure
      });
      stroke.endFrame = Math.max(stroke.endFrame, frame);

      dirtyRef.current = true;
      updateCurrentPressure(nextPressure, { input: pressureInfo });
    },
    [mapPointerToVideo, updateCurrentPressure]
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
      currentVideoClipIdRef.current = initialClip.id;
      setCurrentVideoClipId(initialClip.id);
      setVideoMeta(mergedMeta);
      setSelectedClips([]);
      setSelectedVideoClipIds([]);
      const initialTime = (initialClip?.timelineStartMs || 0) / 1000;
      setPlayheadMs(initialTime * 1000);
      setIsGapPreview(false);
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

      const wasPlaying = isPlayingRef.current;
      const syncMs = Math.max(0, playheadMsRef.current);

      const nextClips = [...videoClipsRef.current, clip];

      videoClipsRef.current = nextClips;
      setVideoClips(nextClips);

      window.requestAnimationFrame(() => {
        seekGlobalTimeMs(syncMs, { autoplay: wasPlaying });
      });

      setStatus(`Video added: ${selected}`);
    } catch (error) {
      setStatus(`Failed to add video: ${error.message}`);
    }
  }, [seekGlobalTimeMs]);
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
      currentVideoClipIdRef.current = firstClip?.id || null;
      setCurrentVideoClipId(firstClip?.id || null);
      setVideoMeta(nextMeta);
      setLayers(nextLayers);
      setActiveLayerId(nextLayers[0]?.id || createLayer("Layer 1").id);
      setSelectedClips([]);
      setSelectedVideoClipIds([]);
      setPlayheadMs(0);
      setIsGapPreview(false);
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
    if (!video || videoClipsRef.current.length === 0) {
      return;
    }

    const playing = isPlayingRef.current;

    try {
      if (playing) {
        gapPlaybackRef.current = false;
        gapTickLastPerfRef.current = null;
        playbackTickLastPerfRef.current = null;
        justResumedRef.current = false;
        setIsGapPreview(false);
        video.pause();
        blendVideoRef.current?.pause();
        isPlayingRef.current = false;
        setIsPlaying(false);
        return;
      }

      // Mark that we just resumed so the tick loop anchors to the real video
      // position on the first frame instead of jumping ahead.
      justResumedRef.current = true;

      const playFromMs = Math.max(
        0,
        Number.isFinite(Number(playheadMsRef.current))
          ? Number(playheadMsRef.current)
          : (Number(currentTimeRef.current) || 0) * 1000
      );
      setPlayheadMs(playFromMs);
      playbackTickLastPerfRef.current = performance.now();
      seekGlobalTimeMs(playFromMs, { autoplay: true });
    } catch (error) {
      setStatus(`Playback error: ${error.message}`);
    }
  }, [seekGlobalTimeMs, setPlayheadMs]);

  const handleSeek = useCallback((nextTime) => {
    if (videoClipsRef.current.length === 0) {
      return;
    }

    const timelineDuration = totalTimelineDurationMs(videoClipsRef.current) / 1000;
    const drawingDuration = annotationTimelineDurationMs(layersRef.current, videoMetaRef.current.fps) / 1000;
    const mediaDuration = Number.isFinite(Number(videoRef.current?.duration))
      ? Number(videoRef.current.duration)
      : 0;
    const duration = Math.max(Number(videoMetaRef.current.duration) || 0, timelineDuration, drawingDuration, mediaDuration);
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
      const baseGlobalMs = Math.max(0, (Number(currentTimeRef.current) || Number(currentTime) || 0) * 1000);
      const nextGlobalMs = Math.max(0, baseGlobalMs + safeDirection * (1000 / safeFps));

      video.pause();
      playbackTickLastPerfRef.current = null;
      setIsPlaying(false);
      seekGlobalTimeMs(nextGlobalMs, { autoplay: false });
    },
    [currentTime, seekGlobalTimeMs]
  );

  const activeLayer = layers.find((layer) => layer.id === activeLayerId);
  const activeVideoLayer = videoLayers.find((layer) => layer.id === activeVideoLayerId);

  const handleBrushChange = useCallback((patch) => {
    const normalizedPatch = normalizeBrushPatch(patch);
    setBrush((prev) => ({ ...prev, ...normalizedPatch }));
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
    const wasPlaying = isPlayingRef.current;
    const safeCutMs = Math.max(
      0,
      Number.isFinite(Number(cutMs))
        ? Number(cutMs)
        : playheadMsRef.current
    );

    const nextClips = splitVideoClip(
      videoClipsRef.current,
      clipId,
      safeCutMs
    );

    videoClipsRef.current = nextClips;
    setVideoClips(nextClips);

    const clipAtCut = findVideoClipAtTime(nextClips, safeCutMs, {
      preferredLayerId: activeVideoLayerIdRef.current,
      layerOrderIds: (videoLayersRef.current || []).map((layer) => layer.id)
    });

    currentVideoClipIdRef.current = clipAtCut?.id || null;
    setCurrentVideoClipId(clipAtCut?.id || null);
    setSelectedVideoClipIds(clipAtCut ? [clipAtCut.id] : []);

    if (clipAtCut?.path) {
      setVideoPath(clipAtCut.path);
    }

    if (clipAtCut?.url && clipAtCut.url !== videoUrl) {
      setVideoUrl(clipAtCut.url);
    }

    window.requestAnimationFrame(() => {
      seekGlobalTimeMs(safeCutMs, { autoplay: wasPlaying });
    });
  }, [seekGlobalTimeMs, videoUrl]);

  const handleMoveClip = useCallback((layerId, strokeId, nextWindow) => {
    const durationMs = Number.POSITIVE_INFINITY;

    setLayers((prevLayers) =>
      updateStrokeOnLayer(prevLayers, layerId, strokeId, (stroke) => {
        const currentWindow = strokeClipWindowMs(stroke, videoMetaRef.current.fps, durationMs);
        const deltaMs = (Number(nextWindow?.startMs) || 0) - currentWindow.clipStartMs;
        return shiftStrokeInTime(stroke, deltaMs, videoMetaRef.current.fps, durationMs);
      })
    );
  }, []);

  const handleTrimClip = useCallback((layerId, strokeId, nextWindow) => {
    const durationMs = Number.POSITIVE_INFINITY;

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
    const durationMs = Number.POSITIVE_INFINITY;
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
      currentVideoClipIdRef.current = null;
      setCurrentVideoClipId(null);
      setVideoUrl("");
      setVideoPath("");
      setPlayheadMs(0);
      return;
    }

    const activeClipId = currentVideoClipIdRef.current;
    if (!activeClipId) {
      return;
    }

    const exists = ordered.some((clip) => clip.id === activeClipId);
    if (!exists) {
      // The active clip was removed (e.g. after a split). Find the clip at
      // the current playhead so we don't jump back to the start.
      const globalMs = Math.max(0, playheadMsRef.current);
      const clipAtPlayhead = findVideoClipAtTime(ordered, globalMs, {
        preferredLayerId: activeVideoLayerIdRef.current,
        layerOrderIds: (videoLayersRef.current || []).map((l) => l.id)
      });
      const fallback = clipAtPlayhead || ordered[0];
      currentVideoClipIdRef.current = fallback.id;
      setCurrentVideoClipId(fallback.id);
      if (fallback.url !== videoUrl) {
        setVideoUrl(fallback.url);
      }
      setVideoPath(fallback.path);
      const seekMs = clipAtPlayhead ? globalMs : (fallback.timelineStartMs || 0);
      seekGlobalTimeMs(seekMs, { autoplay: false });
    }
  }, [seekGlobalTimeMs, setPlayheadMs, videoClips]);

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
      const exportWidth = Number(options?.width) || videoMetaRef.current.width;
      const exportHeight = Number(options?.height) || videoMetaRef.current.height;

      const recordingBytes = await renderAndRecordAnnotatedVideo({
        videoUrl,
        videoClips: videoClipsRef.current,
        videoLayers: videoLayersRef.current,
        layers: layersRef.current,
        videoMeta: {
          ...videoMetaRef.current,
          width: exportWidth,
          height: exportHeight
        },
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
        outputWidth: exportWidth,
        outputHeight: exportHeight,
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
  const safePreviewScale = normalizePreviewScale(previewScale);
  const previewStage = (
    <div
      className="video-stage"
      style={{
        aspectRatio: `${videoMeta.width || 16}/${videoMeta.height || 9}`
      }}
    >
      <div
        className={`preview-resolution-shell ${safePreviewScale < 0.999 ? "is-scaled" : ""}`}
        style={{ "--preview-scale": safePreviewScale }}
      >
        <video
          ref={blendVideoRef}
          className="video-layer blend-video-layer"
          src={blendVideoUrl}
          muted
          playsInline
          style={{ opacity: blendVideoOpacity }}
          onLoadedMetadata={(event) => {
            const pendingSeek = pendingBlendSeekRef.current;
            if (!pendingSeek) {
              return;
            }

            const video = event.currentTarget;
            const pendingSeconds = (Number(pendingSeek.localMs) || 0) / 1000;
            const clearPendingBlendSeek = () => {
              const pending = pendingBlendSeekRef.current;
              if (
                pending?.clipId === pendingSeek.clipId
                && Math.abs((Number(pending.localMs) || 0) - (Number(pendingSeek.localMs) || 0)) <= 0.5
              ) {
                pendingBlendSeekRef.current = null;
              }
            };

            seekVideoElement(video, pendingSeconds, {
              autoplay: pendingSeek.autoplay,
              onSettled: clearPendingBlendSeek
            });
          }}
        />
        <video
          ref={videoRef}
          className={`video-layer ${isGapPreview ? "gap-hidden" : ""}`}
          src={videoUrl}
          style={{ opacity: isGapPreview ? 0 : mainVideoOpacity }}
          onPlay={() => {
            playbackTickLastPerfRef.current = performance.now();
            isPlayingRef.current = true;
            setIsPlaying(true);
          }}
          onPause={() => {
            if (!gapPlaybackRef.current) {
              playbackTickLastPerfRef.current = null;
              isPlayingRef.current = false;
              setIsPlaying(false);
            }
          }}
          onEnded={continueTimelineAfterVideoEnded}
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            const pendingSeek = pendingVideoSeekRef.current;
            if (pendingSeek) {
              if (pendingSeek.clipId && pendingSeek.clipId !== currentVideoClipIdRef.current) {
                currentVideoClipIdRef.current = pendingSeek.clipId;
                setCurrentVideoClipId(pendingSeek.clipId);
              }
              const pendingSeconds = (Number(pendingSeek.localMs) || 0) / 1000;
              const clearPendingSeek = () => {
                const pending = pendingVideoSeekRef.current;
                if (
                  pending?.clipId === pendingSeek.clipId
                  && Math.abs((Number(pending.localMs) || 0) - (Number(pendingSeek.localMs) || 0)) <= 0.5
                ) {
                  pendingVideoSeekRef.current = null;
                }
              };
              if (pendingSeek.autoplay) {
                playAfterSeek(video, pendingSeconds, { onSettled: clearPendingSeek });
              } else {
                seekVideoElement(video, pendingSeconds, { onSettled: clearPendingSeek });
              }
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
                  const hasValidRange = Number.isFinite(currentEnd) && currentEnd >= currentStart;
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
    </div>
  );

  return (
    <div className="app-shell">
      <TopBar
        projectName={projectName}
        status={status}
        exportState={exportState}
        previewScale={safePreviewScale}
        isPreviewDetached={isPreviewDetached}
        onOpenVideo={handleOpenVideo}
        onAddVideo={handleAddVideo}
        onSaveProject={handleSaveProject}
        onLoadProject={handleLoadProject}
        onExportVideo={handleOpenExportDialog}
        onPreviewScaleChange={(nextScale) => setPreviewScale(normalizePreviewScale(nextScale))}
        onTogglePreviewDetach={handleTogglePreviewDetach}
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
          currentPressure={currentPressure}
          currentPressureInput={currentPressureInput}
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
              isPreviewDetached ? (
                <div className="empty-stage detached-stage">
                  <p>Preview undocked in a separate window.</p>
                  <button onClick={() => dockPreview()}>Dock Preview</button>
                </div>
              ) : previewStage
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

      {hasVideo && isPreviewDetached && previewPortalNode
        ? createPortal(previewStage, previewPortalNode)
        : null}

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
