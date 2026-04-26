const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const path = require("path");

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = "";

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (error) => {
      reject(error);
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `ffmpeg exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

function codecCandidates(encoderMode, outputFormat) {
  const format = String(outputFormat || "mp4").toLowerCase();
  const mode = String(encoderMode || "auto").toLowerCase();

  if (format === "webm") {
    return ["libvpx-vp9"];
  }

  if (mode === "software") {
    return ["libx264"];
  }
  if (mode === "nvidia") {
    return ["h264_nvenc", "libx264"];
  }
  if (mode === "intel") {
    return ["h264_qsv", "libx264"];
  }
  if (mode === "amd") {
    return ["h264_amf", "libx264"];
  }

  return ["h264_nvenc", "h264_qsv", "h264_amf", "libx264"];
}

function resolveOutputFormat(outputFormat, outputPath) {
  const explicit = String(outputFormat || "").toLowerCase();
  if (["mp4", "mov", "webm"].includes(explicit)) {
    return explicit;
  }

  const ext = path.extname(outputPath || "").replace(".", "").toLowerCase();
  if (["mp4", "mov", "webm"].includes(ext)) {
    return ext;
  }

  return "mp4";
}

function normalizeDimension(value, minValue = 64) {
  if (!Number.isFinite(Number(value))) {
    return null;
  }

  return Math.max(minValue, Math.round(Number(value)));
}

function isH264Codec(codec) {
  return codec === "libx264" || codec === "h264_nvenc" || codec === "h264_qsv" || codec === "h264_amf";
}

function makeScaleFilter(width, height, codec) {
  const normalizedWidth = normalizeDimension(width);
  const normalizedHeight = normalizeDimension(height);

  if (!normalizedWidth && !normalizedHeight) {
    return null;
  }

  let outWidth = normalizedWidth;
  let outHeight = normalizedHeight;

  if (isH264Codec(codec)) {
    // H264 encoders typically require even dimensions.
    if (outWidth) {
      outWidth = Math.max(64, outWidth - (outWidth % 2));
    }
    if (outHeight) {
      outHeight = Math.max(64, outHeight - (outHeight % 2));
    }
  }

  if (!outWidth) {
    // -2 keeps aspect ratio and rounds to a valid even value when needed.
    outWidth = -2;
  }
  if (!outHeight) {
    outHeight = -2;
  }

  return `scale=${outWidth}:${outHeight}:flags=lanczos`;
}

function convertRecordingToMp4({
  recordingPath,
  sourceVideoPath,
  outputPath,
  fps = 30,
  includeAudio = true,
  preset = "medium",
  encoderMode = "auto",
  bitrateMbps = 12,
  outputFormat = "mp4",
  outputWidth,
  outputHeight,
  audioBitrate = "192k"
}) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error("ffmpeg-static path was not found."));
      return;
    }

    const safeFps = Number.isFinite(Number(fps)) && Number(fps) > 0 ? Number(fps) : 30;
    const safePreset = typeof preset === "string" && preset.trim() ? preset.trim() : "medium";
    const safeBitrateMbps = Number.isFinite(Number(bitrateMbps))
      ? Math.min(120, Math.max(1, Number(bitrateMbps)))
      : 12;
    const safeAudioBitrate = typeof audioBitrate === "string" && audioBitrate.trim()
      ? audioBitrate.trim()
      : "192k";
    const useAudio = Boolean(includeAudio && sourceVideoPath);
    const codecList = codecCandidates(encoderMode, outputFormat);
    const format = resolveOutputFormat(outputFormat, outputPath);

    (async () => {
      const errors = [];

      for (const codec of codecList) {
        const scaleFilter = makeScaleFilter(outputWidth, outputHeight, codec);
        const args = [
          "-y",
          "-i",
          recordingPath,
          ...(useAudio ? ["-i", sourceVideoPath] : []),
          "-map",
          "0:v:0",
          ...(useAudio ? ["-map", "1:a?"] : []),
          ...(scaleFilter ? ["-vf", scaleFilter] : []),
          "-c:v",
          codec,
          ...(codec !== "libvpx-vp9" ? ["-pix_fmt", "yuv420p"] : []),
          ...(codec === "libx264" ? ["-preset", safePreset] : []),
          ...(codec === "h264_nvenc" ? ["-preset", "p5"] : []),
          ...(codec === "h264_qsv" ? ["-preset", "medium"] : []),
          "-b:v",
          `${safeBitrateMbps}M`,
          "-r",
          String(safeFps),
          ...(useAudio ? ["-c:a", format === "webm" ? "libopus" : "aac", "-b:a", safeAudioBitrate] : ["-an"]),
          ...(format !== "webm" ? ["-movflags", "+faststart"] : []),
          "-shortest",
          outputPath
        ];

        try {
          await runFfmpeg(args);
          resolve();
          return;
        } catch (error) {
          errors.push(`${codec}: ${error.message}`);
        }
      }

      reject(new Error(`All encoders failed.\n${errors.join("\n")}`));
    })();
  });
}

module.exports = {
  convertRecordingToMp4
};
