import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  FormControlLabel,
  Slider,
  Stack,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  Typography
} from "@mui/material";
import { formatTime } from "../utils/time";
import { strokeClipWindowMs } from "../utils/strokeClip";
import {
  clipAudioFadeInDurationMs,
  clipAudioFadeOutDurationMs,
  clipFadeInDurationMs,
  clipFadeOutDurationMs,
  clipTimelineEndMs
} from "../utils/videoClipOps";

const MIN_CLIP_MS = 80;
const FADE_HANDLE_EDGE_INSET_PX = 16;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function niceStepSeconds(pixelsPerSecond) {
  const targetPixels = 90;
  const rawStep = targetPixels / Math.max(20, pixelsPerSecond);
  const steps = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];

  for (const step of steps) {
    if (rawStep <= step) {
      return step;
    }
  }

  return 600;
}

function waitForEvent(target, eventName) {
  return new Promise((resolve, reject) => {
    const onEvent = () => {
      cleanup();
      resolve();
    };

    const onError = (error) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const cleanup = () => {
      target.removeEventListener(eventName, onEvent);
      target.removeEventListener("error", onError);
    };

    target.addEventListener(eventName, onEvent, { once: true });
    target.addEventListener("error", onError, { once: true });
  });
}

async function buildThumbnails({
  videoUrl,
  sourceStartSeconds = 0,
  sourceEndSeconds = null,
  timelineDurationSeconds = null,
  fps,
  targetCount
}) {
  const video = document.createElement("video");
  video.src = videoUrl;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";

  if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
    await waitForEvent(video, "loadedmetadata");
  }

  const actualDurationSeconds = Number.isFinite(Number(video.duration))
    ? Number(video.duration)
    : 0;

  const frameStep = 1 / Math.max(fps || 30, 1);
  const maxSeekSeconds = Math.max(0, actualDurationSeconds - frameStep);

  const safeSourceStart = clamp(
    Number(sourceStartSeconds) || 0,
    0,
    maxSeekSeconds
  );

  const rawSourceEnd = Number.isFinite(Number(sourceEndSeconds))
    ? Number(sourceEndSeconds)
    : actualDurationSeconds;

  const safeSourceEnd = clamp(
    rawSourceEnd,
    safeSourceStart,
    actualDurationSeconds
  );

  const sourceSegmentSeconds = Math.max(0, safeSourceEnd - safeSourceStart);
  const safeTimelineDurationSeconds = Number(timelineDurationSeconds) > 0
    ? Number(timelineDurationSeconds)
    : sourceSegmentSeconds;

  const sourceWidth = Math.max(1, Number(video.videoWidth) || 320);
  const sourceHeight = Math.max(1, Number(video.videoHeight) || 180);

  const thumbWidth = 130;
  const thumbHeight = Math.max(48, Math.round((thumbWidth * sourceHeight) / sourceWidth));

  const canvas = document.createElement("canvas");
  canvas.width = thumbWidth;
  canvas.height = thumbHeight;

  const ctx = canvas.getContext("2d", { alpha: false });

  if (!ctx) {
    throw new Error("Could not create thumbnail context.");
  }

  const safeTargetCount = Math.max(1, Number(targetCount) || 1);
  const thumbnails = [];

  for (let index = 0; index < safeTargetCount; index += 1) {
    const progress = index / safeTargetCount;
    const sourceTime = safeSourceStart + sourceSegmentSeconds * progress;
    const seekTime = clamp(sourceTime, 0, maxSeekSeconds);

    if (Math.abs((video.currentTime || 0) - seekTime) > 0.001) {
      video.currentTime = seekTime;
      await waitForEvent(video, "seeked");
    }

    ctx.drawImage(video, 0, 0, thumbWidth, thumbHeight);

    thumbnails.push({
      offsetMs: progress * safeTimelineDurationSeconds * 1000,
      dataUrl: canvas.toDataURL("image/jpeg", 0.62)
    });
  }

  video.removeAttribute("src");
  video.load();

  return thumbnails;
}
function clampDb(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return 0;
  }
  return Math.min(18, Math.max(-60, num));
}

function clipWavePeaksFromSource({
  sourcePeaks,
  sourceDurationMs,
  sourceStartMs,
  sourceEndMs,
  targetBars = 36
}) {
  if (!Array.isArray(sourcePeaks) || sourcePeaks.length === 0) {
    return [];
  }

  const safeDuration = Number(sourceDurationMs) > 0
    ? Number(sourceDurationMs)
    : Math.max(Number(sourceEndMs) || 0, Number(sourceStartMs) || 0, 1);

  const safeStart = Math.max(0, Math.min(safeDuration, Number(sourceStartMs) || 0));
  const safeEnd = Math.max(safeStart, Math.min(safeDuration, Number(sourceEndMs) || safeDuration));

  const startIndex = Math.max(0, Math.floor((safeStart / safeDuration) * (sourcePeaks.length - 1)));
  const endIndex = Math.max(startIndex + 1, Math.ceil((safeEnd / safeDuration) * (sourcePeaks.length - 1)));
  const segment = sourcePeaks.slice(startIndex, Math.min(sourcePeaks.length, endIndex + 1));

  if (segment.length <= targetBars) {
    return segment;
  }

  const result = [];
  const block = segment.length / targetBars;
  for (let index = 0; index < targetBars; index += 1) {
    const from = Math.floor(index * block);
    const to = Math.min(segment.length, Math.ceil((index + 1) * block));
    let max = 0;
    for (let i = from; i < to; i += 1) {
      max = Math.max(max, Number(segment[i]) || 0);
    }
    result.push(max);
  }

  return result;
}

