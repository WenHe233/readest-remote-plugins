import { load } from 'cheerio/slim';
import { DOMParser } from '@xmldom/xmldom';
import xpath from 'xpath';
import { JSONPath } from 'jsonpath-plus';
import safeRegex from 'safe-regex2';
import { unsupported } from './types';

/** Splits operators outside selectors, quoted strings and template expressions. */
export function splitOutside(input: string, operator: string): string[] {
  let start = 0,
    depth = 0,
    quote = '';
  const output: string[] = [];
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quote) {
      if (char === quote && input[i - 1] !== '\\') quote = '';
      continue;
    }
    if ('"\'`'.includes(char)) {
      quote = char;
      continue;
    }
    if ('[({'.includes(char)) depth++;
    if ('])}'.includes(char)) depth--;
    if (!depth && input.startsWith(operator, i)) {
      output.push(input.slice(start, i));
      start = i + operator.length;
      i += operator.length - 1;
    }
  }
  output.push(input.slice(start));
  return output;
}

function css(rule: string) {
  return rule.replace(
    /^(class|id|tag)\.([^@]+)$/,
    (_, kind, name) =>
      (kind === 'class' ? '.' : kind === 'id' ? '#' : '') + name,
  );
}
export function parseRule(
  input: string,
  rule: string,
  elements = false,
): string[] {
  if (input.length > 4 * 1024 * 1024 || rule.length > 65536)
    throw new Error('Rule input limit exceeded');
  if (!rule) return [input];
  const fallbacks = splitOutside(rule, '||');
  if (fallbacks.length > 1) {
    for (const part of fallbacks) {
      const values = parseRule(input, part, elements);
      if (values.some(Boolean)) return values;
    }
    return [];
  }
  const concat = splitOutside(rule, '&&');
  if (concat.length > 1)
    return concat.flatMap((part) => parseRule(input, part, elements));
  const interleave = splitOutside(rule, '%%');
  if (interleave.length > 1) {
    const parts = interleave.map((part) => parseRule(input, part, elements));
    return Array.from(
      { length: Math.max(...parts.map((p) => p.length)) },
      (_, i) => parts.flatMap((p) => (p[i] === undefined ? [] : [p[i]])),
    ).flat();
  }
  const [selector, pattern, replacement = ''] = rule.split('##');
  if (pattern !== undefined) {
    if (!safeRegex(pattern))
      return unsupported('Regular expression exceeds safe complexity');
    return parseRule(input, selector, elements).map((value) =>
      value.replace(new RegExp(pattern, 'g'), replacement),
    );
  }
  if (selector.startsWith('@js:') || selector.includes('<js>'))
    return unsupported('JavaScript rules require the sandbox evaluator');
  if (/^[\[{]/.test(input.trim()) && /^[A-Za-z_][\w.[\]*'-]*$/.test(selector)) {
    return parseRule(input, '$.' + selector, elements);
  }
  if (
    selector.startsWith('@Json:') ||
    selector.startsWith('$.') ||
    selector.startsWith('$[')
  ) {
    const values = JSONPath({
      path: selector.replace(/^@Json:/, ''),
      json: JSON.parse(input),
      eval: false,
      wrap: true,
    }) as unknown[];
    return (
      elements ? values.flatMap((v) => (Array.isArray(v) ? v : [v])) : values
    ).map((v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v)));
  }
  if (selector.startsWith('//') || selector.startsWith('@XPath:')) {
    const normalized = load(input, { xmlMode: false }).xml();
    const doc = new DOMParser().parseFromString(
      '<readest-root>' +
        normalized.replace(/<!DOCTYPE[^>]*>/gi, '') +
        '</readest-root>',
      'text/xml',
    );
    const result = xpath.select(selector.replace(/^@XPath:/, ''), doc as any);
    return (Array.isArray(result) ? result : [result]).map((node: any) =>
      typeof node === 'object'
        ? node.nodeType === 2
          ? node.value
          : elements
            ? node.toString()
            : node.textContent
        : String(node),
    );
  }
  if (selector.startsWith(':')) {
    if (!safeRegex(selector.slice(1)))
      return unsupported('Regular expression exceeds safe complexity');
    return Array.from(
      input.matchAll(new RegExp(selector.slice(1), 'g')),
      (m) => m[0],
    );
  }
  const $ = load(input, { xmlMode: false }, false);
  let current = $.root().children();
  const steps = splitOutside(selector.replace(/^@@|^@css:/, ''), '@')
    .map((step) => step.trim())
    .filter(Boolean);
  const terminal = steps.at(-1) ?? '';
  const hasAttribute =
    !elements &&
    (steps.length > 1 ||
      /^@[^:]+$/.test(selector) ||
      [
        'text',
        'textNodes',
        'ownText',
        'html',
        'all',
        'href',
        'src',
        'content',
      ].includes(terminal));
  if (hasAttribute) steps.pop();
  for (const rawStep of steps) {
    if (['text', 'textNodes', 'ownText', 'html', 'all'].includes(rawStep))
      break;
    let step = rawStep;
    let index: number | undefined;
    const slice = /^(.*?)\[(-?\d+)(?::(-?\d+))?\]$/.exec(step);
    if (slice) step = slice[1];
    const match = /^(.*)\.(-?\d+)$/.exec(step);
    if (match) {
      step = match[1];
      index = Number(match[2]);
    }
    const select = css(step);
    const matching =
      step === 'children'
        ? current.children()
        : step.startsWith('text.')
          ? current
              .find('*')
              .filter((_, node) => $(node).text().includes(step.slice(5)))
          : current.filter(select).add(current.find(select));
    current = index === undefined ? matching : matching.eq(index);
    if (slice) {
      const start = Number(slice[2]);
      if (slice[3] === undefined) current = current.eq(start);
      else {
        const end = Number(slice[3]);
        const values = current.toArray();
        const normalize = (n: number) => (n < 0 ? values.length + n : n);
        const a = normalize(start),
          b = normalize(end);
        current = $(
          a > b ? values.slice(b, a + 1).reverse() : values.slice(a, b + 1),
        );
      }
    }
  }
  return current.toArray().map((node) => {
    const element = $(node);
    if (elements || terminal === 'all') return $.html(element);
    if (terminal === 'html') return element.html() ?? '';
    if (terminal === 'ownText' || terminal === 'textNodes')
      return element
        .contents()
        .filter((_, child) => child.type === 'text')
        .text()
        .trim();
    if (hasAttribute && !['text', 'html'].includes(terminal))
      return element.attr(terminal.replace(/^abs:/, '')) ?? '';
    return element.text().trim();
  });
}

/** Lightweight DOM bridge: objects remain entirely outside the guest heap. */
export class HtmlBridge {
  private nextId = 1;
  private nodes = new Map<
    number,
    { $: ReturnType<typeof load>; value: ReturnType<ReturnType<typeof load>> }
  >();
  call(method: string, args: any[]): unknown {
    if (method === 'parse') {
      const $ = load(String(args[0]), { xmlMode: false });
      return this.keep($, $.root());
    }
    const id = Number(args[0]);
    const entry = this.nodes.get(id);
    if (!entry) throw new Error('HTML node was disposed');
    const { $, value } = entry;
    switch (method) {
      case 'query':
        return value
          .find(String(args[1]))
          .toArray()
          .map((n) => this.keep($, $(n)));
      case 'children':
        return value
          .children()
          .toArray()
          .map((n) => this.keep($, $(n)));
      case 'nodes':
        return value
          .contents()
          .toArray()
          .map((n) => this.keep($, $(n)));
      case 'parent':
        return value.parent().length ? this.keep($, value.parent()) : null;
      case 'previousSibling':
        return value.prev().length ? this.keep($, value.prev()) : null;
      case 'nextSibling':
        return value.next().length ? this.keep($, value.next()) : null;
      case 'text':
        return value.text();
      case 'innerHtml':
        return value.html();
      case 'attributes':
        return value.attr() ?? {};
      case 'localName':
        return (value[0] as any)?.name ?? '';
      case 'type':
        return value[0]?.type === 'tag'
          ? 'element'
          : (value[0]?.type ?? 'unknown');
      case 'dispose':
        this.nodes.delete(id);
        return null;
      default:
        return unsupported(`Html.${method}`);
    }
  }
  private keep($: ReturnType<typeof load>, value: any) {
    if (this.nodes.size >= 50_000) throw new Error('HTML node limit exceeded');
    const id = this.nextId++;
    this.nodes.set(id, { $, value });
    return id;
  }
}
