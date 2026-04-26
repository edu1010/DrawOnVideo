import { createId } from "./id";

function frameToTimeMs(frame, fps = 30) {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const safeFrame = Number.isFinite(Number(frame)) ? Number(frame) : 0;
  return Math.max(0, (safeFrame * 1000) / safeFps);
}

function timeMsToFrame(timeMs, fps = 30) {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const safeMs = Number.isFinite(Number(timeMs)) ? Number(timeMs) : 0;
  return Math.max(0, Math.round((safeMs / 1000) * safeFps));
}

export function strokeDrawStartMs(stroke, fps = 30) {
  const firstPoint = stroke?.points?.[0];
  const pointTime = Number(firstPoint?.timeMs);
  if (Number.isFinite(pointTime)) {
    return Math.max(0, pointTime);
  }

  return frameToTimeMs(stroke?.startFrame, fps);
}

export function strokeDrawEndMs(stroke, fps = 30) {
  const points = stroke?.points || [];
  const lastPoint = points[points.length - 1];
  const pointTime = Number(lastPoint?.timeMs);
  if (Number.isFinite(pointTime)) {
    return Math.max(0, pointTime);
  }

  return frameToTimeMs(stroke?.endFrame ?? stroke?.startFrame, fps);
}

export function strokeClipWindowMs(stroke, fps = 30, durationMs = Number.POSITIVE_INFINITY) {
  const drawStart = strokeDrawStartMs(stroke, fps);
  const drawEnd = Math.max(drawStart, strokeDrawEndMs(stroke, fps));

  const rawClipStart = Number(stroke?.clipStartMs);
  const rawClipEnd = Number(stroke?.clipEndMs);

  const clipStart = Number.isFinite(rawClipStart) ? Math.max(0, rawClipStart) : drawStart;

  let clipEnd;
  if (Number.isFinite(rawClipEnd)) {
    clipEnd = Math.max(clipStart, rawClipEnd);
  } else {
    clipEnd = Number.isFinite(durationMs) ? Math.max(clipStart, durationMs) : Number.POSITIVE_INFINITY;
  }

  if (Number.isFinite(durationMs)) {
    return {
      drawStartMs: drawStart,
      drawEndMs: drawEnd,
      clipStartMs: Math.min(clipStart, durationMs),
      clipEndMs: Math.min(clipEnd, durationMs)
    };
  }

  return {
    drawStartMs: drawStart,
    drawEndMs: drawEnd,
    clipStartMs: clipStart,
    clipEndMs: clipEnd
  };
}

function cloneStroke(stroke) {
  return {
    ...stroke,
    points: (stroke.points || []).map((point) => ({ ...point }))
  };
}

export function withStrokeClipWindow(stroke, { clipStartMs, clipEndMs }, fps = 30, durationMs = Number.POSITIVE_INFINITY) {
  const next = cloneStroke(stroke);
  const boundedDuration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : Number.POSITIVE_INFINITY;

  const safeStart = Math.max(0, Number.isFinite(clipStartMs) ? clipStartMs : 0);
  let safeEnd = Number.isFinite(clipEndMs) ? clipEndMs : boundedDuration;
  safeEnd = Math.max(safeStart, safeEnd);

  if (Number.isFinite(boundedDuration)) {
    next.clipStartMs = Math.min(safeStart, boundedDuration);
    next.clipEndMs = Math.min(safeEnd, boundedDuration);
  } else {
    next.clipStartMs = safeStart;
    next.clipEndMs = safeEnd;
  }

  next.startFrame = timeMsToFrame(strokeDrawStartMs(next, fps), fps);
  next.endFrame = timeMsToFrame(strokeDrawEndMs(next, fps), fps);

  return next;
}

export function shiftStrokeInTime(stroke, deltaMs, fps = 30, durationMs = Number.POSITIVE_INFINITY) {
  const next = cloneStroke(stroke);
  const offsetMs = Number.isFinite(Number(deltaMs)) ? Number(deltaMs) : 0;

  next.points = next.points.map((point) => {
    const value = Number(point.timeMs);
    if (!Number.isFinite(value)) {
      return point;
    }

    return {
      ...point,
      timeMs: Math.max(0, value + offsetMs)
    };
  });

  const window = strokeClipWindowMs(stroke, fps, durationMs);
  const nextStart = window.clipStartMs + offsetMs;
  const nextEnd = window.clipEndMs + offsetMs;

  next.clipStartMs = Math.max(0, nextStart);
  next.clipEndMs = Math.max(next.clipStartMs, nextEnd);

  if (Number.isFinite(durationMs)) {
    next.clipStartMs = Math.min(next.clipStartMs, durationMs);
    next.clipEndMs = Math.min(next.clipEndMs, durationMs);
  }

  next.startFrame = timeMsToFrame(strokeDrawStartMs(next, fps), fps);
  next.endFrame = timeMsToFrame(strokeDrawEndMs(next, fps), fps);

  return next;
}

export function splitStrokeAtTime(stroke, cutMs, fps = 30, durationMs = Number.POSITIVE_INFINITY) {
  const window = strokeClipWindowMs(stroke, fps, durationMs);
  const safeCut = Number.isFinite(Number(cutMs)) ? Number(cutMs) : 0;
  const minGapMs = 20;

  if (safeCut <= window.clipStartMs + minGapMs || safeCut >= window.clipEndMs - minGapMs) {
    return null;
  }

  const first = withStrokeClipWindow(
    {
      ...cloneStroke(stroke),
      id: createId("stroke")
    },
    {
      clipStartMs: window.clipStartMs,
      clipEndMs: safeCut
    },
    fps,
    durationMs
  );

  const second = withStrokeClipWindow(
    {
      ...cloneStroke(stroke),
      id: createId("stroke")
    },
    {
      clipStartMs: safeCut,
      clipEndMs: window.clipEndMs
    },
    fps,
    durationMs
  );

  return [first, second];
}