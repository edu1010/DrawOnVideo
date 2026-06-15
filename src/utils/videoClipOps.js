import { createId } from "./id";

function safeNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeFadeDurationMs(value, clipDurationMs) {
  const duration = Math.max(0, safeNumber(clipDurationMs));
  const fade = safeNumber(value, 0);
  return Math.max(0, Math.min(duration, fade));
}

function clipSourceRangeMs(clip) {
  const start = Math.max(0, safeNumber(clip?.sourceStartMs));
  const rawEnd = Number(clip?.sourceEndMs);
  if (Number.isFinite(rawEnd) && rawEnd >= start) {
    return { startMs: start, endMs: rawEnd };
  }

  const rawDuration = Number(clip?.sourceDurationMs);
  if (Number.isFinite(rawDuration) && rawDuration > start) {
    return { startMs: start, endMs: rawDuration };
  }

  return { startMs: start, endMs: start };
}

export function clipSourceDurationMs(clip) {
  const range = clipSourceRangeMs(clip);
  return Math.max(0, range.endMs - range.startMs);
}

export function clipDurationMs(clip) {
  return clipSourceDurationMs(clip);
}

export function clipTimelineDurationMs(clip) {
  const timelineDuration = Number(clip?.timelineDurationMs);
  if (Number.isFinite(timelineDuration) && timelineDuration > 0) {
    return Math.max(0, timelineDuration);
  }

  return clipSourceDurationMs(clip);
}

export function clipTimelineEndMs(clip) {
  return safeNumber(clip?.timelineStartMs) + clipTimelineDurationMs(clip);
}

export function clipFadeInDurationMs(clip) {
  return normalizeFadeDurationMs(clip?.fadeInDurationMs, clipTimelineDurationMs(clip));
}

export function clipFadeOutDurationMs(clip) {
  return normalizeFadeDurationMs(clip?.fadeOutDurationMs, clipTimelineDurationMs(clip));
}

export function clipAudioFadeInDurationMs(clip) {
  return normalizeFadeDurationMs(clip?.audioFadeInDurationMs, clipTimelineDurationMs(clip));
}

export function clipAudioFadeOutDurationMs(clip) {
  return normalizeFadeDurationMs(clip?.audioFadeOutDurationMs, clipTimelineDurationMs(clip));
}

function clipFadeLevelAtTimelineMs(clip, timelineMs, fadeInMs, fadeOutMs) {
  if (!clip) {
    return 0;
  }

  const t = safeNumber(timelineMs);
  const startMs = safeNumber(clip.timelineStartMs);
  const endMs = clipTimelineEndMs(clip);
  if (endMs <= startMs || t < startMs || t >= endMs) {
    return 0;
  }

  let level = 1;

  if (fadeInMs > 0) {
    const fadeInProgress = (t - startMs) / fadeInMs;
    level = Math.min(level, Math.max(0, Math.min(1, fadeInProgress)));
  }

  if (fadeOutMs > 0) {
    const fadeOutProgress = (endMs - t) / fadeOutMs;
    level = Math.min(level, Math.max(0, Math.min(1, fadeOutProgress)));
  }

  return Math.max(0, Math.min(1, level));
}

export function clipOpacityAtTimelineMs(clip, timelineMs) {
  return clipFadeLevelAtTimelineMs(
    clip,
    timelineMs,
    clipFadeInDurationMs(clip),
    clipFadeOutDurationMs(clip)
  );
}

export function clipAudioLevelAtTimelineMs(clip, timelineMs) {
  return clipFadeLevelAtTimelineMs(
    clip,
    timelineMs,
    clipAudioFadeInDurationMs(clip),
    clipAudioFadeOutDurationMs(clip)
  );
}

