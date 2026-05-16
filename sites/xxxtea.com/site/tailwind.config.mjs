/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        // Soaked oolong — deep warm-black base
        steep: {
          50:  '#f7f3ec',
          100: '#e8dbc4',
          200: '#c9b696',
          300: '#8a7458',
          400: '#4d3d28',
          500: '#3a2e1f',
          600: '#2b2117',
          700: '#1f1810',
          800: '#15110a',
          900: '#0a0805',
        },
        // Wet amber — primary CTA / brand mark
        honey: {
          300: '#ffd97a',
          400: '#ffc949',
          500: '#ffb300',
          600: '#e69400',
          700: '#a36800',
        },
        // Hibiscus — secondary accent (rooibos / herbal ratings)
        hibiscus: {
          400: '#e63976',
          500: '#c2185b',
          600: '#8e0d3f',
        },
        // Jade — reserved accent (matcha only)
        jade: {
          400: '#5fa648',
          500: '#4a7c3a',
        },
        // Cream / paper — for editorial sections
        porcelain: '#f5ede0',
        // Brass / vessel tone — muted product-shot backdrop
        brass: '#b08d57',
      },
      fontFamily: {
        // Editorial display serif — perfume label weight
        display: ['"Cormorant Garamond"', 'Georgia', 'serif'],
        // Sleek sans — body and UI (slightly rounded)
        sans: ['"Outfit"', 'system-ui', 'sans-serif'],
        // Mono — specs, brew time/temp, SKU codes
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      letterSpacing: {
        'brand': '0.36em',
      },
      animation: {
        'fade-up': 'fadeUp 0.7s ease-out both',
        'drip':    'drip 3.2s ease-in-out infinite',
        'bloom':   'bloom 1.2s ease-out both',
      },
      keyframes: {
        fadeUp: {
          '0%':   { opacity: 0, transform: 'translateY(16px)' },
          '100%': { opacity: 1, transform: 'translateY(0)' },
        },
        drip: {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(255,179,0,0.55)' },
          '50%':      { boxShadow: '0 0 0 16px rgba(255,179,0,0)' },
        },
        bloom: {
          '0%':   { opacity: 0, transform: 'scale(0.94)' },
          '100%': { opacity: 1, transform: 'scale(1)' },
        },
      },
    },
  },
  plugins: [],
};
