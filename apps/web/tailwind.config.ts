import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "#e9eef2",
        foreground: "#0d2230",
        card: "#ffffffcc",
        "card-border": "#0d223024",
        brand: {
          DEFAULT: "#12867d",
          dark: "#0f6a63",
          soft: "#daf1ed"
        },
        accent: "#ea5c38",
        muted: "#f5f9fc",
      },
      fontFamily: {
        sans: ["Space Grotesk", "sans-serif"],
        mono: ["Azeret Mono", "monospace"],
      },
      boxShadow: {
        soft: "0 16px 46px rgba(15,34,48,0.14)",
        card: "0 10px 30px rgba(14,35,49,0.1)",
      },
      animation: {
        "fade-up": "fadeUp .2s ease-out",
        "slide-in": "slideIn .2s ease-out"
      },
      keyframes: {
        fadeUp: {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        slideIn: {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        }
      }
    },
  },
  plugins: [],
} satisfies Config;
