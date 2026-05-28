/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: ["./app/**/*.{js,ts,jsx,tsx}", "./components/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0b1111",
        panel: "#141f1e",
        line: "#273c39",
        aqua: "#4ad4c3",
        orange: "#ff9f43",
      },
      boxShadow: {
        glow: "0 0 0 1px #2a403d, 0 16px 32px rgba(0,0,0,.28)",
      },
    },
  },
  plugins: [],
};
