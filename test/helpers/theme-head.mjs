import { createContext, runInContext } from 'node:vm';

export function paletteRules(html) {
  return [...html.matchAll(/:root(?:\[data-theme="([^"]+)"\])?\s*\{([^}]+)\}/g)].map(([, theme, body]) => ({
    theme,
    values: [...body.matchAll(/^\s*(--[\w-]+|color-scheme):\s*(.+);\s*$/gm)].map(([, name, value]) => [name, value]),
  }));
}

// Reveal head elements in parser order rather than inventing a theme-color meta.
export function themeHead(html, theme, blocked = false) {
  const links = new Map();
  const metas = [];
  const rules = [];
  const document = {
    get cookie() { if (blocked) throw new Error('Cookies unavailable'); return theme ? `lakearrowhead_theme=${theme}` : ''; },
    documentElement: { dataset: { theme: 'deep-lake-lodge' } },
    getElementById: id => links.get(id),
    querySelector: selector => selector === 'meta[name="theme-color"]' ? metas.find(meta => meta.name === 'theme-color') ?? null : null,
    createElement: () => ({}),
    head: { append(link) { links.set(link.id, link); } },
  };
  const window = {};
  const computed = element => {
    const values = new Map();
    // A themed selector outranks :root even when the base rule comes later.
    for (const themed of [false, true]) for (const rule of rules) {
      if (Boolean(rule.theme) === themed && (!themed || rule.theme === element.dataset.theme)) {
        for (const [name, value] of rule.values) values.set(name, value);
      }
    }
    return { getPropertyValue: name => values.get(name) ?? '' };
  };
  const context = createContext({ document, window, getComputedStyle: computed });
  const head = html.slice(0, html.indexOf('</head>'));
  for (const [token] of head.matchAll(/<meta\b[^>]*>|<style\b[^>]*>[\s\S]*?<\/style>|<script\b[^>]*>[\s\S]*?<\/script>/g)) {
    if (token.startsWith('<meta')) {
      metas.push(Object.fromEntries([...token.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value])));
    } else if (token.startsWith('<style')) rules.push(...paletteRules(token));
    else if (/id="theme-(?:fonts|color)"/.test(token)) {
      runInContext(token.slice(token.indexOf('>') + 1, token.lastIndexOf('</script>')), context);
    }
  }
  return { links, metas, document, window, context, computed };
}
