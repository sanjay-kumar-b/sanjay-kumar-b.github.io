// Markdown enhancements that run at build time (no client JS needed to lay them out):
//  - tables are wrapped in a keyboard-focusable scroll region (no layout shift, keeps real table semantics)
import { defineHastPlugin } from 'satteri';

export const enhanceMarkdown = defineHastPlugin({
  name: 'skode-enhance-markdown',
  element: {
    filter: ['table'],
    visit(node, ctx) {
      ctx.wrapNode(node, {
        type: 'element',
        tagName: 'div',
        properties: { className: ['table-wrap'], tabindex: '0', role: 'region', 'aria-label': 'Table, scrollable' },
        children: [],
      });
    },
  },
});

// Shiki transformer: wraps every highlighted <pre> in a .code block with a header
// (language label + copy button) so the markup is final before any JS runs.
const LABELS = { js: 'JavaScript', javascript: 'JavaScript', jsx: 'JSX', ts: 'TypeScript', typescript: 'TypeScript', tsx: 'TSX', apex: 'Apex', html: 'HTML', xml: 'XML', json: 'JSON', yaml: 'YAML', csv: 'CSV', bash: 'Bash', graphql: 'GraphQL', sql: 'SQL', css: 'CSS' };

export const codeBlockTransformer = {
  name: 'skode-code-block',
  root(root) {
    const pre = root.children.find((c) => c.type === 'element' && c.tagName === 'pre');
    if (!pre) return;
    const lang = String(this.options?.lang ?? '').toLowerCase();
    const plain = !lang || lang === 'plaintext' || lang === 'text' || lang === 'txt';
    const label = plain ? '' : LABELS[lang] ?? lang;
    const button = {
      type: 'element', tagName: 'button',
      properties: { className: ['code__copy'], type: 'button', 'aria-label': label ? `Copy ${label} code` : 'Copy code' },
      children: [{ type: 'text', value: 'Copy' }],
    };
    const bar = {
      type: 'element', tagName: 'div', properties: { className: ['code__bar'] },
      children: [{ type: 'element', tagName: 'span', properties: { className: ['code__lang'] }, children: [{ type: 'text', value: label }] }, button],
    };
    root.children = [{
      type: 'element', tagName: 'div',
      properties: { className: ['code', plain ? 'code--plain' : 'code--lang'], 'data-code': '' },
      children: [bar, pre],
    }];
  },
};
