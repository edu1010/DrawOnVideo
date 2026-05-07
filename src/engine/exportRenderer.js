import { createRenderState, renderAnnotationOverlay } from "./rendering";
import {
  clipOpacityAtTimelineMs,
  findVideoClipAtTime,
  resolveSameLayerBlend,
  sortVideoClips,
  totalTimelineDurationMs
} from "../utils/videoClipOps";

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

function pickRecorderMimeType() {
  const options = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm"
  ];

  return options.find((item) => MediaRecorder.isTypeSupported(item)) || "video/webm";
}

function drawVideoContain(ctx, video, width, height) {
  const sourceWidth = Number(video.videoWidth) || width;
  const sourceHeight = Number(video.videoHeight) || height;
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  const left = (width - drawWidth) / 2;
  const top = (height - drawHeight) / 2;

  ctx.drawImage(video, left, top, drawWidth, drawHeight);
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
  const localMs = localRange.startMs + (Math.max(0, Number(globalMs) || 0) - timelineStartMs);
  return Math.min(localRange.endMs, Math.max(localRange.startMs, localMs));
}

export async function renderAndRecordAnnotatedVideo({
  videoUrl,
  videoClips,
  videoLayers = [],
  layers,
  videoMeta,
  onionSkin = false,
  outputFps,
  onProgress,
  recordingBitrate = 14_000_000
}) {
  const createExportVideo = () => {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    return video;
  };
  const exportVideo = createExportVideo();
  const blendVideo = createExportVideo();
  const width = Math.max(1, Number(videoMeta?.width) || 1280);
  const height = Math.max(1, Number(videoMeta?.height) || 720);
  const fps = Number(outputFps) > 0
    ? Number(outputFps)
    : (Number(videoMeta?.fps) > 0 ? Number(videoMeta.fps) : 30);

  const timelineClips = Array.isArray(videoClips) && videoClips.length > 0
    ? sortVideoClips(videoClips)
    : [{
      id: "single",
      url: videoUrl,
      timelineStartMs: 0,
      sourceStartMs: 0,
      sourceEndMs: Number(videoMeta?.duration) > 0 ? Number(videoMeta.duration) * 1000 : Number.POSITIVE_INFINITY
    }];

  const durationMs = Number(videoMeta?.duration) > 0
    ? Math.max(Number(videoMeta.duration) * 1000, totalTimelineDurationMs(timelineClips))
    : totalTimelineDurationMs(timelineClips);
  const durationSeconds = Math.max(0.001, durationMs / 1000);
  const layerOrderIds = (videoLayers || []).map((layer) => layer.id);

  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = width;
  exportCanvas.height = height;
  const exportCtx = exportCanvas.getContext("2d", { alpha: false });
  const overlayCanvas = document.createElement("canvas");
  overlayCanvas.width = width;
  overlayCanvas.height = height;
  const overlayCtx = overlayCanvas.getContext("2d", { alpha: true });

  if (!exportCtx || !overlayCtx) {
    throw new Error("Failed to create export canvas contexts.");
  }

  const stream = exportCanvas.captureStream(fps);
  const mimeType = pickRecorderMimeType();
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: Number.isFinite(Number(recordingBitrate))
      ? Number(recordingBitrate)
      : 14_000_000
  });

  const chunks = [];

  const stopPromise = new Promise((resolve, reject) => {
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    recorder.onerror = (event) => {
      reject(event.error || new Error("Failed during recording."));
    };

    recorder.onstop = () => resolve();
  });

  const renderState = createRenderState();
  const loadedUrls = new WeakMap();
  const frameStepMs = 1000 / Math.max(fps, 1);

  const waitNextFrame = () =>
    new Promise((resolve) => {
      window.setTimeout(resolve, frameStepMs);
    });

  const loadVideoSource = async (video, sourceUrl) => {
    if (!sourceUrl) {
      throw new Error("Missing clip video URL for export.");
    }

    if (loadedUrls.get(video) !== sourceUrl) {
      video.src = sourceUrl;
      loadedUrls.set(video, sourceUrl);
      await waitForEvent(video, "loadedmetadata");
    }
  };

  const seekVideoFrame = async (video, targetSeconds) => {
    const safeSeconds = Math.max(0, Number(targetSeconds) || 0);
    if (Math.abs((Number(video.currentTime) || 0) - safeSeconds) <= 0.001) {
      return;
    }

    video.currentTime = safeSeconds;
    await waitForEvent(video, "seeked");
  };

  const drawClipFrame = async (video, clip, globalMs, alpha = 1) => {
    await loadVideoSource(video, clip.url || videoUrl);
    const localMs = clipLocalMsAtTimelineMs(
      clip,
      globalMs,
      Number.isFinite(Number(video.duration)) ? Number(video.duration) * 1000 : 0
    );
    await seekVideoFrame(video, localMs / 1000);

    exportCtx.save();
    exportCtx.globalAlpha = Math.min(1, Math.max(0, Number(alpha)));
    drawVideoContain(exportCtx, video, width, height);
    exportCtx.restore();
  };

  recorder.start(250);

  const drawCompositeFrame = async (globalMs) => {
    exportCtx.fillStyle = "#000000";
    exportCtx.fillRect(0, 0, width, height);

    const activeClip = findVideoClipAtTime(timelineClips, globalMs, { layerOrderIds });
    if (activeClip) {
      const blendState = resolveSameLayerBlend(timelineClips, activeClip, globalMs);
      const activeOpacity = blendState
        ? Math.max(0, Math.min(1, Number(blendState.activeOpacity)))
        : clipOpacityAtTimelineMs(activeClip, globalMs);
      const outgoingClip = blendState?.outgoingClip || null;
      const outgoingOpacity = blendState
        ? Math.max(0, Math.min(1, Number(blendState.outgoingOpacity)))
        : 0;

      if (outgoingClip && outgoingOpacity > 0.0001) {
        await drawClipFrame(blendVideo, outgoingClip, globalMs, outgoingOpacity);
      }
      if (activeOpacity > 0.0001) {
        await drawClipFrame(exportVideo, activeClip, globalMs, activeOpacity);
      }
    }

    renderAnnotationOverlay({
      targetCtx: overlayCtx,
      width,
      height,
      layers,
      timeSeconds: Math.max(0, globalMs / 1000),
      fps,
      renderState,
      activeStroke: null,
      onionSkin
    });
    exportCtx.drawImage(overlayCanvas, 0, 0, width, height);

    const progress = Math.max(0, Math.min(0.98, (globalMs / 1000) / durationSeconds));
    onProgress?.(progress);
  };

  for (let cursorMs = 0; cursorMs < durationMs - 0.0001; cursorMs += frameStepMs) {
    await drawCompositeFrame(cursorMs);
    await waitNextFrame();
  }

  onProgress?.(1);
  recorder.stop();
  await stopPromise;

  const blob = new Blob(chunks, { type: mimeType });
  const buffer = await blob.arrayBuffer();

  return new Uint8Array(buffer);
}
