import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        tier: {
          t1: "#ef4444",   // red-500
          t2: "#f59e0b",   // amber-500
          t3: "#3b82f6",   // blue-500
          noise: "#6b7280", // gray-500
        },
        sentiment: {
          positive: "#22c55e",  // green-500
          negative: "#ef4444",  // red-500
          neutral: "#94a3b8",   // slate-400
          mixed: "#a855f7",     // purple-500
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
