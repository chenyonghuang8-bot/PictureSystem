export const tokens = {
  color: {
    background: "#f8f6f1",
    surface: "#ffffff",
    text: "#242722",
    textMuted: "#7b8078",
    border: "#ebe8e1",
    accent: "#58a96b",
    accentStrong: "#347c49",
    accentSoft: "#edf5ed",
  },
  radius: {
    sm: 12,
    md: 18,
    lg: 24,
    xl: 32,
    pill: 999,
  },
  shadow: {
    soft: "0 12px 36px rgba(49, 44, 36, 0.08)",
  },
  space: {
    1: 4,
    2: 8,
    3: 12,
    4: 16,
    5: 20,
    6: 24,
    7: 32,
    8: 40,
    9: 48,
  },
} as const;

export type DesignTokens = typeof tokens;
