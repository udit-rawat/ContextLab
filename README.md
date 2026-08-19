# Context Lab

**Live: https://context-lab-drab.vercel.app**

I built context lab basically a benchmark harness to test repo context strategies side by side. you just point it at a codebase ask a question and see how 4 diff context strategies answer it with the real cost of each

---

## What i built and why

so superbrain's main claim is a 60 to 80 percent token reduction with no loss of repo awareness which is bonkers so i wanted to verify it myself instead of trusting marketing pages.
i picked this over making a generic quiz app cuz it actually engages with the tech claim. it runs on pure retrieval evals and token economics instead of me competing on ui polish.

just to be clear i didn't test superbrain's context engine as a black box here. i built my own 4 strategies and measured those. later on i read the actual artifact which i will discuss below.

the short version of what i found: **we can actually achieve 97.9% token reduction on my corpus. but honestly all 4 strategies are basically a tie on answer quality.** the real diff is cost not quality. question difficulty varied 4x more than the strategy choice did

one caveat before anyone compares that to their 60-80% number: mine is top-8 retrieval measured against naive full stuffing, on one repo, 14 questions. theirs is presumably an agent solving real issues measured against a different baseline. same units, different experiments, so i wouldn't read mine as beating theirs. what i'd say is that the shape of the result matches - big token cut, quality difference too small to call.

---

## The result

did 14 questions, 4 strategies, 56 runs. all data is in `results/benchmark.json`

- **Full stuffing:** 126,053 tokens | $0.0318 | 32.7x cost | 3.57 quality | 79% citation precision
- **Top-8 vector (baseline):** 2,655 tokens | $0.0010 | 1.0x cost | 3.50 quality | 90% citation precision
- **Retrieve + rerank:** 2,668 tokens | $0.0010 | 1.0x cost | 3.86 quality | 79% citation precision
- **Structure-aware:** 21,890 tokens | $0.0058 | 6.0x cost | 3.64 quality | 86% citation precision

### Everything is a tie (and i checked before comparing)

first thing i did was check the spread within each strategy before comparing them. standard deviation was 1.23 to 1.55. every gap between strategies is only 0.07 to 0.36.
so basically rerank vs baseline is +0.36 diff with 1.26 SD which is a **tie**. full stuffing vs baseline is +0.07 diff which is also a **tie** but at 32x the cost.

i want to be blunt about this cuz i could have easily lied and said "rerank improves quality by 10%" for the marketing but it would be wrong, the diff is inside the noise. what is NOT inside the noise is cost. top 8 retrieval uses 2655 tokens compared to 126k tokens for full stuffing. a 97.9% reduction for the same score.

### Full stuffing is dominated

its not just expensive its actually worse. 32x cost and lower citation precision (79 vs 90). both of the catastrophic failures in my run came from it:

- q f3 (oauth2 password flow) scored 0 cuz `fastapi/security/oauth2.py` wasn't even in the context window.
- q x4 scored 1 cuz it located the def incorrectly.

mechanism behind this is simple: full stuffing fills the 128k cap and **still cant see 31.4% of the repo**. 14 files never even enter the context like utils.py websockets.py etc. files get dropped by alphabetical path order not relevance which is a huge failure mode

### Question type flips the ranking

this is the finding i didn't expect.
on factual lookups retrieval wins easily (5.0 vs 3.60). but on architectural questions (like how do these 2 modules communicate) **full stuffing beats top 8 by 1.5 points.** breadth actually matters here and top 8 chunks just dont have the full picture.
sadly structure aware compression which i designed to fix this only scored 3.00 on architectural so it didn't buy back the breadth i hoped for. reporting this as a negative result cuz it is one.

---

## The 4 strategies

1. **Full stuffing** - just naive baseline concatenate whole files till 128k cap.
2. **Top-8 vector** - embed chunks cosine sim take top 8. this is what a standard dev builds so i used this as the fair baseline to measure against.
3. **Retrieve wide then rerank** - pull 30 rerank to 8 with one extra call.
4. **Structure-aware compression** - always include a compressed repo skeleton (file tree + signatures + docstrings) then add full bodies for retrieved chunks. i originally thought this is what superbrain did but i was wrong (more on that later).

---

## Running it

repo: https://github.com/udit-rawat/ContextLab

```bash
git clone https://github.com/udit-rawat/ContextLab.git
cd ContextLab
npm ci
npm run dev
```

**you dont need api keys to see the results.** the whole benchmark is precomputed and committed so the site just reads `results/benchmark.json`. keys are only for live query mode, copy `.env.example` to `.env` and fill in 3 free keys (2 gemini 1 groq) then `npm run smoke` to check they work.

to regenerate everything from scratch:

```bash
npm run corpus      # vendor fastapi at the pinned commit
npm run index       # chunk + embed -> data/index.json
npm run fullstuff   # compute the exact 128k cut -> data/fullstuff.json
npm run bench       # 14 questions x 4 strategies -> results/benchmark.json
npm run analyze     # spits out the numbers in this readme
```

two scripts exist purely so i cant fool myself:

- `npm run verify-parser` diffs my python parser against pythons own `ast` module over all 48 files. fails if they disagree on any symbol.
- `npm run verify-doc` asserts every number in this readme against the committed json. if i edit a number by hand and it doesn't match the data it exits 1.

