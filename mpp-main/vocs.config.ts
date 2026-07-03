import ruby from "shiki/langs/ruby.mjs";
import { defineConfig } from "vocs/config";
import { shikiStyleToClass } from "./src/shiki-style-to-class.js";

const baseUrl = (() => {
  if (process.env.VERCEL_ENV === "production")
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.NODE_ENV !== "production") return "https://localhost:5173";
  return "";
})();

export default defineConfig({
  accentColor: "#7fe0a8",
  // Dark only. A single value makes Vocs force the scheme and hide the
  // light/dark toggle (it renders the toggle only when colorScheme is
  // "light dark").
  colorScheme: "dark",
  baseUrl,
  redirects: [
    { source: "/index", destination: "/" },
    { source: "/home", destination: "/" },

    // Aliases for overview
    { source: "/docs", destination: "/overview" },
    { source: "/documentation", destination: "/overview" },
    { source: "/about", destination: "/overview" },
    { source: "/protocol", destination: "/overview" },
    { source: "/mining", destination: "/overview" },
    { source: "/get-started", destination: "/overview" },
    { source: "/getting-started", destination: "/overview" },
    { source: "/start", destination: "/overview" },

    // Whitepaper aliases
    { source: "/paper", destination: "/whitepaper" },
    { source: "/wp", destination: "/whitepaper" },
    { source: "/litepaper", destination: "/whitepaper" },

    // FAQ aliases
    { source: "/faqs", destination: "/faq" },
  ],
  description:
    "AXIS AI turns verifiable AI computation into a mineable digital commodity. Fixed supply of 84,000,000 AXIS.",
  checkDeadlinks: true,
  iconUrl: "/logo.png",
  groupIcons: {
    customIcons: {
      amp: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" fill="currentColor"><path d="M13.9197 13.61L17.3816 26.566L14.242 27.4049L11.2645 16.2643L0.119926 13.2906L0.957817 10.15L13.9197 13.61Z"/><path d="M13.7391 16.0892L4.88169 24.9056L2.58872 22.6019L11.4461 13.7865L13.7391 16.0892Z"/><path d="M18.9386 8.58315L22.4005 21.5392L19.2609 22.3781L16.2833 11.2374L5.13879 8.26381L5.97668 5.12318L18.9386 8.58315Z"/><path d="M23.9803 3.55632L27.4422 16.5124L24.3025 17.3512L21.325 6.21062L10.1805 3.23698L11.0183 0.0963593L23.9803 3.55632Z"/></svg>',
    },
  },
  logoUrl: "/logo.png",
  ogImageUrl: (path, { baseUrl: base } = { baseUrl: "" }) =>
    path === "/"
      ? `${base}/og.png`
      : `${base}/api/og?title=%title&description=%description&path=${encodeURIComponent(path)}`,
  sidebar: {
    "/": [
      {
        text: "Start here",
        items: [
          { text: "Mine AXIS", link: "/" },
          { text: "Overview", link: "/overview" },
          { text: "Market & AI Trading", link: "/market" },
          { text: "AI Compute", link: "/compute" },
        ],
      },
      {
        text: "Ecosystem",
        items: [
          { text: "Services", link: "/services" },
          { text: "Blog", link: "/blog" },
        ],
      },
      {
        text: "Protocol",
        items: [
          { text: "Whitepaper", link: "/whitepaper" },
          { text: "FAQ", link: "/faq" },
        ],
      },
    ],
  },
  socials: [
    { icon: "x", link: "https://x.com/axis_ai" },
    { icon: "github", link: "https://github.com/axis-ai" },
  ],
  title: "AXIS AI — Proof-of-AI-Work Protocol",
  titleTemplate: "%s | AXIS AI",
  // Replaces repeated inline Shiki color styles with CSS classes, reducing
  // uncompressed page size by ~1.5 MB. See src/shiki-style-to-class.ts.
  codeHighlight: {
    langs: ruby,
    transformers: [shikiStyleToClass()],
  },
  twoslash: {
    twoslashOptions: {
      compilerOptions: {
        moduleResolution: 100,
        types: ["node"],
      },
    },
  },
  topNav: [
    { text: "Overview", link: "/overview", match: (path) => path !== "/" },
    { text: "Market", link: "/market" },
    { text: "Compute", link: "/compute" },
    { text: "Services", link: "/services" },
    { text: "Blog", link: "/blog" },
    { text: "Whitepaper", link: "/whitepaper" },
    { text: "FAQ", link: "/faq" },
    { text: "GitHub", link: "https://github.com/axis-ai" },
  ],
});
