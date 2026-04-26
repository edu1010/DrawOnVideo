const { spawn } = require("child_process");
const ffprobe = require("ffprobe-static");

function parseRatio(value, fallback = 30) {
  if (!value || typeof value !== "string") {
    return fallback;
  }

  if (!value.includes("/")) {
    const direct = Number(value);
    return Number.isFinite(direct) && direct > 0 ? direct : fallback;
  }

  const [numRaw, denRaw] = value.split("/");
  const num = Number(numRaw);
  const den = Number(denRaw);

  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) {
    return fallback;
  }

  return num / den;
}

function parseDuration(streamDuration, formatDuration) {
  const direct = Number(streamDuration);
  if (Number.isFinite(direct) && direct > 0) {
    return direct;
  }

  const fallback = Number(formatDuration);
  if (Number.isFinite(fallback) && fallback > 0) {
    return fallback;
  }

  return 0;
}

function probeVideo(videoPath) {
  return new Promise((resolve, reject) => {
    if (!ffprobe.path) {
      reject(new Error("ffprobe-static path was not found."));
      return;
    }

    const args = [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,r_frame_rate,avg_frame_rate,duration",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      videoPath
    ];

    const proc = spawn(ffprobe.path, args, { windowsHide: true });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (error) => {
      reject(error);
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `ffprobe exited with code ${code}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        const stream = parsed?.streams?.[0] || {};
        const format = parsed?.format || {};

        const fps = parseRatio(stream.avg_frame_rate || stream.r_frame_rate, 30);
        const duration = parseDuration(stream.duration, format.duration);

        resolve({
          width: Number(stream.width) || 1280,
          height: Number(stream.height) || 720,
          fps,
          duration
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

module.exports = {
  probeVideo
};