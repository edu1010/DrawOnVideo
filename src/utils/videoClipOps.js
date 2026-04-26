import { createId } from "./id";

function safeNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clipSourceRangeMs(clip) {
  const start = Math.max(0, safeNumber(clip?.sourceStartMs));
  const rawEnd = Number(clip?.sourceEndMs);
  if (Number.isFinite(rawEnd) && rawEnd > start) {
    return { startMs: start, endMs: rawEnd };
  }

  const rawDuration = Number(clip?.sourceDurationMs);
  if (Number.isFinite(rawDuration) && rawDuration > start) {
    return { startMs: start, endMs: rawDuration };
  }

  return { startMs: start, endMs: start };
}

export function clipDurationMs(clip) {
  const range = clipSourceRangeMs(clip);
  return Math.max(0, range.endMs - range.startMs);
}

export function clipTimelineEndMs(clip) {
  return safeNumber(clip?.timelineStartMs) + clipDurationMs(clip);
}

export function sortVideoClips(clips) {
  return [...(clips || [])].sort((a, b) => {
    const delta = safeNumber(a.timelineStartMs) - safeNumber(b.timelineStartMs);
    if (delta !== 0) {
      return delta;
    }

    return String(a.id).localeCompare(String(b.id));
  });
}

export function totalTimelineDurationMs(clips) {
  let maxEnd = 0;
  for (const clip of clips || []) {
    maxEnd = Math.max(maxEnd, clipTimelineEndMs(clip));
  }
  return maxEnd;
}

export function createVideoClip({
  path,
  url,
  name,
  sourceDurationMs,
  sourceStartMs = 0,
  sourceEndMs,
  timelineStartMs = 0,
  videoLayerId = "",
  audioMuted = false,
  audioGainDb = 0,
  fps,
  width,
  height
}) {
  const duration = Math.max(0, safeNumber(sourceDurationMs));
  const start = Math.max(0, safeNumber(sourceStartMs));
  const end = Number.isFinite(Number(sourceEndMs))
    ? Math.min(duration, Math.max(start, Number(sourceEndMs)))
    : duration;

  return {
    id: createId("vclip"),
    path,
    url,
    name,
    sourceDurationMs: duration,
    sourceStartMs: start,
    sourceEndMs: end,
    timelineStartMs: Math.max(0, safeNumber(timelineStartMs)),
    videoLayerId: String(videoLayerId || ""),
    audioMuted: Boolean(audioMuted),
    audioGainDb: Math.min(18, Math.max(-60, safeNumber(audioGainDb, 0))),
    fps: safeNumber(fps, 30),
    width: safeNumber(width, 1280),
    height: safeNumber(height, 720)
  };
}

function layerRank(layerOrderIds, layerId) {
  if (!Array.isArray(layerOrderIds) || layerOrderIds.length === 0) {
    return -1;
  }

  const rank = layerOrderIds.indexOf(layerId);
  return rank >= 0 ? rank : -1;
}

export function findVideoClipAtTime(clips, timeMs, options = {}) {
  const preferredLayerId = typeof options === "string"
    ? options
    : String(options.preferredLayerId || "");
  const layerOrderIds = typeof options === "string"
    ? null
    : (Array.isArray(options.layerOrderIds) ? options.layerOrderIds : null);

  const ordered = sortVideoClips(clips);
  if (ordered.length === 0) {
    return null;
  }

  const t = Math.max(0, safeNumber(timeMs));
  const matches = [];
  for (const clip of ordered) {
    const start = safeNumber(clip.timelineStartMs);
    const end = clipTimelineEndMs(clip);
    if (t >= start && t < end) {
      matches.push(clip);
    }
  }

  if (matches.length > 0) {
    if (layerOrderIds && layerOrderIds.length > 0) {
      matches.sort((a, b) => {
        const rankDelta = layerRank(layerOrderIds, a.videoLayerId) - layerRank(layerOrderIds, b.videoLayerId);
        if (rankDelta !== 0) {
          return rankDelta;
        }

        const timelineDelta = safeNumber(a.timelineStartMs) - safeNumber(b.timelineStartMs);
        if (timelineDelta !== 0) {
          return timelineDelta;
        }

        return String(a.id).localeCompare(String(b.id));
      });
      return matches[matches.length - 1];
    }

    if (preferredLayerId) {
      const preferred = matches.find((clip) => clip.videoLayerId === preferredLayerId);
      if (preferred) {
        return preferred;
      }
    }
    return matches[matches.length - 1];
  }

  let bestByStart = null;
  for (const clip of ordered) {
    const start = safeNumber(clip.timelineStartMs);
    if (start <= t && (!bestByStart || start >= safeNumber(bestByStart.timelineStartMs))) {
      bestByStart = clip;
    }
  }
  if (bestByStart) {
    return bestByStart;
  }

  const last = ordered[ordered.length - 1];
  if (t >= clipTimelineEndMs(last)) {
    return last;
  }

  return ordered[0];
}

