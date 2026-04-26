import { TOOL_ERASER } from "../constants";

function ensureLayerCanvas(cache, layerId, width, height) {
  let layerCanvas = cache.get(layerId);

  if (!layerCanvas) {
    layerCanvas = document.createElement("canvas");
    cache.set(layerId, layerCanvas);
  }

  if (layerCanvas.width !== width || layerCanvas.height !== height) {
    layerCanvas.width = width;
    layerCanvas.height = height;
  }

  return layerCanvas;
}

function frameToTimeMs(frame, fps) {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const safeFrame = Number.isFinite(frame) ? frame : 0;
  return Math.max(0, (safeFrame * 1000) / safeFps);
}

function pointTimeMs(point) {
  const value = Number(point?.timeMs);
  return Number.isFinite(value) ? value : null;
}

function strokeStartTimeMs(stroke, fps) {
  const firstPointTime = pointTimeMs(stroke?.points?.[0]);
  if (firstPointTime !== null) {
    return firstPointTime;
  }

  const startFrame = Number(stroke?.startFrame);
  if (Number.isFinite(startFrame)) {
    return frameToTimeMs(startFrame, fps);
  }

  return 0;
}

function strokeClipStartMs(stroke, fps) {
  const value = Number(stroke?.clipStartMs);
  if (Number.isFinite(value)) {
    return Math.max(0, value);
  }

  return strokeStartTimeMs(stroke, fps);
}

function strokeClipEndMs(stroke) {
  const value = Number(stroke?.clipEndMs);
  if (Number.isFinite(value)) {
    return Math.max(0, value);
  }

  return Number.POSITIVE_INFINITY;
}

function strokeWidth(stroke, point) {
  const baseSize = Number(stroke.size) || 1;

  if (stroke.pressureEnabled === false) {
    return baseSize;
  }

  const rawPressure = Number(point?.pressure);
  if (!Number.isFinite(rawPressure) || rawPressure <= 0) {
    return baseSize;
  }

  const pressureSensitivity = Number.isFinite(Number(stroke.pressureSensitivity))
    ? Math.max(0.2, Math.min(4, Number(stroke.pressureSensitivity)))
    : 1.7;
  const pressureCurve = Number.isFinite(Number(stroke.pressureCurve))
    ? Math.max(0.2, Math.min(4, Number(stroke.pressureCurve)))
    : 1.75;
  const pressureMinScale = Number.isFinite(Number(stroke.pressureMinScale))
    ? Math.max(0.02, Math.min(0.95, Number(stroke.pressureMinScale)))
    : 0.05;

  const normalized = Math.max(0, Math.min(1, rawPressure));
  const sensitivityMapped = Math.max(
    0,
    Math.min(1, 0.5 + (normalized - 0.5) * pressureSensitivity)
  );
  const curved = Math.pow(sensitivityMapped, pressureCurve);
  const widthScale = pressureMinScale + (1 - pressureMinScale) * curved;

  return Math.max(0.2, baseSize * widthScale);
}

