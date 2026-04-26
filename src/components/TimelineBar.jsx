import { useEffect, useMemo, useRef, useState } from "react";
import { formatTime } from "../utils/time";
import { strokeClipWindowMs } from "../utils/strokeClip";
import { clipTimelineEndMs } from "../utils/videoClipOps";

const MIN_CLIP_MS = 80;

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

async function buildThumbnails({ videoUrl, durationSeconds, fps, targetCount }) {
  const video = document.createElement("video");
  video.src = videoUrl;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";

  if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
    await waitForEvent(video, "loadedmetadata");
  }

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

  const times = Array.from({ length: targetCount + 1 }, (_, index) => {
    return (durationSeconds * index) / targetCount;
  });

  const thumbnails = [];

  for (const rawTime of times) {
    const maxTime = Math.max(0, durationSeconds - 1 / Math.max(fps || 30, 1));
    const seekTime = clamp(rawTime, 0, maxTime);

    if (Math.abs((video.currentTime || 0) - seekTime) > 0.001) {
      video.currentTime = seekTime;
      await waitForEvent(video, "seeked");
    }

    ctx.drawImage(video, 0, 0, thumbWidth, thumbHeight);
    thumbnails.push({
      time: seekTime,
      dataUrl: canvas.toDataURL("image/jpeg", 0.62)
    });
  }

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
    await context.close().catch(() => {});
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
  const [thumbnails, setThumbnails] = useState([]);
  const [thumbState, setThumbState] = useState("idle");
  const [audioPeaksByUrl, setAudioPeaksByUrl] = useState({});

  const scrollRef = useRef(null);
  const contentRef = useRef(null);
  const dragRef = useRef(null);

  const durationSafe = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const durationMs = durationSafe * 1000;
  const frameMs = fps > 0 ? 1000 / fps : 0;

  const contentWidth = Math.max(1200, durationSafe * pixelsPerSecond + 64);
  const rulerStep = niceStepSeconds(pixelsPerSecond);

  const rulerTicks = useMemo(() => {
    if (durationSafe <= 0) {
      return [];
    }

    const ticks = [];
    for (let time = 0; time <= durationSafe + 0.0001; time += rulerStep) {
      ticks.push(Number(time.toFixed(4)));
    }
    return ticks;
  }, [durationSafe, rulerStep]);

  const selectedClipKeys = useMemo(() => {
    const keys = new Set();
    for (const entry of selectedClips || []) {
      keys.add(`${entry.layerId}::${entry.strokeId}`);
    }
    return keys;
  }, [selectedClips]);

  const selectedVideoIds = useMemo(() => new Set(selectedVideoClipIds || []), [selectedVideoClipIds]);
  const videoLayerRows = useMemo(() => [...(videoLayers || [])].reverse(), [videoLayers]);

  const selectedVideoClip = useMemo(() => {
    const selectedId = selectedVideoClipIds?.[0];
    if (!selectedId) {
      return null;
    }
    return (videoClips || []).find((clip) => clip.id === selectedId) || null;
  }, [selectedVideoClipIds, videoClips]);

  useEffect(() => {
    let cancelled = false;

    if (!videoUrl || durationSafe <= 0) {
      setThumbnails([]);
      setThumbState("idle");
      return () => {
        cancelled = true;
      };
    }

    const targetCount = Math.min(32, Math.max(8, Math.round(durationSafe / 5)));
    setThumbState("loading");

    buildThumbnails({
      videoUrl,
      durationSeconds: durationSafe,
      fps,
      targetCount
    })
      .then((items) => {
        if (!cancelled) {
          setThumbnails(items);
          setThumbState("ready");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setThumbState("error");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [durationSafe, fps, videoUrl]);

  useEffect(() => {
    let cancelled = false;
    const uniqueUrls = Array.from(
      new Set((videoClips || []).map((clip) => clip.url).filter(Boolean))
    );

    if (uniqueUrls.length === 0) {
      setAudioPeaksByUrl({});
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

    if (!content || !scroller || durationSafe <= 0) {
      return 0;
    }

    const rect = content.getBoundingClientRect();
    const relativeX = clientX - rect.left + scroller.scrollLeft;
    return clamp(relativeX / pixelsPerSecond, 0, durationSafe);
  }

  function clientPointToVideoLayerId(clientX, clientY) {
    const elementAtPoint = document.elementFromPoint(clientX, clientY);
    const trackElement = elementAtPoint?.closest?.(".timeline-video-track[data-layer-id]");
    if (!trackElement) {
      return null;
    }

    return trackElement.getAttribute("data-layer-id");
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

        if (durationMs > 0 && nextEndMs > durationMs) {
          const overflow = nextEndMs - durationMs;
          nextStartMs -= overflow;
          nextEndMs = durationMs;
          if (nextStartMs < 0) {
            nextStartMs = 0;
          }
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
        const nextEndMs = clamp(
          drag.originalEndMs + deltaMs,
          lowerBound,
          durationMs > 0 ? durationMs : Number.POSITIVE_INFINITY
        );

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
  }, [durationMs, onAssignVideoClipLayer, onMoveClip, onMoveVideoClip, onTrimClip, onTrimVideoClip]);

  function beginDrag(event, payload) {
    if (disabled) {
      return;
    }

    dragRef.current = {
      ...payload,
      originalStartMs: payload.windowMs.clipStartMs,
      originalEndMs: payload.windowMs.clipEndMs,
      startClientX: event.clientX,
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

  return (
    <footer className="timeline-bar">
      <div className="transport-row">
        <button onClick={() => onStepFrame(-1)} disabled={disabled}>
          -1 frame
        </button>
        <button onClick={onTogglePlay} disabled={disabled}>
          {isPlaying ? "Pause" : "Play"}
        </button>
        <button onClick={() => onStepFrame(1)} disabled={disabled}>
          +1 frame
        </button>

        <span className="time-readout">
          {formatTime(currentTime)} / {formatTime(durationSafe)}
        </span>

        <span className="time-readout">
          FPS: {fps.toFixed(2)} | Frame: {Math.round(currentTime * fps)} | {frameMs.toFixed(2)} ms/frame
        </span>

        <div className="timeline-inline-controls">
          <label>
            Zoom
            <input
              type="range"
              min={45}
              max={260}
              step={1}
              value={pixelsPerSecond}
              onChange={(event) => setPixelsPerSecond(Number(event.target.value))}
              disabled={disabled}
            />
          </label>

          <label>
            Track H
            <input
              type="range"
              min={40}
              max={120}
              step={2}
              value={trackHeight}
              onChange={(event) => setTrackHeight(Number(event.target.value))}
              disabled={disabled}
            />
          </label>

          <button
            className={timelineTool === "move" ? "active" : ""}
            onClick={() => setTimelineTool("move")}
            disabled={disabled}
          >
            Move
          </button>
          <button
            className={timelineTool === "cut" ? "active" : ""}
            onClick={() => setTimelineTool("cut")}
            disabled={disabled}
          >
            Cut
          </button>

          <button onClick={onAddVideoLayer} disabled={disabled}>
            + Video Layer
          </button>
          <button
            onClick={onDeleteVideoLayer}
            disabled={disabled || videoLayerRows.length <= 1}
          >
            - Video Layer
          </button>
          <button
            onClick={onMoveSelectedVideoToActiveLayer}
            disabled={disabled || selectedVideoIds.size === 0}
          >
            Move Sel Video
          </button>

          {selectedVideoClip ? (
            <div className="video-audio-editor">
              <label>
                <input
                  type="checkbox"
                  checked={Boolean(selectedVideoClip.audioMuted)}
                  onChange={(event) =>
                    onUpdateVideoClipAudio?.(selectedVideoClip.id, {
                      audioMuted: event.target.checked
                    })
                  }
                  disabled={disabled}
                />
                Mute
              </label>

              <label>
                dB
                <input
                  type="range"
                  min={-60}
                  max={18}
                  step={1}
                  value={clampDb(selectedVideoClip.audioGainDb)}
                  onChange={(event) =>
                    onUpdateVideoClipAudio?.(selectedVideoClip.id, {
                      audioGainDb: Number(event.target.value)
                    })
                  }
                  disabled={disabled}
                />
                <span>{clampDb(selectedVideoClip.audioGainDb).toFixed(0)} dB</span>
              </label>
            </div>
          ) : null}
        </div>
      </div>

      <div className="timeline-editor-grid">
        <div className="timeline-label-column">
          <div className="timeline-label timeline-label-header">Preview</div>
          {videoLayerRows.map((videoLayer) => (
            <button
              type="button"
              className={`timeline-label timeline-label-video ${videoLayer.id === activeVideoLayerId ? "active-video-layer" : ""}`}
              key={`video-label-${videoLayer.id}`}
              style={{ height: `${trackHeight}px` }}
              onClick={() => onSelectVideoLayer?.(videoLayer.id)}
              disabled={disabled}
            >
              {videoLayer.name}
            </button>
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

            <div className="timeline-track timeline-thumb-track" style={{ height: `${trackHeight}px` }}>
              {thumbnails.map((item, index) => {
                const next = thumbnails[index + 1];
                const startX = item.time * pixelsPerSecond;
                const endX = (next ? next.time : durationSafe) * pixelsPerSecond;
                const width = Math.max(28, endX - startX);

                return (
                  <div
                    className="timeline-thumb-item"
                    key={`thumb-${index}-${item.time}`}
                    style={{ left: `${startX}px`, width: `${width}px` }}
                  >
                    <img src={item.dataUrl} alt={`Thumbnail ${index + 1}`} />
                  </div>
                );
              })}

              {thumbState === "loading" ? <div className="thumb-status">Generating preview thumbnails...</div> : null}
              {thumbState === "error" ? <div className="thumb-status">Could not generate thumbnails for this file.</div> : null}
            </div>

            {videoLayerRows.map((videoLayer) => (
              <div
                className={`timeline-track timeline-video-track ${videoLayer.id === activeVideoLayerId ? "active-video-layer-track" : ""}`}
                key={`video-track-${videoLayer.id}`}
                data-layer-id={videoLayer.id}
                style={{ height: `${trackHeight}px` }}
              >
                {(videoClips || [])
                  .filter((clip) => (clip.videoLayerId || "") === videoLayer.id)
                  .map((clip, index) => {
                    const startSec = (Number(clip.timelineStartMs) || 0) / 1000;
                    const endSec = (Number(clipTimelineEndMs(clip)) || 0) / 1000;

                    if (!Number.isFinite(endSec) || endSec <= 0 || startSec >= durationSafe) {
                      return null;
                    }

                    const safeStart = clamp(startSec, 0, durationSafe);
                    const safeEnd = clamp(endSec, 0, durationSafe);
                    const left = safeStart * pixelsPerSecond;
                    const width = Math.max(14, (safeEnd - safeStart) * pixelsPerSecond);
                    const isSelected = selectedVideoIds.has(clip.id);
                    const clipWavePeaks = clipWavePeaksFromSource({
                      sourcePeaks: audioPeaksByUrl[clip.url],
                      sourceDurationMs: clip.sourceDurationMs,
                      sourceStartMs: clip.sourceStartMs,
                      sourceEndMs: clip.sourceEndMs,
                      targetBars: Math.max(12, Math.min(56, Math.round(width / 6)))
                    });

                    return (
                      <div
                        className={`timeline-clip timeline-video-clip ${isSelected ? "selected" : ""}`}
                        key={clip.id}
                        style={{ left: `${left}px`, width: `${width}px` }}
                        onPointerDown={(event) => {
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
                              clipStartMs: Number(clip.timelineStartMs) || 0,
                              clipEndMs: Number(clipTimelineEndMs(clip)) || 0
                            }
                          });
                        }}
                      >
                        <div
                          className="clip-handle left"
                          onPointerDown={(event) => {
                            event.stopPropagation();
                            onSelectVideoLayer?.(clip.videoLayerId || videoLayer.id);
                            onSelectVideoClip?.(
                              clip.id,
                              { additive: event.shiftKey, toggle: event.shiftKey }
                            );
                            beginDrag(event, {
                              kind: "video",
                              mode: "trimStart",
                              targetId: clip.id,
                              windowMs: {
                                clipStartMs: Number(clip.timelineStartMs) || 0,
                                clipEndMs: Number(clipTimelineEndMs(clip)) || 0
                              }
                            });
                          }}
                        />

                        {clipWavePeaks.length > 0 ? (
                          <div className="video-clip-wave" aria-hidden>
                            {clipWavePeaks.map((peak, peakIndex) => (
                              <span
                                key={`${clip.id}-peak-${peakIndex}`}
                                style={{ height: `${Math.max(12, Math.round((Number(peak) || 0) * 100))}%` }}
                              />
                            ))}
                          </div>
                        ) : null}

                        <button
                          className={`video-clip-audio-badge ${clip.audioMuted ? "muted" : ""}`}
                          title={clip.audioMuted ? "Unmute clip" : "Mute clip"}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation();
                            onUpdateVideoClipAudio?.(clip.id, { audioMuted: !clip.audioMuted });
                          }}
                        >
                          {clip.audioMuted ? "M" : "A"}
                        </button>

                        <span className="clip-title">{clip.name || `Video ${index + 1}`}</span>

                        <div
                          className="clip-handle right"
                          onPointerDown={(event) => {
                            event.stopPropagation();
                            onSelectVideoLayer?.(clip.videoLayerId || videoLayer.id);
                            onSelectVideoClip?.(
                              clip.id,
                              { additive: event.shiftKey, toggle: event.shiftKey }
                            );
                            beginDrag(event, {
                              kind: "video",
                              mode: "trimEnd",
                              targetId: clip.id,
                              windowMs: {
                                clipStartMs: Number(clip.timelineStartMs) || 0,
                                clipEndMs: Number(clipTimelineEndMs(clip)) || 0
                              }
                            });
                          }}
                        />
                      </div>
                    );
                  })}
              </div>
            ))}

            {layers.map((layer) => (
              <div className="timeline-track" key={`track-${layer.id}`} style={{ height: `${trackHeight}px` }}>
                {(layer.strokes || []).map((stroke, index) => {
                  const windowMs = strokeClipWindowMs(stroke, fps, durationMs || Number.POSITIVE_INFINITY);
                  const clipStartSec = windowMs.clipStartMs / 1000;
                  const clipEndSec = (Number.isFinite(windowMs.clipEndMs) ? windowMs.clipEndMs : durationMs) / 1000;

                  if (!Number.isFinite(clipEndSec) || clipEndSec <= 0 || clipStartSec >= durationSafe) {
                    return null;
                  }

                  const safeStart = clamp(clipStartSec, 0, durationSafe);
                  const safeEnd = clamp(clipEndSec, 0, durationSafe);
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
        max={Math.max(durationSafe, 0.001)}
        step={1 / Math.max(fps || 30, 1)}
        value={Math.min(currentTime, durationSafe || 0)}
        onChange={(event) => onSeek(Number(event.target.value))}
        disabled={disabled}
      />
    </footer>
  );
}

export default TimelineBar;