export function nextVideoClip(clips, clipId) {
  const ordered = sortVideoClips(clips);
  const index = ordered.findIndex((clip) => clip.id === clipId);
  if (index < 0) {
    return ordered[0] || null;
  }

  return ordered[index + 1] || null;
}

export function moveVideoClip(clips, clipId, nextStartMs) {
  return (clips || []).map((clip) => {
    if (clip.id !== clipId) {
      return clip;
    }

    return {
      ...clip,
      timelineStartMs: Math.max(0, safeNumber(nextStartMs))
    };
  });
}

export function trimVideoClip(clips, clipId, nextWindow, minDurationMs = 120) {
  return (clips || []).map((clip) => {
    if (clip.id !== clipId) {
      return clip;
    }

    const oldStart = safeNumber(clip.timelineStartMs);
    const oldEnd = clipTimelineEndMs(clip);
    const sourceRange = clipSourceRangeMs(clip);
    const oldSrcStart = sourceRange.startMs;
    const oldSrcEnd = sourceRange.endMs;
    const sourceDuration = Math.max(oldSrcEnd, safeNumber(clip.sourceDurationMs));

    let newStart = Number.isFinite(Number(nextWindow?.startMs)) ? Number(nextWindow.startMs) : oldStart;
    let newEnd = Number.isFinite(Number(nextWindow?.endMs)) ? Number(nextWindow.endMs) : oldEnd;

    newStart = Math.max(0, newStart);
    newEnd = Math.max(newStart + minDurationMs, newEnd);

    const deltaStart = newStart - oldStart;
    const deltaEnd = newEnd - oldEnd;

    let newSrcStart = oldSrcStart + deltaStart;
    let newSrcEnd = oldSrcEnd + deltaEnd;

    newSrcStart = Math.max(0, Math.min(sourceDuration - minDurationMs, newSrcStart));
    newSrcEnd = Math.max(newSrcStart + minDurationMs, Math.min(sourceDuration, newSrcEnd));

    const normalizedDuration = newSrcEnd - newSrcStart;
    newEnd = newStart + normalizedDuration;

    return {
      ...clip,
      timelineStartMs: newStart,
      sourceStartMs: newSrcStart,
      sourceEndMs: newSrcEnd
    };
  });
}

export function splitVideoClip(clips, clipId, cutMs, minDurationMs = 120) {
  const next = [];

  for (const clip of clips || []) {
    if (clip.id !== clipId) {
      next.push(clip);
      continue;
    }

    const start = safeNumber(clip.timelineStartMs);
    const end = clipTimelineEndMs(clip);
    const safeCut = safeNumber(cutMs);

    if (safeCut <= start + minDurationMs || safeCut >= end - minDurationMs) {
      next.push(clip);
      continue;
    }

    const srcStart = safeNumber(clip.sourceStartMs);
    const srcEnd = safeNumber(clip.sourceEndMs);

    const offset = safeCut - start;
    const firstSrcEnd = Math.min(srcEnd, srcStart + offset);

    const first = {
      ...clip,
      id: createId("vclip"),
      sourceStartMs: srcStart,
      sourceEndMs: firstSrcEnd,
      timelineStartMs: start
    };

    const second = {
      ...clip,
      id: createId("vclip"),
      sourceStartMs: firstSrcEnd,
      sourceEndMs: srcEnd,
      timelineStartMs: safeCut
    };

    next.push(first, second);
  }

  return next;
}

export function removeVideoClips(clips, clipIds) {
  const ids = new Set(clipIds || []);
  if (ids.size === 0) {
    return clips || [];
  }

  return (clips || []).filter((clip) => !ids.has(clip.id));
}

export function moveVideoClipsToLayer(clips, clipIds, targetLayerId) {
  const ids = new Set(clipIds || []);
  const layerId = String(targetLayerId || "");
  if (ids.size === 0 || !layerId) {
    return clips || [];
  }

  return (clips || []).map((clip) => {
    if (!ids.has(clip.id)) {
      return clip;
    }

    return {
      ...clip,
      videoLayerId: layerId
    };
  });
}

export function normalizeVideoClips(rawClips) {
  if (!Array.isArray(rawClips)) {
    return [];
  }

  return rawClips
    .map((clip) => {
      if (!clip?.path) {
        return null;
      }

      return createVideoClip({
        path: clip.path,
        url: clip.url || "",
        name: clip.name,
        sourceDurationMs: clip.sourceDurationMs,
        sourceStartMs: clip.sourceStartMs,
        sourceEndMs: clip.sourceEndMs,
        timelineStartMs: clip.timelineStartMs,
        videoLayerId: clip.videoLayerId,
        audioMuted: clip.audioMuted,
        audioGainDb: clip.audioGainDb,
        fps: clip.fps,
        width: clip.width,
        height: clip.height
      });
    })
    .filter(Boolean);
}
