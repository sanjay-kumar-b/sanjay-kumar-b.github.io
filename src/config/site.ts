// Single place to edit your brand, author and social links.
import type { ImageMetadata } from 'astro';

// Author photo: drop a square-ish photo named "author.jpg" (or .png / .webp) into src/assets/.
// It is resized, cropped and converted automatically at build time. If no file exists,
// the site falls back to a gradient monogram.
const photos = import.meta.glob<{ default: ImageMetadata }>('../assets/author.{jpg,jpeg,png,webp}', { eager: true });
const authorPhoto: ImageMetadata | undefined = Object.values(photos)[0]?.default;

export const SITE = {
  name: 'SF SKODE',
  tagline: 'Skills and Knowledge for the Digital Era: Salesforce, Agentforce & React, explained clearly.',
  description:
    'In-depth tutorials on Apex, Lightning Web Components, Agentforce, Salesforce administration and React, with verified sources and working code.',
  author: {
    name: 'Sanjay Kumar B',
    role: 'Senior Salesforce Developer',
    photo: authorPhoto,
    bio: 'I write practical, source-backed guides on Salesforce development, Agentforce and React, the things I wish I had found when I was learning.',
  },
  social: {
    github: 'https://github.com/sanjay-kumar-b',
    linkedin: 'https://www.linkedin.com/in/sanjay-kumar-b-15128a227',
    youtube: '',
  } as Record<string, string>,
  contactEmail: 'sanjaykumarbalu06@gmail.com',
  // Newsletter: paste your provider's form action URL (Buttondown, Substack, MailerLite, etc.)
  newsletterAction: '',
  // Contact form: Formspree/Web3Forms endpoint. Leave empty to fall back to mailto.
  contactFormAction: '',
  // Analytics: Cloudflare Web Analytics token (privacy-friendly). Leave empty to disable.
  cloudflareAnalyticsToken: '',
  // Google Search Console verification string. Leave empty to omit.
  googleSiteVerification: '',
  disclaimer:
    'This is an independent site. It is not affiliated with, endorsed by, or sponsored by Salesforce, Inc. Salesforce, Agentforce and related marks belong to their owners.',
};
