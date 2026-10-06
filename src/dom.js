import * as cheerio from 'cheerio';
import { getEncoding } from 'js-tiktoken';
import { createHash } from 'node:crypto';

const encoding = getEncoding('cl100k_base');
export const tokens = text => encoding.encode(text).length;
export const hash = text => createHash('sha256').update(text).digest('hex');
export const normalize = text => String(text ?? '').replace(/\s+/g, ' ').trim();

// Retain attributes useful for CSS plans, but drop styling, tracking and scripts.
export function compact(html, { samples = 3 } = {}) {
  const $ = cheerio.load(html);
  $('script,style,svg,canvas,noscript,iframe,template,head').remove();
  $('*').each((_, el) => {
    for (const attr of Object.keys(el.attribs ?? {})) {
      if (!['class','id','href','src','alt','title','role','name','type','value','rel'].includes(attr)
        && !attr.startsWith('aria-') && !attr.startsWith('data-')) $(el).removeAttr(attr);
      if (attr.startsWith('data-') && !['data-framer-name','data-testid'].includes(attr)) $(el).removeAttr(attr);
    }
    if (el.attribs?.src?.startsWith('data:')) $(el).removeAttr('src');
  });
  // Repeated sibling structure is represented by first N and last examples.
  function visit(el) {
    const groups = new Map();
    for (const child of $(el).children().toArray()) {
      const signature = `${child.tagName}.${child.attribs?.class ?? ''}:${$(child).children().map((_, c) => c.tagName).get().join(',')}`;
      if (!groups.has(signature)) groups.set(signature, []);
      groups.get(signature).push(child);
    }
    for (const group of groups.values()) {
      const kept = group.length > samples + 1 ? [...group.slice(0, samples), group.at(-1)] : group;
      for (const child of group) if (!kept.includes(child)) $(child).remove();
      kept.forEach(visit);
    }
  }
  visit($('body')[0]);
  const output = $('body').html() ?? '';
  return output.replace(/<!--[^]*?-->/g, '').replace(/>\s+</g, '><').trim();
}

export function prepare(html, budget = 5000) {
  let sample;
  for (const samples of [3, 2, 1]) {
    sample = compact(html, { samples });
    if (tokens(sample) <= budget) break;
  }
  if (tokens(sample) > budget) {
    throw new Error(`Page sample exceeds ${budget} tokens. Increase --budget; content was not silently truncated.`);
  }
  return { sample, metrics: { rawBytes: Buffer.byteLength(html), rawTokens: tokens(html), sampleTokens: tokens(sample) } };
}

export function extract(html, plan, url) {
  const $ = cheerio.load(html);
  const records = [];
  $(plan.recordSelector).each((_, record) => {
    const row = Object.create(null);
    for (const field of plan.fields) {
      const scope = $(record);
      const element = field.selector ? scope.find(field.selector).first() : scope;
      let value = field.attribute === 'text' ? element.text() : element.attr(field.attribute);
      value = normalize(value);
      if (value && ['href','src'].includes(field.attribute)) {
        try { value = new URL(value, url).href; } catch { value = ''; }
      }
      row[field.name] = value || null;
    }
    if (Object.values(row).some(v => v !== null)) records.push(row);
  });
  return records;
}

export function deduplicate(rows) {
  return [...new Map(rows.map(row => [JSON.stringify(row), row])).values()];
}