function drawStroke(ctx, stroke, pointsOverride = null) {
  const points = pointsOverride || stroke.points || [];
  if (points.length === 0) {
    return;
  }

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.globalAlpha = stroke.tool === TOOL_ERASER ? 1 : Number(stroke.opacity) || 1;

  if (stroke.tool === TOOL_ERASER) {
    ctx.globalCompositeOperation = "destination-out";
  } else {
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = stroke.color || "#ff6d5a";
    ctx.fillStyle = stroke.color || "#ff6d5a";
  }

  if (points.length === 1) {
    const p0 = points[0];
    const radius = strokeWidth(stroke, p0) / 2;
    ctx.beginPath();
    ctx.arc(p0.x, p0.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  for (let index = 1; index < points.length; index += 1) {
    const prev = points[index - 1];
    const next = points[index];
    ctx.lineWidth = strokeWidth(stroke, next);
    ctx.beginPath();
    ctx.moveTo(prev.x, prev.y);
    ctx.lineTo(next.x, next.y);
    ctx.stroke();
  }

  ctx.restore();
}

function pointsUntilTime(stroke, timeMs) {
  const points = stroke.points || [];
  if (points.length === 0) {
    return [];
  }

  if (!Number.isFinite(timeMs)) {
    return points;
  }

  const firstTime = pointTimeMs(points[0]);
  if (firstTime === null) {
    // Backward compatibility for older projects where points have no time.
    return points;
  }

  if (timeMs < firstTime) {
    return [];
  }

  const partial = [points[0]];

  for (let index = 1; index < points.length; index += 1) {
    const prev = points[index - 1];
    const next = points[index];
    const prevTime = pointTimeMs(prev);
    const nextTime = pointTimeMs(next);

    if (prevTime === null || nextTime === null) {
      partial.push(next);
      continue;
    }

    if (timeMs >= nextTime) {
      partial.push(next);
      continue;
    }

    if (timeMs <= prevTime) {
      break;
    }

    const span = nextTime - prevTime;
    if (span <= 0) {
      partial.push(next);
      continue;
    }

    const t = (timeMs - prevTime) / span;
    const prevPressure = Number.isFinite(Number(prev.pressure)) ? Number(prev.pressure) : 1;
    const nextPressure = Number.isFinite(Number(next.pressure)) ? Number(next.pressure) : 1;

    partial.push({
      x: prev.x + (next.x - prev.x) * t,
      y: prev.y + (next.y - prev.y) * t,
      pressure: prevPressure + (nextPressure - prevPressure) * t,
      timeMs
    });
    break;
  }

  return partial;
}

function renderLayerToCanvas(layerCanvas, layer, timeMs, fps) {
  const layerCtx = layerCanvas.getContext("2d");
  layerCtx.clearRect(0, 0, layerCanvas.width, layerCanvas.height);

  for (const stroke of layer.strokes || []) {
    const clipStart = strokeClipStartMs(stroke, fps);
    const clipEnd = strokeClipEndMs(stroke);
    if (timeMs < clipStart || timeMs > clipEnd) {
      continue;
    }

    const points = pointsUntilTime(stroke, Math.min(timeMs, clipEnd));
    if (points.length === 0) {
      continue;
    }

    drawStroke(layerCtx, stroke, points);
  }
}

export function createRenderState() {
  return {
    perLayerCanvas: new Map()
  };
}

export function renderAnnotationOverlay({
  targetCtx,
  width,
  height,
  layers,
  timeSeconds,
  fps,
  renderState,
  activeStroke,
  onionSkin
}) {
  if (!targetCtx) {
    return;
  }

  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const currentTimeMs = Math.max(0, (timeSeconds || 0) * 1000);
  const prevFrameTimeMs = Math.max(0, currentTimeMs - 1000 / safeFps);

  targetCtx.clearRect(0, 0, width, height);

  if (onionSkin) {
    drawFrame(targetCtx, width, height, layers, prevFrameTimeMs, safeFps, renderState, 0.35);
  }

  drawFrame(targetCtx, width, height, layers, currentTimeMs, safeFps, renderState, 1);

  if (activeStroke) {
    drawStroke(targetCtx, activeStroke);
  }
}

function drawFrame(targetCtx, width, height, layers, timeMs, fps, renderState, alpha) {
  if (!Array.isArray(layers) || layers.length === 0 || !Number.isFinite(timeMs) || timeMs < 0) {
    return;
  }

  targetCtx.save();
  targetCtx.globalAlpha = alpha;

  for (const layer of layers) {
    if (!layer.visible) {
      continue;
    }

    const layerCanvas = ensureLayerCanvas(renderState.perLayerCanvas, layer.id, width, height);
    renderLayerToCanvas(layerCanvas, layer, timeMs, fps);
    targetCtx.drawImage(layerCanvas, 0, 0, width, height);
  }

  targetCtx.restore();
}
