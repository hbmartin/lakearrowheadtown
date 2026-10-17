// Shared by the Worker, metadata renderer, and offline artwork generator.
export const SITE = {
  origin: 'https://lakearrowhead.town',
  name: 'Lake Arrowhead . Town',
  title: 'News from Lake Arrowhead . Town',
  description: 'Community news and local updates from around Lake Arrowhead, California, gathered in one place with links to the original sources.',
  subtitle: 'Community news & local updates',
  language: 'en-US',
  locale: 'en_US',
  background: '#F8F6F1',
  foreground: '#1B3B1F',
  imageAlt: 'The Lake Arrowhead . Town tree mark and name in forest green on cream, with the subtitle Community news & local updates.',
} as const;

// Bump filenames when replacing bytes: these URLs are cached immutably.
export const ASSETS = {
  social: '/assets/social-card-v1.png',
  favicon: '/assets/favicon-v1.ico',
  favicon48: '/assets/favicon-48-v1.png',
  appleTouch: '/assets/apple-touch-icon-v1.png',
  icon192: '/assets/icon-192-v1.png',
  icon512: '/assets/icon-512-v1.png',
} as const;
