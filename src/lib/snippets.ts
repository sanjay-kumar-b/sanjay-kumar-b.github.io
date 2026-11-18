// Code samples for the home-page terminal, highlighted at build time (no client-side highlighter needed).
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const KEYWORDS: Record<string, string[]> = {
  apex: ['trigger', 'on', 'before', 'after', 'insert', 'update', 'public', 'with', 'sharing', 'class', 'static', 'void', 'for', 'if', 'new', 'return'],
  js: ['import', 'from', 'export', 'default', 'class', 'extends', 'get', 'return', 'const', 'function', 'new'],
  ts: ['import', 'from', 'export', 'function', 'const', 'return', 'new'],
  sql: ['SELECT', 'FROM', 'WHERE', 'WITH', 'ORDER', 'BY', 'DESC', 'LIMIT', 'USER_MODE'],
};

/** Tiny tokenizer: comments, strings, numbers, keywords, Types (Capitalised), function(calls). Enough for 10-line samples. */
export function highlight(lang: keyof typeof KEYWORDS, code: string): string {
  const kw = new Set(KEYWORDS[lang]);
  const re = /(\/\/[^\n]*)|('(?:[^'\\]|\\.)*')|(\b\d+(?:\.\d+)?\b)|(@[A-Za-z]+)|([A-Za-z_][A-Za-z0-9_]*)(?=\()|([A-Za-z_][A-Za-z0-9_]*)/g;
  let out = '';
  let last = 0;
  for (const m of code.matchAll(re)) {
    out += esc(code.slice(last, m.index));
    last = m.index! + m[0].length;
    const [all, cm, str, num, deco, fn, word] = m;
    if (cm) out += `<span class="cm">${esc(cm)}</span>`;
    else if (str) out += `<span class="st">${esc(str)}</span>`;
    else if (num) out += `<span class="nu">${num}</span>`;
    else if (deco) out += `<span class="fn">${esc(deco)}</span>`;
    else if (fn) out += kw.has(fn) ? `<span class="kw">${fn}</span>` : `<span class="fn">${fn}</span>`;
    else if (word) out += kw.has(word) ? `<span class="kw">${word}</span>` : /^[A-Z]/.test(word) ? `<span class="ty">${word}</span>` : word;
    else out += esc(all);
  }
  return out + esc(code.slice(last));
}

export interface Snippet { id: string; label: string; file: string; lang: keyof typeof KEYWORDS; article: string; code: string }

export const SNIPPETS: Snippet[] = [
  {
    id: 'apex', label: 'Apex', file: 'AccountTrigger.trigger', lang: 'apex', article: 'trigger-handler-pattern',
    code: `// One trigger per object. Logic lives in the handler.
trigger AccountTrigger on Account (before insert, before update) {
    AccountHandler.run(Trigger.new);
}

public with sharing class AccountHandler {
    public static void run(List<Account> records) {
        for (Account a : records) {
            if (String.isBlank(a.Industry)) {
                a.Industry = 'Unclassified';
            }
        }
    }
}`,
  },
  {
    id: 'lwc', label: 'LWC', file: 'accountList.js', lang: 'js', article: 'lwc-lifecycle-and-wire',
    code: `import { LightningElement, wire } from 'lwc';
import getAccounts from '@salesforce/apex/AccountController.getAccounts';

export default class AccountList extends LightningElement {
    // Re-runs automatically when the data changes.
    @wire(getAccounts)
    accounts;

    get hasData() {
        return this.accounts?.data?.length > 0;
    }
}`,
  },
  {
    id: 'soql', label: 'SOQL', file: 'top-energy-accounts.soql', lang: 'sql', article: 'soql-best-practices',
    code: `SELECT Id, Name, AnnualRevenue,
       (SELECT LastName, Email FROM Contacts LIMIT 3)
FROM Account
WHERE Industry = 'Energy'
WITH USER_MODE
ORDER BY AnnualRevenue DESC
LIMIT 10`,
  },
  {
    id: 'react', label: 'React', file: 'useAccounts.ts', lang: 'ts', article: 'react-useeffect-data-fetching',
    code: `import { useEffect, useState } from 'react';

export function useAccounts(url: string) {
  const [data, setData] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    const ctl = new AbortController();
    fetch(url, { signal: ctl.signal })
      .then((r) => r.json())
      .then(setData)
      .catch(() => {});
    return () => ctl.abort();
  }, [url]);

  return data;
}`,
  },
];
