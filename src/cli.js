#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fetchHtml, openPage, walkPage, checkUrl } from './acquire.js';
import { prepare, extract, deduplicate } from './dom.js';
import { makePlan, validatePlan, instructions, plannerInput } from './planner.js';

const { values: args } = parseArgs({ options: {
  url: {type:'string'}, prompt: {type:'string'}, plan: {type:'string'}, html: {type:'string'},
  browser: {type:'boolean',default:false}, prepare: {type:'boolean',default:false},
  budget: {type:'string',default:'5000'}, 'max-steps': {type:'string',default:'200'},
  out: {type:'string',default:'result.json'}, model: {type:'string'}, help: {type:'boolean'}
} });
if (args.help || !args.url || !args.prompt) {
  console.log(`Usage: npm run scrape -- --url URL --prompt "Requested records and fields" [--browser]
  --prepare       Write compact LLM input and metrics without making a paid call
  --plan FILE     Replay an externally generated plan (zero LLM calls)
  --html FILE     Use saved HTML instead of fetching (cannot combine with --browser)
  --budget N      Maximum page-sample tokens (default 5000)
  --max-steps N   Browser traversal limit (default 200)
  --model NAME    Structured Outputs model (default OPENAI_MODEL or gpt-4o-mini)
  --out FILE      Output JSON (default result.json)`);
  process.exit(args.help ? 0 : 1);
}
let session;
try {
  const url = checkUrl(args.url);
  const budget = Number(args.budget), maxSteps = Number(args['max-steps']);
  if (!Number.isInteger(budget) || budget < 100 || !Number.isInteger(maxSteps) || maxSteps < 1)
    throw new Error('budget and max-steps must be positive integers; budget >= 100');
  if (args.html && args.browser) throw new Error('--html and --browser are mutually exclusive');
  session = args.html ? { html: await readFile(args.html, 'utf8'), url }
    : args.browser ? await openPage(url) : await fetchHtml(url);
  const prepared = prepare(session.html, budget);
  if (args.prepare) {
    await writeFile(args.out, JSON.stringify({ url: session.url, prompt: args.prompt, instructions,
      input: plannerInput(session.url, args.prompt, prepared.sample), ...prepared }, null, 2));
    console.log(`Prepared ${prepared.metrics.sampleTokens} page tokens from ${prepared.metrics.rawTokens} raw tokens → ${resolve(args.out)}`);
  } else {
    const { plan, usage } = args.plan ? { plan: validatePlan(JSON.parse(await readFile(args.plan,'utf8'))), usage: {calls:0, suppliedPlan:true} }
      : await makePlan({url:session.url, prompt:args.prompt, sample:prepared.sample, model:args.model});
    // Reject syntactically invalid selectors before traversal.
    let records = extract(session.html, plan, session.url);
    if (!records.length) throw new Error('Plan matched no populated records. Inspect --prepare input and replan.');
    const traversal = session.page ? await walkPage(session.page, plan, (html, pageUrl) => {
      const rows = extract(html, plan, pageUrl);
      records = deduplicate([...records, ...rows]);
      return rows;
    }, {maxSteps}) : {stopReason:'single-html', steps:1, pages:1};
    records = deduplicate(records);
    const result = { source:url, fetchedAt:new Date().toISOString(), prompt:args.prompt, count:records.length,
      records, plan, metrics:{ ...prepared.metrics, llm:usage, traversal },
      coverage: session.page ? 'All observed records through bounded browser traversal; inspect stopReason. Stability is not proof of server-side completeness.'
        : 'Only records in the fetched HTML. Use --browser for dynamic lists.' };
    await writeFile(args.out, JSON.stringify(result,null,2));
    console.log(`${records.length} records; ${usage.calls} LLM calls; ${traversal.stopReason} → ${resolve(args.out)}`);
    if (traversal.stopReason === 'max-steps' || traversal.stopReason === 'pagination-cycle') process.exitCode = 2;
  }
} catch (err) { console.error(err.message); process.exitCode = 1; }
finally { await session?.browser?.close(); }
