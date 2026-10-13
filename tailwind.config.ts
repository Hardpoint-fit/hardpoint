import type { Config } from "tailwindcss";

// Colours are the game's tokens (generated into game-tokens.generated.css); Tailwind only names them.
export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    borderRadius: { none: "0" },
    extend: {
      colors: {
        panel: "var(--panel-bg)",
        header: "var(--header-bg)",
        content: "var(--content-bg)",
        accent: "var(--accent-orange)",
        muted: "var(--accent-muted)",
        primary: "var(--text-primary)",
        secondary: "var(--text-secondary)",
        positive: "var(--state-positive)",
        negative: "var(--state-negative)",
      },
      fontFamily: { game: ["var(--font-family)"] },
    },
  },
  plugins: [],
} satisfies Config;
