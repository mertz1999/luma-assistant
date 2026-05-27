import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#15211d",
        paper: "#f6f4ef",
        fern: "#2f6f5e",
        copper: "#b96f3d",
        signal: "#e0a526",
        berry: "#a7485f",
      },
      boxShadow: {
        panel: "0 20px 70px rgba(21, 33, 29, 0.16)",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
} satisfies Config;
