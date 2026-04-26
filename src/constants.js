export const TOOL_BRUSH = "brush";
export const TOOL_ERASER = "eraser";

export const DEFAULT_BRUSH = {
  tool: TOOL_BRUSH,
  color: "#ff6d5a",
  size: 6,
  opacity: 1,
  pressureEnabled: true,
  pressureSensitivity: 1.7,
  pressureCurve: 1.75,
  pressureMinScale: 0.05
};

export const PRESSURE_PRESETS = [
  {
    id: "balanced",
    label: "Balanced",
    values: {
      pressureSensitivity: 1.7,
      pressureCurve: 1.75,
      pressureMinScale: 0.05
    }
  },
  {
    id: "huion",
    label: "Huion",
    values: {
      pressureSensitivity: 2.5,
      pressureCurve: 2.2,
      pressureMinScale: 0.03
    }
  },
  {
    id: "wacom",
    label: "Wacom",
    values: {
      pressureSensitivity: 2.15,
      pressureCurve: 1.95,
      pressureMinScale: 0.04
    }
  },
  {
    id: "light-touch",
    label: "Light Touch",
    values: {
      pressureSensitivity: 2.85,
      pressureCurve: 2.45,
      pressureMinScale: 0.02
    }
  }
];

export const DEFAULT_VIDEO_META = {
  width: 1280,
  height: 720,
  fps: 30,
  duration: 0
};