export function resolveSameLayerBlend(clips, activeClip, timelineMs) {
  if (!activeClip) {
    return null;
  }

  const t = Math.max(0, safeNumber(timelineMs));
  const activeStartMs = safeNumber(activeClip.timelineStartMs);
  const activeLayerId = String(activeClip.videoLayerId || "");

  const outgoingClip = sortVideoClips(clips)
    .filter((clip) => {
      if (clip.id === activeClip.id || String(clip.videoLayerId || "") !== activeLayerId) {
        return false;
      }

      const startMs = safeNumber(clip.timelineStartMs);
      const endMs = clipTimelineEndMs(clip);
      return startMs <= activeStartMs && t >= startMs && t < endMs;
    })
    .sort((a, b) => safeNumber(b.timelineStartMs) - safeNumber(a.timelineStartMs))[0] || null;

  const activeOpacity = clipOpacityAtTimelineMs(activeClip, t);
  const outgoingOpacity = outgoingClip ? clipOpacityAtTimelineMs(outgoingClip, t) : 0;

  return {
    activeOpacity,
    outgoingClip: outgoingOpacity > 0.0001 ? outgoingClip : null,
    outgoingOpacity: outgoingOpacity > 0.0001 ? outgoingOpacity : 0
  };
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
  timelineDurationMs,
  timelineStartMs = 0,
  videoLayerId = "",
  audioMuted = false,
  audioGainDb = 0,
  fadeInDurationMs = 0,
  fadeOutDurationMs = 0,
  audioFadeInDurationMs = 0,
  audioFadeOutDurationMs = 0,
  fps,
  width,
  height
}) {
  const duration = Math.max(0, safeNumber(sourceDurationMs));
  const start = Math.max(0, safeNumber(sourceStartMs));
  const end = Number.isFinite(Number(sourceEndMs))
    ? Math.min(duration, Math.max(start, Number(sourceEndMs)))
    : duration;
  const sourceSpan = Math.max(0, end - start);
  const explicitTimelineDuration = Number(timelineDurationMs);
  const normalizedTimelineDuration = Number.isFinite(explicitTimelineDuration) && explicitTimelineDuration > 0
    ? Math.max(0, explicitTimelineDuration)
    : sourceSpan;

  return {
    id: createId("vclip"),
    path,
    url,
    name,
    sourceDurationMs: duration,
    sourceStartMs: start,
    sourceEndMs: end,
    timelineDurationMs: normalizedTimelineDuration,
    timelineStartMs: Math.max(0, safeNumber(timelineStartMs)),
    videoLayerId: String(videoLayerId || ""),
    audioMuted: Boolean(audioMuted),
    audioGainDb: Math.min(18, Math.max(-60, safeNumber(audioGainDb, 0))),
    fadeInDurationMs: normalizeFadeDurationMs(fadeInDurationMs, normalizedTimelineDuration),
    fadeOutDurationMs: normalizeFadeDurationMs(fadeOutDurationMs, normalizedTimelineDuration),
    audioFadeInDurationMs: normalizeFadeDurationMs(audioFadeInDurationMs, normalizedTimelineDuration),
    audioFadeOutDurationMs: normalizeFadeDurationMs(audioFadeOutDurationMs, normalizedTimelineDuration),
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
  return null;
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
    const oldTimelineDuration = clipTimelineDurationMs(clip);
    const oldEnd = oldStart + oldTimelineDuration;
    const sourceRange = clipSourceRangeMs(clip);
    const oldSrcStart = sourceRange.startMs;
    const oldSrcEnd = sourceRange.endMs;
    const sourceDuration = Math.max(oldSrcEnd, safeNumber(clip.sourceDurationMs));
    const oldSourceDuration = Math.max(0, oldSrcEnd - oldSrcStart);

    let newStart = Number.isFinite(Number(nextWindow?.startMs)) ? Number(nextWindow.startMs) : oldStart;
    let newEnd = Number.isFinite(Number(nextWindow?.endMs)) ? Number(nextWindow.endMs) : oldEnd;

    newStart = Math.max(0, newStart);
    newEnd = Math.max(newStart + minDurationMs, newEnd);

    const deltaStart = newStart - oldStart;
    const deltaEnd = newEnd - oldEnd;

    let newSrcStart = oldSrcStart + deltaStart;
    if (sourceDuration > 0) {
      const maxSrcStart = Math.max(0, sourceDuration - minDurationMs);
      newSrcStart = Math.max(0, Math.min(maxSrcStart, newSrcStart));
    } else {
      newSrcStart = Math.max(0, newSrcStart);
    }

    const desiredSourceDuration = Math.max(minDurationMs, oldSourceDuration + deltaEnd);
    let newSourceDuration = desiredSourceDuration;
    if (sourceDuration > 0) {
      const maxSourceDuration = Math.max(0, sourceDuration - newSrcStart);
      newSourceDuration = Math.min(desiredSourceDuration, maxSourceDuration);
    }
    newSourceDuration = Math.max(0, newSourceDuration);

    const newSrcEnd = newSrcStart + newSourceDuration;
    const normalizedTimelineDuration = Math.max(minDurationMs, newEnd - newStart);
    const nextFadeInDurationMs = normalizeFadeDurationMs(clip.fadeInDurationMs, normalizedTimelineDuration);
    const nextFadeOutDurationMs = normalizeFadeDurationMs(clip.fadeOutDurationMs, normalizedTimelineDuration);
    const nextAudioFadeInDurationMs = normalizeFadeDurationMs(clip.audioFadeInDurationMs, normalizedTimelineDuration);
    const nextAudioFadeOutDurationMs = normalizeFadeDurationMs(clip.audioFadeOutDurationMs, normalizedTimelineDuration);

    return {
      ...clip,
      timelineStartMs: newStart,
      sourceStartMs: newSrcStart,
      sourceEndMs: newSrcEnd,
      timelineDurationMs: normalizedTimelineDuration,
      fadeInDurationMs: nextFadeInDurationMs,
      fadeOutDurationMs: nextFadeOutDurationMs,
      audioFadeInDurationMs: nextAudioFadeInDurationMs,
      audioFadeOutDurationMs: nextAudioFadeOutDurationMs
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
    const timelineDuration = clipTimelineDurationMs(clip);
    const end = start + timelineDuration;
    const safeCut = safeNumber(cutMs);

    if (safeCut <= start + minDurationMs || safeCut >= end - minDurationMs) {
      next.push(clip);
      continue;
    }

    const srcStart = safeNumber(clip.sourceStartMs);
    const sourceRange = clipSourceRangeMs(clip);
    const srcEnd = sourceRange.endMs;
    const sourceDuration = Math.max(0, srcEnd - srcStart);

    const offset = safeCut - start;
    const firstTimelineDuration = offset;
    const secondTimelineDuration = Math.max(0, timelineDuration - offset);
    const firstSourceDuration = Math.min(sourceDuration, firstTimelineDuration);
    const secondSourceDuration = Math.max(0, sourceDuration - firstSourceDuration);
    const firstSrcEnd = srcStart + firstSourceDuration;
    const secondSrcStart = firstSrcEnd;
    const secondSrcEnd = secondSrcStart + secondSourceDuration;
    const clipFadeInMs = clipFadeInDurationMs(clip);
    const clipFadeOutMs = clipFadeOutDurationMs(clip);
    const clipAudioFadeInMs = clipAudioFadeInDurationMs(clip);
    const clipAudioFadeOutMs = clipAudioFadeOutDurationMs(clip);

    const first = {
      ...clip,
      id: createId("vclip"),
      sourceStartMs: srcStart,
      sourceEndMs: firstSrcEnd,
      timelineStartMs: start,
      timelineDurationMs: firstTimelineDuration,
      fadeInDurationMs: normalizeFadeDurationMs(clipFadeInMs, firstTimelineDuration),
      fadeOutDurationMs: 0,
      audioFadeInDurationMs: normalizeFadeDurationMs(clipAudioFadeInMs, firstTimelineDuration),
      audioFadeOutDurationMs: 0
    };

    const second = {
      ...clip,
      id: createId("vclip"),
      sourceStartMs: secondSrcStart,
      sourceEndMs: secondSrcEnd,
      timelineStartMs: safeCut,
      timelineDurationMs: secondTimelineDuration,
      fadeInDurationMs: 0,
      fadeOutDurationMs: normalizeFadeDurationMs(clipFadeOutMs, secondTimelineDuration),
      audioFadeInDurationMs: 0,
      audioFadeOutDurationMs: normalizeFadeDurationMs(clipAudioFadeOutMs, secondTimelineDuration)
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

// Ripple delete: remove the selected clips and slide every surviving clip on the
// same video layer left by the total duration of the deleted clips that started
// before it, closing the gaps they left behind.
export function rippleDeleteVideoClips(clips, clipIds) {
  const ids = new Set(clipIds || []);
  if (ids.size === 0) {
    return clips || [];
  }

  const removedByLayer = new Map();
  for (const clip of clips || []) {
    if (!ids.has(clip.id)) {
      continue;
    }
    const layerId = String(clip.videoLayerId || "");
    if (!removedByLayer.has(layerId)) {
      removedByLayer.set(layerId, []);
    }
    removedByLayer.get(layerId).push(clip);
  }

  return (clips || [])
    .filter((clip) => !ids.has(clip.id))
    .map((clip) => {
      const removed = removedByLayer.get(String(clip.videoLayerId || ""));
      if (!removed || removed.length === 0) {
        return clip;
      }

      const start = safeNumber(clip.timelineStartMs);
      let shift = 0;
      for (const removedClip of removed) {
        if (safeNumber(removedClip.timelineStartMs) < start) {
          shift += clipTimelineDurationMs(removedClip);
        }
      }

      if (shift <= 0) {
        return clip;
      }

      return {
        ...clip,
        timelineStartMs: Math.max(0, start - shift)
      };
    });
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
        timelineDurationMs: clip.timelineDurationMs,
        timelineStartMs: clip.timelineStartMs,
        videoLayerId: clip.videoLayerId,
        audioMuted: clip.audioMuted,
        audioGainDb: clip.audioGainDb,
        fadeInDurationMs: clip.fadeInDurationMs,
        fadeOutDurationMs: clip.fadeOutDurationMs,
        audioFadeInDurationMs: clip.audioFadeInDurationMs,
        audioFadeOutDurationMs: clip.audioFadeOutDurationMs,
        fps: clip.fps,
        width: clip.width,
        height: clip.height
      });
    })
    .filter(Boolean);
}
