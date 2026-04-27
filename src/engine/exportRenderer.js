import { createRenderState, renderAnnotationOverlay } from "./rendering";
import { clipTimelineEndMs, sortVideoClips, totalTimelineDurationMs } from "../utils/videoClipOps";

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

export async function renderAndRecordAnnotatedVideo({
  videoUrl,
  videoClips,
  layers,
  videoMeta,
  onionSkin = false,
  outputFps,
  onProgress,
  recordingBitrate = 14_000_000
}) {
  const exportVideo = document.createElement("video");
  exportVideo.crossOrigin = "anonymous";
  exportVideo.muted = true;
  exportVideo.playsInline = true;
  exportVideo.preload = "auto";
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
  let currentLoadedUrl = "";

  const loadVideoSource = async (sourceUrl) => {
    if (!sourceUrl) {
      throw new Error("Missing clip video URL for export.");
    }

    if (currentLoadedUrl !== sourceUrl) {
      exportVideo.src = sourceUrl;
      currentLoadedUrl = sourceUrl;
      await waitForEvent(exportVideo, "loadedmetadata");
    }
  };

  const waitNextFrame = () =>
    new Promise((resolve) => {
      window.setTimeout(resolve, frameStepMs);
    });

  recorder.start(250);
  const frameToleranceSeconds = 1 / Math.max(fps, 1);
  const frameStepMs = 1000 / Math.max(fps, 1);

  const drawCompositeFrame = (globalMs, drawVideo) => {
    exportCtx.fillStyle = "#000000";
    exportCtx.fillRect(0, 0, width, height);

    if (drawVideo) {
      drawVideoContain(exportCtx, exportVideo, width, height);
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

  const renderBlackSegment = async (fromMs, toMs) => {
    if (toMs <= fromMs) {
      return toMs;
    }

    let cursorMs = Math.max(0, fromMs);
    while (cursorMs < toMs - 0.0001) {
      drawCompositeFrame(cursorMs, false);
      cursorMs += frameStepMs;
      await waitNextFrame();
    }

    return toMs;
  };

  let timelineCursorMs = 0;

  for (const clip of timelineClips) {
    await loadVideoSource(clip.url || videoUrl);

    const clipTimelineStartMs = Math.max(0, Number(clip.timelineStartMs) || 0);
    const clipTimelineEndMsValue = Math.max(clipTimelineStartMs, Number(clipTimelineEndMs(clip)) || clipTimelineStartMs);

    if (clipTimelineStartMs > timelineCursorMs) {
      timelineCursorMs = await renderBlackSegment(timelineCursorMs, Math.min(clipTimelineStartMs, durationMs));
    }
    if (timelineCursorMs >= durationMs || clipTimelineEndMsValue <= timelineCursorMs) {
      continue;
    }

    const clipStartMs = Number(clip.sourceStartMs) || 0;
    let clipEndMs = Number(clip.sourceEndMs);
    if (!Number.isFinite(clipEndMs)) {
      const fallbackDurationMs = Number.isFinite(Number(exportVideo.duration))
        ? Number(exportVideo.duration) * 1000
        : clipStartMs;
      clipEndMs = Math.max(clipStartMs, fallbackDurationMs);
    }
    clipEndMs = Math.max(clipStartMs, clipEndMs);
    const sourceSpanMs = Math.max(0, clipEndMs - clipStartMs);
    const movingTimelineEndMs = Math.min(clipTimelineEndMsValue, clipTimelineStartMs + sourceSpanMs, durationMs);
    const startSec = clipStartMs / 1000;

    if (movingTimelineEndMs > timelineCursorMs + 0.0001) {
      if (Math.abs((exportVideo.currentTime || 0) - startSec) > 0.001) {
        exportVideo.currentTime = startSec;
        await waitForEvent(exportVideo, "seeked");
      }

      await exportVideo.play();

      while (!exportVideo.paused) {
        const localMs = (exportVideo.currentTime || 0) * 1000;
        const globalMs = clipTimelineStartMs + (localMs - clipStartMs);
        const clampedGlobalMs = Math.max(timelineCursorMs, Math.min(globalMs, movingTimelineEndMs));

        drawCompositeFrame(clampedGlobalMs, true);

        timelineCursorMs = Math.max(timelineCursorMs, clampedGlobalMs);
        if (timelineCursorMs >= movingTimelineEndMs - frameStepMs * 0.25) {
          break;
        }

        if (exportVideo.ended || exportVideo.currentTime >= (clipEndMs / 1000) - frameToleranceSeconds) {
          break;
        }

        await waitNextFrame();
      }
    }
    exportVideo.pause();
    timelineCursorMs = Math.max(timelineCursorMs, movingTimelineEndMs);

    const clipRemainderEndMs = Math.min(clipTimelineEndMsValue, durationMs);
    if (clipRemainderEndMs > timelineCursorMs + 0.0001) {
      timelineCursorMs = await renderBlackSegment(timelineCursorMs, clipRemainderEndMs);
    }

    timelineCursorMs = Math.max(timelineCursorMs, clipTimelineEndMsValue);
  }

  if (timelineCursorMs < durationMs) {
    await renderBlackSegment(timelineCursorMs, durationMs);
  }

  onProgress?.(1);
  recorder.stop();
  await stopPromise;

  const blob = new Blob(chunks, { type: mimeType });
  const buffer = await blob.arrayBuffer();

  return new Uint8Array(buffer);
}
