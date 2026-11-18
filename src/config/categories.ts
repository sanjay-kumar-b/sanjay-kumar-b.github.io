// Add, remove, rename or reorder categories here. Nothing else needs to change.
// Articles refer to a category by its `slug` in their frontmatter.
export interface Category {
  slug: string;
  name: string;
  short: string;
  description: string;
  accent: string; // CSS color used for glows and badges
  icon: string; // icon name from components/Icon.astro (code, spark, shield, layers, terminal)
  topics: string[];
}

export const CATEGORIES: Category[] = [
  {
    slug: 'salesforce-development',
    name: 'Salesforce Development',
    short: 'Development',
    description: 'Apex, triggers, async processing, SOQL, LWC, integrations and architecture.',
    accent: '#0a84ff',
    icon: 'code',
    topics: ['Apex', 'Triggers', 'Batch Apex', 'Queueable', 'SOQL', 'LWC', 'Integration', 'Governor Limits'],
  },
  {
    slug: 'agentforce',
    name: 'Agentforce & AI',
    short: 'Agentforce',
    description: 'Agents, actions, Prompt Builder, Data Cloud and real-world AI on Salesforce.',
    accent: '#bf5af2',
    icon: 'spark',
    topics: ['Agent Actions', 'Prompt Builder', 'Data Cloud', 'Einstein', 'Use Cases'],
  },
  {
    slug: 'salesforce-administration',
    name: 'Salesforce Administration',
    short: 'Admin',
    description: 'Flows, security, permissions, reports and release updates.',
    accent: '#32d6c9',
    icon: 'shield',
    topics: ['Flows', 'Validation Rules', 'Permission Sets', 'Sharing', 'Reports', 'Releases'],
  },
  {
    slug: 'react-and-salesforce',
    name: 'React & Salesforce',
    short: 'React',
    description: 'React fundamentals, hooks, Salesforce APIs and React vs LWC.',
    accent: '#64d2ff',
    icon: 'layers',
    topics: ['Hooks', 'Components', 'REST APIs', 'React vs LWC', 'Architecture'],
  },
  {
    slug: 'web-and-devops',
    name: 'Web & DevOps',
    short: 'Web & DevOps',
    description: 'JavaScript, TypeScript, Git, CI/CD, cloud and developer productivity.',
    accent: '#ff9f0a',
    icon: 'terminal',
    topics: ['JavaScript', 'TypeScript', 'Git', 'CI/CD', 'Cloud', 'Productivity'],
  },
];

export const getCategory = (slug: string) => CATEGORIES.find((c) => c.slug === slug);