corpus is fastapi pinned at commit `66b2c5a9b5ddf65f218423072ad158e42ed780aa`, 48 files, 183,648 tokens. answerer is `gemini-3.1-flash-lite` ($0.25/M in, $1.50/M out), embeddings `gemini-embedding-001` at 768 dims, judge is `openai/gpt-oss-120b` on groq. context cap 128,000 tokens applied to every strategy. whole thing ran on free tiers, total spend $0.00 — the costs above are list prices applied to measured token counts.

this is only benchmarked on fastapi but its not hardcoded to it. swap the `CORPUS` block in `config/models.ts` to any python repo + commit and re-run the pipeline above, it'll rebuild the index and skeleton for that repo. two catches though - `lib/python.ts` only parses python so a ts/go repo needs a different structural parser, and `eval/questions.json` is fastapi-specific so a new corpus needs its own golden set before the numbers mean anything.

---

## Architecture decisions and what i rejected

everything is in `config/models.ts` so anyone can verify without api keys.

**precomputed the benchmark** - this was a major call. vercel has hard timeouts and full stuffing takes 33s so doing 4 sweeps live would fail. deployed site loads instantly and shows real results without burning keys. live mode is just for single queries fanned out in parallel from the browser.

**embeddings precomputed as json** - 744 chunks at 768 dims is roughly 2.3M multiply adds which runs in ms in plain JS. rejected using vector db cuz its overkill for hundreds of chunks and adds a dumb dependency. truncated to 768 dims so the file is only 3.8mb and i can just commit it to github.

**chunking on symbol boundaries** - fixed 400 token windows cut thru middle of functions so chunks lose context. i split on def/class boundaries so the model can actually reason about the symbol.

**token counting via gemini tokenizer** - started with gpt-tokenizer but found out it undercounts gemini by 19.35%. i binary searched the exact cut using geminis countTokens endpoint so full stuffing lands at 125,917 genuinely under cap.

**answerer is gemini-3.1-flash-lite** - emits zero reasoning tokens so cost is deterministic. 3.6 flash returned 503s and burned reasoning tokens which messed up my cost math. also a stronger model answers fastapi questions from its own weights which compresses all 4 strategies into noise so lighter model is better for testing context.

**judge is gpt-oss-120b on groq** - used a diff family model to avoid self preference bias. judge gets question reference ans and candidate but doesn't know which strategy produced it.

---

## Understanding the product (Superbrain)

installed superbrain to see what they actually do instead of reading the landing page. its a vs code fork running claude code extension.
there context engine is literally a file it writes at `.superbrain/manifest.md`.

measured it against my stuff:

- superbrain manifest: 1549 tokens (93 file paths and a few tags)
- my skeleton: 16,517 tokens (signatures and docstrings)
- full fastapi repo: 183,648 tokens

so the manifest is literally just a file inventory with 0 symbols 0 signatures 0 docstrings.
i want to be fair here, priming an agent with a map of what exists is a smart minimum cuz it survives any model and cuts down agent blind searching. when i asked claude code without a manifest it did 3 tool calls (grep retry sed) just to find one function. manifest fixes that flailing.
this also means my strategy 4 wasn't a reconstruction of them at all since my skeleton is 10x richer.

## What i would change/add for them

1. **put symbols in the manifest** - the manifest tells agent what files exist but not whats inside. for architectural questions the agent is back to searching blind. my skeleton cost 16k tokens for 48 files, for them a signature only index would be under 10k tokens which is a rounding error for 200k windows.
2. **show the user whats in the window** - the compression is invisible so when it guesses wrong user has no idea why.
3. **benchmark agentic honestly** - they compare superbrain against claude code but superbrain _runs_ claude code. so the real benchmark is claude code with manifest vs without. they should just say that plainly it makes it more credible.

## UI and product issues i found

all reproducible stuff i hit in the first hour:

1. **extension install failed** with invalid signature error. this is the worst possible place for a bug cuz the user has zero context to debug it and no reason to trust the app after. a signature warning specifically reads as "this software might be tampered with", so the natural reaction is to quit and not come back.
2. **exposed raw backend IP** and internal domain in the sign in popup. i'm calling this information disclosure not a vulnerability cuz i didn't test whether anything is exploitable and i'm not claiming impact i can't show. but a bare IP in an auth flow means the endpoint isn't behind a domain or proxy, and any user who notices it trusts the product less with their code. flagging it here cuz the question asked what i disliked, but this is the kind of thing i'd normally report privately over email rather than write up in a public doc.
3. **rate limit error contradiction** - UI told me my gemini quota is exhausted go enable billing, but the actual api error in the same message said wait 23s. so dumb a user would just leave. worse, some fraction of them go add a card for a limit they'd have cleared by waiting half a minute.
4. **model list offers dead models** - 2.5 flash returned no longer available error. to be fair that's google deprecating access, not their bug. but the picker is offering a choice it can't fulfil and the user only finds out by failing, so it reads as the product being broken rather than the model being gone.

every issue was a setup time problem. i spent my first hour fighting quota messages and signature errors instead of evaluating the context compression

## Things that surprised me

**skeleton was 48% of the repo** before i compacted it cuz fastapi annotates parameters with huge prose strings. reducing to structure only brought it down to 10.8%.
**writing a python parser in typescript is a trap** - took 5 fixes to get it right. stuff like trailing comments breaking signatures, docstrings messing up bracket counting, protocol stubs with inline bodies.
**judge silently produced garbage at first** - gpt oss 120b is a reasoning model so it spent all its completion tokens thinking. at max_tokens 200 it consumed the whole budget and gave me empty verdicts. took a while to realize the response cache was just serving back broken verdicts cuz the cache key didn't change.
