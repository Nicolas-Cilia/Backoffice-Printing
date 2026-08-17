/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // NOTE: Tailwind v4 loads its theme from the @theme block in
        // src/index.css (there is no @config directive), so these colour values
        // are not what the app renders — the accent resolves to the --accent
        // CSS variable. Kept in step with index.css so the two don't disagree.
        bambu: {
          green: '#07bcec',
          'green-light': '#15c9f8',
          'green-dark': '#07a8d3',
          dark: '#1a1a1a',
          'dark-secondary': '#2d2d2d',
          'dark-tertiary': '#3d3d3d',
          card: '#2d2d2d', // Same as dark-secondary for card backgrounds
          gray: '#808080',
          'gray-light': '#a0a0a0',
          'gray-dark': '#4a4a4a',
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(16px) scale(0.98)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
      },
      animation: {
        'fade-in': 'fadeIn 0.15s ease-out',
        'slide-up': 'slideUp 0.2s ease-out',
      },
    },
  },
  plugins: [],
}
