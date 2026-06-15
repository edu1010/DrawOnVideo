import { createTheme } from "@mui/material/styles";

const theme = createTheme({
  palette: {
    mode: "dark",
    primary: {
      main: "#86d7ff",
      light: "#bce9ff",
      dark: "#4fbee7",
      contrastText: "#002636"
    },
    secondary: {
      main: "#c2c6ff",
      light: "#dde0ff",
      dark: "#9ba0d7",
      contrastText: "#24275f"
    },
    error: {
      main: "#ffb4ab",
      light: "#ffd9d4",
      dark: "#c65f59",
      contrastText: "#690005"
    },
    warning: {
      main: "#f8bd88"
    },
    success: {
      main: "#95d6a4"
    },
    background: {
      default: "#0e141b",
      paper: "#171d28"
    },
    text: {
      primary: "#eaf1ff",
      secondary: "#b7c5d9"
    },
    divider: "#435062"
  },
  shape: {
    borderRadius: 18
  },
  typography: {
    fontFamily: "\"Roboto Flex\", \"Segoe UI Variable\", \"Inter\", sans-serif",
    displaySmall: {
      fontSize: "2.25rem",
      lineHeight: 1.22,
      letterSpacing: "0"
    },
    headlineSmall: {
      fontSize: "1.5rem",
      lineHeight: 1.33,
      letterSpacing: "0"
    },
    h6: {
      fontWeight: 650,
      fontSize: "1rem",
      lineHeight: 1.5,
      letterSpacing: "0.01em"
    },
    subtitle1: {
      fontSize: "1rem",
      lineHeight: 1.5,
      letterSpacing: "0.01em"
    },
    subtitle2: {
      fontSize: "0.875rem",
      fontWeight: 600,
      letterSpacing: "0.02em"
    },
    body1: {
      fontSize: "1rem",
      lineHeight: 1.5,
      letterSpacing: "0.01em"
    },
    body2: {
      fontSize: "0.875rem",
      lineHeight: 1.43,
      letterSpacing: "0.012em"
    },
    caption: {
      fontSize: "0.75rem",
      lineHeight: 1.33,
      letterSpacing: "0.03em"
    },
    button: {
      textTransform: "none",
      fontWeight: 600,
      letterSpacing: "0.01em"
    }
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        ":root": {
          "--md-sys-color-primary": "#86d7ff",
          "--md-sys-color-on-primary": "#002636",
          "--md-sys-color-primary-container": "#1d3446",
          "--md-sys-color-on-primary-container": "#c8ecff",
          "--md-sys-color-secondary-container": "#2e2f4f",
          "--md-sys-color-surface": "#171d28",
          "--md-sys-color-surface-container": "#1d2430",
          "--md-sys-color-surface-container-high": "#252d3b",
          "--md-sys-color-surface-container-highest": "#2e3747",
          "--md-sys-color-on-surface": "#eaf1ff",
          "--md-sys-color-on-surface-variant": "#b7c5d9",
          "--md-sys-color-outline": "#5a657a",
          "--md-sys-color-outline-variant": "#435062"
        },
        body: {
          background:
            "radial-gradient(900px 480px at 8% 4%, rgba(116, 195, 255, 0.16), transparent 70%), radial-gradient(860px 500px at 96% 12%, rgba(173, 158, 255, 0.14), transparent 70%), linear-gradient(180deg, #0e141b 0%, #0b1017 45%, #090e14 100%)"
        }
      }
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          border: "1px solid var(--md-sys-color-outline-variant)",
          backgroundImage: "none",
          boxShadow: "0 1px 0 rgba(0, 0, 0, 0.2)"
        }
      }
    },
    MuiButton: {
      defaultProps: {
        disableElevation: true
      },
      styleOverrides: {
        root: {
          borderRadius: 999,
          paddingInline: 14,
          transition: "transform 120ms ease, box-shadow 120ms ease, background-color 120ms ease, border-color 120ms ease",
          "&:hover": {
            transform: "translateY(-1px)"
          },
          "&:active": {
            transform: "translateY(0)"
          },
          "&.Mui-disabled": {
            transform: "none"
          }
        },
        outlined: {
          borderColor: "color-mix(in srgb, var(--md-sys-color-outline) 70%, transparent)",
          "&:hover": {
            borderColor: "var(--md-sys-color-primary)",
            backgroundColor: "rgba(134, 215, 255, 0.08)"
          }
        },
        containedPrimary: {
          boxShadow: "0 4px 14px rgba(134, 215, 255, 0.22)",
          "&:hover": {
            boxShadow: "0 6px 18px rgba(134, 215, 255, 0.34)"
          }
        }
      }
    },
    MuiToggleButton: {
      styleOverrides: {
        root: {
          transition: "background-color 120ms ease, color 120ms ease, border-color 120ms ease"
        }
      }
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          borderRadius: 12
        }
      }
    },
    MuiSlider: {
      styleOverrides: {
        root: {
          color: "#86d7ff",
          height: 6
        },
        rail: {
          opacity: 0.32
        },
        track: {
          border: "none"
        },
        thumb: {
          width: 16,
          height: 16,
          boxShadow: "0 1px 4px rgba(0, 0, 0, 0.45)",
          transition: "box-shadow 120ms ease",
          "&:hover, &.Mui-focusVisible": {
            boxShadow: "0 0 0 8px rgba(134, 215, 255, 0.16)"
          },
          "&.Mui-active": {
            boxShadow: "0 0 0 12px rgba(134, 215, 255, 0.22)"
          }
        }
      }
    },
    MuiSwitch: {
      styleOverrides: {
        switchBase: {
          color: "#9facc0"
        },
        track: {
          backgroundColor: "#46566e"
        }
      }
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          backgroundColor: "rgba(20, 29, 40, 0.96)",
          border: "1px solid rgba(134, 215, 255, 0.3)",
          color: "#eaf1ff",
          fontSize: "0.74rem",
          fontWeight: 500,
          borderRadius: 8,
          padding: "6px 9px",
          backdropFilter: "blur(6px)"
        },
        arrow: {
          color: "rgba(20, 29, 40, 0.96)"
        }
      }
    }
  }
});

export default theme;
