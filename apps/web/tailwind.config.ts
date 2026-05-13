import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "rgb(var(--color-bg) / <alpha-value>)",
        foreground: "rgb(var(--color-fg) / <alpha-value>)",
        card: "var(--card)",
        "card-border": "var(--card-border)",
        muted: "rgb(var(--color-muted) / <alpha-value>)",
        "surface-1": "rgb(var(--color-surface-1) / <alpha-value>)",
        "surface-2": "rgb(var(--color-surface-2) / <alpha-value>)",
        control: "rgb(var(--color-control) / <alpha-value>)",
        "control-hover": "rgb(var(--color-control-hover) / <alpha-value>)",
        "danger-bg": "rgb(var(--color-danger-bg) / <alpha-value>)",
        "danger-fg": "rgb(var(--color-danger-fg) / <alpha-value>)",
        brand: {
          DEFAULT: "rgb(var(--color-brand) / <alpha-value>)",
          dark: "rgb(var(--color-brand-dark) / <alpha-value>)",
          soft: "rgb(var(--color-brand-soft) / <alpha-value>)",
        },
        accent: "rgb(var(--color-warn) / <alpha-value>)",
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "Noto Sans",
          "sans-serif",
          "Apple Color Emoji",
          "Segoe UI Emoji",
          "Segoe UI Symbol",
          "Noto Color Emoji",
        ],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Consolas", "monospace"],
      },
      boxShadow: {
        soft: "0 16px 46px rgba(15,34,48,0.14)",
        card: "0 10px 30px rgba(14,35,49,0.1)",
      },
      animation: {
        "fade-up": "fadeUp .2s ease-out",
        "slide-in": "slideIn .2s ease-out",
      },
      keyframes: {
        fadeUp: {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        slideIn: {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
