/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bgDark: "#0D0D0D",
        neonCyan: "#00f3ff",
        neonMagenta: "#ff003c",
        terminalGreen: "#00ff41",
      },
      fontFamily: {
        mono: ['"Fira Code"', "monospace", "Courier New"],
      },
    },
  },
  plugins: [],
};