async function decodeSourceWavePeaks(videoSourceUrl, targetSamples = 1024) {
  const response = await fetch(videoSourceUrl);
  if (!response.ok) {
    throw new Error(`Audio decode fetch failed: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const context = new window.AudioContext();
  try {
    const decoded = await context.decodeAudioData(arrayBuffer.slice(0));
    const channels = Math.max(1, decoded.numberOfChannels || 1);
    const length = Math.max(1, decoded.length || 1);
    const samples = Math.max(64, targetSamples);
    const blockSize = Math.max(1, Math.floor(length / samples));
    const peaks = new Array(samples).fill(0);

    for (let index = 0; index < samples; index += 1) {
      const start = index * blockSize;
      const end = Math.min(length, start + blockSize);
      let peak = 0;

      for (let channel = 0; channel < channels; channel += 1) {
        const data = decoded.getChannelData(channel);
        for (let pointer = start; pointer < end; pointer += 1) {
          const value = Math.abs(data[pointer] || 0);
          if (value > peak) {
            peak = value;
          }
        }
      }

      peaks[index] = peak;
    }

    return peaks;
  } finally {
    await context.close().catch(() => { });
  }
}

function TimelineBar({
  currentTime,
  duration,
  fps,
  isPlaying,
  videoUrl,
  videoLayers,
  activeVideoLayerId,
  videoClips,
  layers,
  activeLayerId,
  selectedClips,
  selectedVideoClipIds,
  onTogglePlay,
  onSeek,
  onStepFrame,
  onSelectClip,
  onSelectVideoLayer,
  onSelectVideoClip,
  onAddVideoLayer,
  onDeleteVideoLayer,
  onMoveSelectedVideoToActiveLayer,
  onAssignVideoClipLayer,
  onUpdateVideoClipAudio,
  onUpdateVideoClipFade,
  onMoveVideoClip,
  onTrimVideoClip,
  onSplitVideoClip,
  onMoveClip,
  onTrimClip,
  onSplitClip,
  viewportHeight,
  disabled
}) {
  const [pixelsPerSecond, setPixelsPerSecond] = useState(95);
  const [trackHeight, setTrackHeight] = useState(56);
  const [timelineTool, setTimelineTool] = useState("move");
  const [clipThumbnailsById, setClipThumbnailsById] = useState({});
  const [thumbState, setThumbState] = useState("idle");
  const [audioPeaksByUrl, setAudioPeaksByUrl] = useState({});

  const scrollRef = useRef(null);
  const contentRef = useRef(null);
  const dragRef = useRef(null);

  const durationSafe = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const frameMs = fps > 0 ? 1000 / fps : 0;

  const selectedClipKeys = useMemo(() => {
    const keys = new Set();
    for (const entry of selectedClips || []) {
      keys.add(`${entry.layerId}::${entry.strokeId}`);
    }
    return keys;
  }, [selectedClips]);

  const selectedVideoIds = useMemo(() => new Set(selectedVideoClipIds || []), [selectedVideoClipIds]);
  const videoLayerRows = useMemo(() => [...(videoLayers || [])].reverse(), [videoLayers]);
  const videoLayerClipsById = useMemo(() => {
    const byId = new Map();
    for (const clip of videoClips || []) {
      const layerId = String(clip.videoLayerId || "");
      if (!byId.has(layerId)) {
        byId.set(layerId, []);
      }
      byId.get(layerId).push(clip);
    }
    return byId;
  }, [videoClips]);
  const maxVideoEndSec = useMemo(() => {
    let maxEndMs = 0;
    for (const clip of videoClips || []) {
      maxEndMs = Math.max(maxEndMs, Number(clipTimelineEndMs(clip)) || 0);
    }
    return maxEndMs / 1000;
  }, [videoClips]);
  const maxDrawEndSec = useMemo(() => {
    let maxEndMs = 0;
    for (const layer of layers || []) {
      for (const stroke of layer.strokes || []) {
        const clipWindow = strokeClipWindowMs(stroke, fps, Number.POSITIVE_INFINITY);
        const candidateEnd = Number.isFinite(clipWindow.clipEndMs)
          ? clipWindow.clipEndMs
          : clipWindow.drawEndMs;
        maxEndMs = Math.max(maxEndMs, Number(candidateEnd) || 0);
      }
    }
    return maxEndMs / 1000;
  }, [fps, layers]);
  const timelineSpanSec = Math.max(durationSafe, maxVideoEndSec, maxDrawEndSec);
  const contentWidth = Math.max(1200, timelineSpanSec * pixelsPerSecond + 64);
  const rulerStep = niceStepSeconds(pixelsPerSecond);

  const rulerTicks = useMemo(() => {
    if (timelineSpanSec <= 0) {
      return [];
    }

    const ticks = [];
    for (let time = 0; time <= timelineSpanSec + 0.0001; time += rulerStep) {
      ticks.push(Number(time.toFixed(4)));
    }
    return ticks;
  }, [rulerStep, timelineSpanSec]);

  const selectedVideoClip = useMemo(() => {
    const selectedId = selectedVideoClipIds?.[0];
    if (!selectedId) {
      return null;
    }
    return (videoClips || []).find((clip) => clip.id === selectedId) || null;
  }, [selectedVideoClipIds, videoClips]);

  useEffect(() => {
    let cancelled = false;

    const clips = (videoClips || []).filter((clip) => clip.url);

    if (clips.length === 0) {
      setClipThumbnailsById({});
      setThumbState("idle");

      return () => {
        cancelled = true;
      };
    }

    setThumbState("loading");

    Promise.all(
      clips.map(async (clip) => {
        const timelineStartMs = Number(clip.timelineStartMs) || 0;
        const timelineEndMs = Number(clipTimelineEndMs(clip)) || timelineStartMs;
        const timelineDurationMs = Math.max(0, timelineEndMs - timelineStartMs);

        const sourceStartMs = Number(clip.sourceStartMs) || 0;
        const sourceEndMs = Number.isFinite(Number(clip.sourceEndMs))
          ? Number(clip.sourceEndMs)
          : Math.max(sourceStartMs, Number(clip.sourceDurationMs) || timelineDurationMs);

        const targetCount = Math.min(
          12,
          Math.max(2, Math.round((timelineDurationMs / 1000) / 4))
        );

        const items = await buildThumbnails({
          videoUrl: clip.url,
          sourceStartSeconds: sourceStartMs / 1000,
          sourceEndSeconds: sourceEndMs / 1000,
          timelineDurationSeconds: timelineDurationMs / 1000,
          fps: Number(clip.fps) || fps,
          targetCount
        });

        return [clip.id, items];
      })
    )
      .then((entries) => {
        if (cancelled) {
          return;
        }

        setClipThumbnailsById(Object.fromEntries(entries));
        setThumbState("ready");
      })
      .catch(() => {
        if (!cancelled) {
          setThumbState("error");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [fps, videoClips]);

  useEffect(() => {
    let cancelled = false;
    const uniqueUrls = Array.from(
      new Set((videoClips || []).map((clip) => clip.url).filter(Boolean))
    );

    if (uniqueUrls.length === 0) {
      setAudioPeaksByUrl((prev) => (Object.keys(prev).length > 0 ? {} : prev));
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      for (const sourceUrl of uniqueUrls) {
        if (cancelled || audioPeaksByUrl[sourceUrl]) {
          continue;
        }

        try {
          const peaks = await decodeSourceWavePeaks(sourceUrl, 1024);
          if (!cancelled) {
            setAudioPeaksByUrl((prev) => ({ ...prev, [sourceUrl]: peaks }));
          }
        } catch {
          if (!cancelled) {
            setAudioPeaksByUrl((prev) => ({ ...prev, [sourceUrl]: [] }));
          }
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [audioPeaksByUrl, videoClips]);

  function clientXToTimelineSeconds(clientX) {
    const content = contentRef.current;
    const scroller = scrollRef.current;

    if (!content || !scroller || timelineSpanSec <= 0) {
      return 0;
    }

    const rect = content.getBoundingClientRect();
    const relativeX = clientX - rect.left + scroller.scrollLeft;
    return clamp(relativeX / pixelsPerSecond, 0, timelineSpanSec);
  }

  function clientPointToVideoLayerId(clientX, clientY) {
    const elementAtPoint = document.elementFromPoint(clientX, clientY);
    const trackElement = elementAtPoint?.closest?.(
      ".timeline-video-track[data-layer-id], .timeline-audio-track[data-layer-id]"
    );
    if (!trackElement) {
      return null;
    }

    return trackElement.getAttribute("data-layer-id");
  }

  function renderClipThumbnails(clip) {
    const items = clipThumbnailsById[clip.id] || [];

    if (items.length === 0) {
      return null;
    }

    const timelineStartMs = Number(clip.timelineStartMs) || 0;
    const timelineEndMs = Number(clipTimelineEndMs(clip)) || timelineStartMs;
    const timelineDurationMs = Math.max(1, timelineEndMs - timelineStartMs);

    return items.map((item, index) => {
      const next = items[index + 1];
      const startOffsetMs = Number(item.offsetMs) || 0;
      const endOffsetMs = next
        ? Number(next.offsetMs) || timelineDurationMs
        : timelineDurationMs;

      const left = ((timelineStartMs + startOffsetMs) / 1000) * pixelsPerSecond;
      const width = Math.max(
        28,
        ((endOffsetMs - startOffsetMs) / 1000) * pixelsPerSecond
      );

      return (
        <div
          className="timeline-track-thumb-item"
          key={`${clip.id}-thumb-${index}`}
          style={{ left: `${left}px`, width: `${width}px` }}
        >
          <img src={item.dataUrl} alt="" aria-hidden />
        </div>
      );
    });
  }

  useEffect(() => {
    const onMove = (event) => {
      const drag = dragRef.current;
      if (!drag) {
        return;
      }

      event.preventDefault();
      const deltaMs = ((event.clientX - drag.startClientX) / drag.pixelsPerSecond) * 1000;
      const moveTarget = drag.kind === "video" ? onMoveVideoClip : onMoveClip;
      const trimTarget = drag.kind === "video" ? onTrimVideoClip : onTrimClip;

      if (drag.mode === "move") {
        const lengthMs = drag.originalEndMs - drag.originalStartMs;
        let nextStartMs = drag.originalStartMs + deltaMs;
        let nextEndMs = nextStartMs + lengthMs;

        if (nextStartMs < 0) {
          nextEndMs -= nextStartMs;
          nextStartMs = 0;
        }

        if (drag.kind === "video") {
          moveTarget?.(drag.targetId, {
            startMs: nextStartMs,
            endMs: nextEndMs
          });
        } else {
          moveTarget?.(drag.layerId, drag.targetId, {
            startMs: nextStartMs,
            endMs: nextEndMs
          });
        }
      } else if (drag.mode === "trimStart") {
        const upperBound = drag.originalEndMs - MIN_CLIP_MS;
        const nextStartMs = clamp(drag.originalStartMs + deltaMs, 0, upperBound);

        if (drag.kind === "video") {
          trimTarget?.(drag.targetId, {
            startMs: nextStartMs,
            endMs: drag.originalEndMs
          });
        } else {
          trimTarget?.(drag.layerId, drag.targetId, {
            startMs: nextStartMs,
            endMs: drag.originalEndMs
          });
        }
      } else if (drag.mode === "trimEnd") {
        const lowerBound = drag.originalStartMs + MIN_CLIP_MS;
        const nextEndMs = Math.max(lowerBound, drag.originalEndMs + deltaMs);

        if (drag.kind === "video") {
          trimTarget?.(drag.targetId, {
            startMs: drag.originalStartMs,
            endMs: nextEndMs
          });
        } else {
          trimTarget?.(drag.layerId, drag.targetId, {
            startMs: drag.originalStartMs,
            endMs: nextEndMs
          });
        }
      } else if (drag.mode === "fadeIn") {
        const clipDurationMs = Math.max(0, drag.originalEndMs - drag.originalStartMs);
        const nextFadeInDurationMs = clamp(drag.originalFadeMs + deltaMs, 0, clipDurationMs);
        onUpdateVideoClipFade?.(drag.targetId, {
          [drag.fadeInKey || "fadeInDurationMs"]: nextFadeInDurationMs
        });
      } else if (drag.mode === "fadeOut") {
        const clipDurationMs = Math.max(0, drag.originalEndMs - drag.originalStartMs);
        const nextFadeOutDurationMs = clamp(drag.originalFadeMs - deltaMs, 0, clipDurationMs);
        onUpdateVideoClipFade?.(drag.targetId, {
          [drag.fadeOutKey || "fadeOutDurationMs"]: nextFadeOutDurationMs
        });
      } else if (drag.mode === "audioGain") {
        const safeHeight = Math.max(24, Number(drag.trackHeight) || trackHeight || 56);
        const deltaDb = ((drag.startClientY - event.clientY) / safeHeight) * 48;
        onUpdateVideoClipAudio?.(drag.targetId, {
          audioGainDb: clampDb(drag.originalGainDb + deltaDb)
        });
      }
    };

    const onUp = (event) => {
      const drag = dragRef.current;
      if (drag?.kind === "video" && drag.mode === "move") {
        const targetLayerId = clientPointToVideoLayerId(event.clientX, event.clientY);
        if (targetLayerId) {
          onAssignVideoClipLayer?.(drag.targetId, targetLayerId);
        }
      }

      dragRef.current = null;
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);

    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [onAssignVideoClipLayer, onMoveClip, onMoveVideoClip, onTrimClip, onTrimVideoClip, onUpdateVideoClipAudio, onUpdateVideoClipFade, trackHeight]);

  function beginDrag(event, payload) {
    if (disabled) {
      return;
    }

    dragRef.current = {
      ...payload,
      originalStartMs: payload.windowMs.clipStartMs,
      originalEndMs: payload.windowMs.clipEndMs,
      startClientX: event.clientX,
      startClientY: event.clientY,
      trackHeight,
      pixelsPerSecond
    };
  }

  function handleTimelineSeek(event) {
    if (disabled) {
      return;
    }

    if (event.target.closest(".timeline-clip")) {
      return;
    }

    if (!event.shiftKey) {
      onSelectClip?.(null);
      onSelectVideoClip?.(null);
    }

    const nextSeconds = clientXToTimelineSeconds(event.clientX);
    onSeek?.(nextSeconds);
  }

  function clipTimelineMetrics(clip, fadeKind = "video") {
    const timelineStartMs = Number(clip.timelineStartMs) || 0;
    const timelineEndMs = Number(clipTimelineEndMs(clip)) || timelineStartMs;
    const startSec = timelineStartMs / 1000;
    const endSec = timelineEndMs / 1000;

    if (!Number.isFinite(endSec) || endSec <= 0 || startSec >= timelineSpanSec) {
      return null;
    }

    const safeStart = clamp(startSec, 0, timelineSpanSec);
    const safeEnd = clamp(endSec, 0, timelineSpanSec);
    const left = safeStart * pixelsPerSecond;
    const width = Math.max(14, (safeEnd - safeStart) * pixelsPerSecond);
    const isAudioFade = fadeKind === "audio";
    const fadeInDurationMs = isAudioFade
      ? clipAudioFadeInDurationMs(clip)
      : clipFadeInDurationMs(clip);
    const fadeOutDurationMs = isAudioFade
      ? clipAudioFadeOutDurationMs(clip)
      : clipFadeOutDurationMs(clip);
    const maxFadePx = Math.max(0, width);
    const fadeInPx = Math.max(
      0,
      Math.min(maxFadePx, (fadeInDurationMs / 1000) * pixelsPerSecond)
    );
    const fadeOutPx = Math.max(
      0,
      Math.min(maxFadePx, (fadeOutDurationMs / 1000) * pixelsPerSecond)
    );
    const maxHandleLeft = Math.max(1, width - 1);
    const handleInset = Math.min(FADE_HANDLE_EDGE_INSET_PX, Math.max(1, width / 3));
    const fadeInHandleLeft = Math.max(handleInset, fadeInPx);
    const fadeOutHandleLeft = width - Math.max(handleInset, fadeOutPx);

    return {
      timelineStartMs,
      timelineEndMs,
      left,
      width,
      fadeInDurationMs,
      fadeOutDurationMs,
      fadeInPx,
      fadeOutPx,
      fadeInKey: isAudioFade ? "audioFadeInDurationMs" : "fadeInDurationMs",
      fadeOutKey: isAudioFade ? "audioFadeOutDurationMs" : "fadeOutDurationMs",
      fadeInHandleLeft: Math.max(1, Math.min(maxHandleLeft, fadeInHandleLeft)),
      fadeOutHandleLeft: Math.max(1, Math.min(maxHandleLeft, fadeOutHandleLeft)),
      hasFadeGuide: fadeInPx > 0.5 || fadeOutPx > 0.5
    };
  }

  function beginLinkedClipDrag(event, clip, videoLayer, mode, metrics, extra = {}) {
    event.stopPropagation();
    onSelectVideoLayer?.(clip.videoLayerId || videoLayer.id);
    onSelectVideoClip?.(
      clip.id,
      { additive: event.shiftKey, toggle: event.shiftKey }
    );

    beginDrag(event, {
      kind: "video",
      mode,
      targetId: clip.id,
      windowMs: {
        clipStartMs: metrics.timelineStartMs,
        clipEndMs: metrics.timelineEndMs
      },
      ...extra
    });
  }

  function handleLinkedClipPointerDown(event, clip, videoLayer, metrics) {
    event.stopPropagation();
    onSelectVideoLayer?.(clip.videoLayerId || videoLayer.id);
    onSelectVideoClip?.(
      clip.id,
      { additive: event.shiftKey, toggle: event.shiftKey }
    );

    if (timelineTool === "cut") {
      const cutSeconds = clientXToTimelineSeconds(event.clientX);
      onSplitVideoClip?.(clip.id, cutSeconds * 1000);
      return;
    }

    beginDrag(event, {
      kind: "video",
      mode: "move",
      targetId: clip.id,
      windowMs: {
        clipStartMs: metrics.timelineStartMs,
        clipEndMs: metrics.timelineEndMs
      }
    });
  }

  function renderFadeOverlay(metrics) {
    const { width, fadeInPx, fadeOutPx, hasFadeGuide } = metrics;
    if (!hasFadeGuide) {
      return null;
    }

    const safeWidth = Math.max(1, width);

    return (
      <svg
        className="clip-fade-overlay"
        viewBox={`0 0 ${safeWidth} 100`}
        preserveAspectRatio="none"
        aria-hidden
      >
        {fadeInPx > 0.5 ? (
          <path
            className="clip-fade-line"
            d={`M 0 100 C ${fadeInPx * 0.35} 100 ${fadeInPx * 0.7} 0 ${fadeInPx} 0`}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        {fadeOutPx > 0.5 ? (
          <path
            className="clip-fade-line"
            d={`M ${safeWidth - fadeOutPx} 0 C ${safeWidth - fadeOutPx * 0.7} 0 ${safeWidth - fadeOutPx * 0.35} 100 ${safeWidth} 100`}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>
    );
  }

  function renderFadeHandles(clip, videoLayer, metrics) {
    return (
      <>
        <div
          className="clip-fade-handle fade-in"
          title="Fade in"
          style={{ left: `${metrics.fadeInHandleLeft}px` }}
          onPointerDown={(event) => {
            beginLinkedClipDrag(event, clip, videoLayer, "fadeIn", metrics, {
              fadeInKey: metrics.fadeInKey,
              originalFadeMs: metrics.fadeInDurationMs
            });
          }}
        />

        <div
          className="clip-fade-handle fade-out"
          title="Fade out"
          style={{ left: `${metrics.fadeOutHandleLeft}px` }}
          onPointerDown={(event) => {
            beginLinkedClipDrag(event, clip, videoLayer, "fadeOut", metrics, {
              fadeOutKey: metrics.fadeOutKey,
              originalFadeMs: metrics.fadeOutDurationMs
            });
          }}
        />
      </>
    );
  }

  function gainEnvelopeY(db) {
    return clamp(8 + ((18 - clampDb(db)) / 78) * 84, 8, 92);
  }

  function renderVideoClip(clip, index, videoLayer) {
    const metrics = clipTimelineMetrics(clip, "video");
    if (!metrics) {
      return null;
    }

    const isSelected = selectedVideoIds.has(clip.id);

    return (
      <div
        className={`timeline-clip timeline-video-clip ${isSelected ? "selected" : ""}`}
        key={clip.id}
        style={{ left: `${metrics.left}px`, width: `${metrics.width}px` }}
        onPointerDown={(event) => handleLinkedClipPointerDown(event, clip, videoLayer, metrics)}
      >
        <div
          className="clip-handle left"
          onPointerDown={(event) => beginLinkedClipDrag(event, clip, videoLayer, "trimStart", metrics)}
        />

        {renderFadeOverlay(metrics)}
        {renderFadeHandles(clip, videoLayer, metrics)}

        <span className="clip-title">{clip.name || `Video ${index + 1}`}</span>

        <div
          className="clip-handle right"
          onPointerDown={(event) => beginLinkedClipDrag(event, clip, videoLayer, "trimEnd", metrics)}
        />
      </div>
    );
  }

  function renderAudioClip(clip, index, videoLayer) {
    const metrics = clipTimelineMetrics(clip, "audio");
    if (!metrics) {
      return null;
    }

    const isSelected = selectedVideoIds.has(clip.id);
    const gainY = gainEnvelopeY(clip.audioGainDb);
    const gainHandleX = clamp(metrics.width / 2, 8, Math.max(8, metrics.width - 8));
    const clipWavePeaks = clipWavePeaksFromSource({
      sourcePeaks: audioPeaksByUrl[clip.url],
      sourceDurationMs: clip.sourceDurationMs,
      sourceStartMs: clip.sourceStartMs,
      sourceEndMs: clip.sourceEndMs,
      targetBars: Math.max(12, Math.min(72, Math.round(metrics.width / 6)))
    });

    const beginGainDrag = (event) => {
      beginLinkedClipDrag(event, clip, videoLayer, "audioGain", metrics, {
        originalGainDb: clampDb(clip.audioGainDb)
      });
    };

    return (
      <div
        className={`timeline-clip timeline-audio-clip ${isSelected ? "selected" : ""}`}
        key={`${clip.id}-audio`}
        style={{ left: `${metrics.left}px`, width: `${metrics.width}px` }}
        onPointerDown={(event) => handleLinkedClipPointerDown(event, clip, videoLayer, metrics)}
      >
        <div
          className="clip-handle left"
          onPointerDown={(event) => beginLinkedClipDrag(event, clip, videoLayer, "trimStart", metrics)}
        />

        {clipWavePeaks.length > 0 ? (
          <div className="video-clip-wave audio-wave" aria-hidden>
            {clipWavePeaks.map((peak, peakIndex) => (
              <span
                key={`${clip.id}-audio-peak-${peakIndex}`}
                style={{ height: `${Math.max(10, Math.round((Number(peak) || 0) * 100))}%` }}
              />
            ))}
          </div>
        ) : null}

        {renderFadeOverlay(metrics)}
        {renderFadeHandles(clip, videoLayer, metrics)}

        <svg
          className="audio-volume-envelope"
          viewBox={`0 0 ${Math.max(1, metrics.width)} 100`}
          preserveAspectRatio="none"
          aria-label="Clip volume envelope"
        >
          <line
            className="audio-volume-hitbox"
            x1="0"
            y1={gainY}
            x2={metrics.width}
            y2={gainY}
            onPointerDown={beginGainDrag}
          />
          <line
            className="audio-volume-line"
            x1="0"
            y1={gainY}
            x2={metrics.width}
            y2={gainY}
            vectorEffect="non-scaling-stroke"
          />
          <circle
            className="audio-volume-handle"
            cx={gainHandleX}
            cy={gainY}
            r="4"
            onPointerDown={beginGainDrag}
          />
        </svg>

        <button
          className={`video-clip-audio-badge ${clip.audioMuted ? "muted" : ""}`}
          title={clip.audioMuted ? "Unmute linked audio" : "Mute linked audio"}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onUpdateVideoClipAudio?.(clip.id, { audioMuted: !clip.audioMuted });
          }}
        >
          {clip.audioMuted ? "M" : "A"}
        </button>

        <span className="clip-title audio-title">{clip.name || `Audio ${index + 1}`}</span>

        <div
          className="clip-handle right"
          onPointerDown={(event) => beginLinkedClipDrag(event, clip, videoLayer, "trimEnd", metrics)}
        />
      </div>
    );
  }

  return (
    <footer className="timeline-bar">
      <div className="transport-row">
        <Button size="small" variant="outlined" onClick={() => onStepFrame(-1)} disabled={disabled}>
          Previous frame
        </Button>
        <Button size="small" variant="contained" onClick={onTogglePlay} disabled={disabled}>
          {isPlaying ? "Pause" : "Play"}
        </Button>
        <Button size="small" variant="outlined" onClick={() => onStepFrame(1)} disabled={disabled}>
          Next frame
        </Button>

        <Typography className="time-readout" variant="body2">
          {formatTime(currentTime)} / {formatTime(timelineSpanSec)}
        </Typography>

        <Typography className="time-readout" variant="body2">
          {`${fps.toFixed(2)} fps | Frame ${Math.round(currentTime * fps)} | ${frameMs.toFixed(2)} ms`}
        </Typography>

        <div className="timeline-inline-controls">
          <Stack minWidth={180}>
            <Typography variant="caption" color="text.secondary">
              Zoom
            </Typography>
            <Slider
              min={45}
              max={260}
              step={1}
              value={pixelsPerSecond}
              onChange={(_, value) => setPixelsPerSecond(Number(value))}
              disabled={disabled}
            />
          </Stack>

          <Stack minWidth={180}>
            <Typography variant="caption" color="text.secondary">
              Track height
            </Typography>
            <Slider
              min={40}
              max={120}
              step={2}
              value={trackHeight}
              onChange={(_, value) => setTrackHeight(Number(value))}
              disabled={disabled}
            />
          </Stack>

          <ToggleButtonGroup
            size="small"
            exclusive
            value={timelineTool}
            onChange={(_, value) => {
              if (value) {
                setTimelineTool(value);
              }
            }}
            disabled={disabled}
          >
            <ToggleButton value="move">Move</ToggleButton>
            <ToggleButton value="cut">Cut</ToggleButton>
          </ToggleButtonGroup>

          <Button size="small" variant="outlined" onClick={onAddVideoLayer} disabled={disabled}>
            Add video layer
          </Button>
          <Button
            size="small"
            variant="outlined"
            onClick={onDeleteVideoLayer}
            disabled={disabled || videoLayerRows.length <= 1}
          >
            Remove video layer
          </Button>
          <Button
            size="small"
            variant="outlined"
            onClick={onMoveSelectedVideoToActiveLayer}
            disabled={disabled || selectedVideoIds.size === 0}
          >
            Move selected clips
          </Button>

          {selectedVideoClip ? (
            <Stack className="video-audio-editor" direction="row" alignItems="center" gap={1.25}>
              <FormControlLabel
                label="Mute clip"
                control={(
                  <Switch
                  checked={Boolean(selectedVideoClip.audioMuted)}
                  onChange={(event) =>
                    onUpdateVideoClipAudio?.(selectedVideoClip.id, {
                      audioMuted: event.target.checked
                    })
                  }
                  disabled={disabled}
                  />
                )}
              />

              <Stack minWidth={170}>
                <Typography variant="caption" color="text.secondary">
                  Clip gain (dB)
                </Typography>
                <Slider
                  min={-60}
                  max={18}
                  step={1}
                  value={clampDb(selectedVideoClip.audioGainDb)}
                  onChange={(_, value) =>
                    onUpdateVideoClipAudio?.(selectedVideoClip.id, {
                      audioGainDb: Number(value)
                    })
                  }
                  disabled={disabled}
                />
                <Typography variant="caption">{clampDb(selectedVideoClip.audioGainDb).toFixed(0)} dB</Typography>
              </Stack>
            </Stack>
          ) : null}
        </div>
      </div>

      <div className="timeline-editor-grid">
        <div className="timeline-label-column">
          <div className="timeline-label timeline-label-header">Layers</div>
          {videoLayerRows.map((videoLayer) => (
            <Fragment key={`linked-labels-${videoLayer.id}`}>
              <button
                type="button"
                className={`timeline-label timeline-label-video ${videoLayer.id === activeVideoLayerId ? "active-video-layer" : ""}`}
                style={{ height: `${trackHeight}px` }}
                onClick={() => onSelectVideoLayer?.(videoLayer.id)}
                disabled={disabled}
              >
                {videoLayer.name}
              </button>
              <button
                type="button"
                className={`timeline-label timeline-label-audio ${videoLayer.id === activeVideoLayerId ? "active-video-layer" : ""}`}
                style={{ height: `${trackHeight}px` }}
                onClick={() => onSelectVideoLayer?.(videoLayer.id)}
                disabled={disabled}
              >
                Audio linked
              </button>
            </Fragment>
          ))}
          {layers.map((layer) => (
            <div
              className={`timeline-label ${layer.id === activeLayerId ? "active" : ""}`}
              key={`label-${layer.id}`}
              style={{ height: `${trackHeight}px` }}
            >
              {layer.name}
            </div>
          ))}
        </div>

        <div
          className="timeline-scroll"
          ref={scrollRef}
          onPointerDown={handleTimelineSeek}
          style={{ maxHeight: `${Math.max(140, Number(viewportHeight) || 260)}px` }}
        >
          <div className="timeline-content" ref={contentRef} style={{ width: `${contentWidth}px` }}>
            <div className="timeline-ruler">
              {rulerTicks.map((time) => (
                <div
                  className="timeline-ruler-tick"
                  key={`tick-${time}`}
                  style={{ left: `${time * pixelsPerSecond}px` }}
                >
                  <span>{formatTime(time)}</span>
                </div>
              ))}
            </div>

            {thumbState === "loading" ? <div className="thumb-status timeline-thumb-floating">Generating preview thumbnails...</div> : null}
            {thumbState === "error" ? <div className="thumb-status timeline-thumb-floating">Could not generate thumbnails for this file.</div> : null}

            {videoLayerRows.map((videoLayer) => {
              const linkedClips = videoLayerClipsById.get(videoLayer.id) || [];

              return (
                <Fragment key={`linked-tracks-${videoLayer.id}`}>
                  <div
                    className={`timeline-track timeline-track-with-thumbs timeline-video-track ${videoLayer.id === activeVideoLayerId ? "active-video-layer-track" : ""}`}
                    data-layer-id={videoLayer.id}
                    style={{ height: `${trackHeight}px` }}
                  >
                    {linkedClips.map((clip) => renderClipThumbnails(clip))}
                    {linkedClips.map((clip, index) => renderVideoClip(clip, index, videoLayer))}
                  </div>

                  <div
                    className={`timeline-track timeline-audio-track ${videoLayer.id === activeVideoLayerId ? "active-video-layer-track" : ""}`}
                    data-layer-id={videoLayer.id}
                    style={{ height: `${trackHeight}px` }}
                  >
                    {linkedClips.map((clip, index) => renderAudioClip(clip, index, videoLayer))}
                  </div>
                </Fragment>
              );
            })}

            {layers.map((layer) => (
              <div className="timeline-track timeline-track-with-thumbs" key={`track-${layer.id}`} style={{ height: `${trackHeight}px` }}>
                {(layer.strokes || []).map((stroke, index) => {
                  const windowMs = strokeClipWindowMs(stroke, fps, Number.POSITIVE_INFINITY);
                  const clipStartSec = windowMs.clipStartMs / 1000;
                  const clipEndSec = (Number.isFinite(windowMs.clipEndMs)
                    ? windowMs.clipEndMs
                    : timelineSpanSec * 1000) / 1000;

                  if (!Number.isFinite(clipEndSec) || clipEndSec <= 0 || clipStartSec >= timelineSpanSec) {
                    return null;
                  }

                  const safeStart = clamp(clipStartSec, 0, timelineSpanSec);
                  const safeEnd = clamp(clipEndSec, 0, timelineSpanSec);
                  const left = safeStart * pixelsPerSecond;
                  const width = Math.max(12, (safeEnd - safeStart) * pixelsPerSecond);
                  const isSelected = selectedClipKeys.has(`${layer.id}::${stroke.id}`);

                  return (
                    <div
                      className={`timeline-clip ${isSelected ? "selected" : ""}`}
                      key={stroke.id}
                      style={{
                        left: `${left}px`,
                        width: `${width}px`,
                        borderColor: stroke.color || "#f8af52"
                      }}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                        onSelectClip?.(
                          { layerId: layer.id, strokeId: stroke.id },
                          { additive: event.shiftKey, toggle: event.shiftKey }
                        );

                        if (timelineTool === "cut") {
                          const cutSeconds = clientXToTimelineSeconds(event.clientX);
                          onSplitClip?.(layer.id, stroke.id, cutSeconds * 1000);
                          return;
                        }

                        beginDrag(event, {
                          kind: "annotation",
                          mode: "move",
                          layerId: layer.id,
                          targetId: stroke.id,
                          windowMs
                        });
                      }}
                    >
                      <div
                        className="clip-handle left"
                        onPointerDown={(event) => {
                          event.stopPropagation();
                          onSelectClip?.(
                            { layerId: layer.id, strokeId: stroke.id },
                            { additive: event.shiftKey, toggle: event.shiftKey }
                          );
                          beginDrag(event, {
                            kind: "annotation",
                            mode: "trimStart",
                            layerId: layer.id,
                            targetId: stroke.id,
                            windowMs
                          });
                        }}
                      />

                      <span className="clip-title">{index + 1}</span>

                      <div
                        className="clip-handle right"
                        onPointerDown={(event) => {
                          event.stopPropagation();
                          onSelectClip?.(
                            { layerId: layer.id, strokeId: stroke.id },
                            { additive: event.shiftKey, toggle: event.shiftKey }
                          );
                          beginDrag(event, {
                            kind: "annotation",
                            mode: "trimEnd",
                            layerId: layer.id,
                            targetId: stroke.id,
                            windowMs
                          });
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            ))}

            <div className="timeline-playhead" style={{ left: `${currentTime * pixelsPerSecond}px` }} />
          </div>
        </div>
      </div>

      <input
        className="timeline-slider"
        type="range"
        min={0}
        max={Math.max(timelineSpanSec, 0.001)}
        step={1 / Math.max(fps || 30, 1)}
        value={Math.min(currentTime, timelineSpanSec || 0)}
        onChange={(event) => onSeek(Number(event.target.value))}
        disabled={disabled}
      />
    </footer>
  );
}

export default TimelineBar;
