# Context Lab

**Live: https://context-lab-drab.vercel.app**

A benchmark harness for repository context strategies. Point it at a codebase, ask a question, and see the same question answered under four different context strategies side by side, with the real cost of each.

---

## What I built and why

Superbrain's central claim is a 60 to 80 percent token reduction with no loss of repository awareness. I wanted to understand how you would actually verify a claim like that, so I built the harness that measures it.

I picked this over a quiz app or a game for a few reasons. It engages with the actual technical claim rather than the marketing page. It runs on retrieval, evals and token economics rather than making me compete on generic full-stack polish. And it is adjacent rather than competitive — I am not rebuilding anyone's moat in a day, I am building the instrument that measures it.

**What this is not.** I did not test Superbrain's context engine as a black box, and nothing here is a measurement of their product. I built my own four strategies and measured those. Where I do talk about Superbrain below, it is from reading the artifact it wrote into my repo, which I say explicitly.

The short version of what I found: **the achievable token reduction on my corpus is 97.9%, which is well above the claim. But none of the four strategies differ from each other on answer quality by more than noise.** The interesting result is not which strategy wins. It is that question difficulty varies about four times more than strategy choice does, so the honest answer is "tie", and the real decision is cost.

---

## The result

14 questions, 4 strategies, 56 runs. Every number below comes from `results/benchmark.json`, regenerable with `npm run bench`.

| Strategy | Context tokens | Cost/query | vs baseline | Quality (0-5) | SD | Citation P | Citation R | Latency |
|---|---|---|---|---|---|---|---|---|
| Full stuffing | 126,053 | $0.031833 | **32.7x** | 3.57 | 1.55 | 79% | 79% | 12.3s |
| **Top-8 vector** (baseline) | 2,655 | $0.000973 | 1.0x | 3.50 | 1.29 | **90%** | 89% | 6.8s |
| Retrieve + rerank | 2,668 | $0.001005 | 1.0x | **3.86** | 1.23 | 79% | **94%** | 9.6s |
| Structure-aware | 21,890 | $0.005819 | 6.0x | 3.64 | 1.34 | 86% | 92% | 6.0s |

### Everything is a tie, and I checked that before comparing anything

The first thing the analysis does — before any strategy is compared to any other — is compute the question-to-question spread *within* each strategy. Those standard deviations are 1.23 to 1.55.

Every gap *between* strategies is 0.07 to 0.36.

| Comparison | Quality difference | Pooled SD | Verdict |
|---|---|---|---|
| Full stuffing vs baseline | +0.07 | 1.43 | **tie**, at 32.7x cost |
| Retrieve + rerank vs baseline | +0.36 | 1.26 | **tie**, at 1.0x cost |
| Structure-aware vs baseline | +0.14 | 1.31 | **tie**, at 6.0x cost |

I want to be blunt about this because it would have been easy to hide: if I had reported "rerank improves quality by 10%" that would have looked like a finding and it would have been wrong. The differences are inside the noise. On this corpus, with this model, these strategies are indistinguishable on quality.

What is *not* inside the noise is cost. Top-8 retrieval uses 2,655 tokens where full stuffing uses 126,053 — a **97.9% reduction** — and scores the same. That is the actual result.

### Full stuffing is dominated

It is not just expensive, it is worse. 32.7x the cost, and lower citation precision (79% vs 90%) than the cheapest strategy. Both of the catastrophic answers in the whole run came from it:

- **Question f3 (OAuth2 password flow): scored 0.** `fastapi/security/oauth2.py` is not in its context window at all, so it answered that the information was not available. The three retrieval strategies all scored 100% citation precision on the same question.
- **Question x4 (`include_router`): scored 1.** It located the definition incorrectly.

This is the mechanism, and it is worth being concrete: full stuffing fills the entire 126,000 token budget, and **still cannot see 31.4% of the repository**. 31 files go in whole, `fastapi/routing.py` is cut mid-file at 66,876 characters, and **14 files never enter the context at all** — the entire `security/` package, plus `utils.py`, `websockets.py`, `testclient.py`, `staticfiles.py`, `templating.py`, `sse.py` and `types.py`.

The files that get dropped are determined by alphabetical path order, not relevance. That is the naive baseline's real failure mode.

### The two metrics disagree, and that is interesting

I scored two ways deliberately, because one metric is a single point of failure.

- **Retrieve + rerank** has the best quality (3.86) but tied-worst citation precision (79%).
- **Top-8 vector** has the best citation precision (90%) but the lowest quality (3.50).

They rank the strategies differently. If I had optimised either one alone I would have picked a different winner. Since both are inside the noise band anyway, the honest reading is that neither metric separates these strategies — but the disagreement is exactly why reporting one number would have been misleading.

### Question type flips the ranking

This is the finding I did not expect.

| Question type | Full stuffing | Top-8 | Rerank | Structure-aware |
|---|---|---|---|---|
| Factual (n=5) | 3.60 | 4.80 | **5.00** | 4.80 |
| Cross-file (n=5) | 3.00 | 2.80 | 2.60 | 3.00 |
| Architectural (n=4) | **4.25** | 2.75 | 4.00 | 3.00 |

Retrieval wins comfortably on factual lookup. But on architectural questions — "how do these two modules communicate", "how does FastAPI isolate itself from Pydantic version differences" — **full stuffing beats top-k retrieval by 1.5 points**. Breadth genuinely helps when the question spans the whole system, and top-8 chunks simply do not contain enough of the picture.

The uncomfortable part: structure-aware compression is the strategy specifically designed to fix that, and it scored 3.00 on architectural questions — worse than full stuffing and barely above top-k. On this corpus, the skeleton did not buy back the breadth it was supposed to. I am reporting that as a negative result because it is one. (These are 4-5 questions per cell, so this is directional, not conclusive.)

---

## The four strategies

1. **Full stuffing** — concatenate whole files in path order until the 128k cap, truncate the rest. The naive baseline. Not a straw man for the cost ceiling, but genuinely what "just give the model everything" costs.
2. **Top-8 vector** — embed chunks, cosine similarity, take the top 8. This is what most people actually build, so **this is the fair baseline and every improvement is measured against it**, not against full stuffing.
3. **Retrieve wide then rerank** — pull 30 candidates, rerank down to 8 with one extra model call.
4. **Structure-aware compression** — always include a compressed repo skeleton (file tree plus signatures and docstrings, no bodies), then add full bodies only for retrieved chunks. I originally built this as my guess at what a context engine does. Having since read Superbrain's actual manifest, that guess was wrong — see below — but the strategy is still worth measuring on its own terms, and it is the only one of the four that tries to buy breadth cheaply.

---

## Reproducing this

```bash
git clone https://github.com/udit-rawat/ContextLab.git
cd ContextLab
npm ci

cp .env.example .env      # then fill in three free API keys
npm run smoke             # validates keys, models, and token accounting

npm run dev               # the site, reading committed results
```

The site runs from committed data. **You do not need API keys to see the results** — only to use live query mode.

To regenerate everything from scratch:

```bash
npm run corpus            # vendor FastAPI at the pinned commit
npm run index             # chunk + embed -> data/index.json
npm run fullstuff         # compute the exact 128k cut -> data/fullstuff.json
npm run bench             # run 14 questions x 4 strategies -> results/benchmark.json
npm run analyze           # the numbers in this document
npm run verify-parser     # checks the Python parser against Python's own ast
```

### Pinned setup

| | |
|---|---|
| Corpus | FastAPI, `fastapi/**/*.py`, commit `66b2c5a9b5ddf65f218423072ad158e42ed780aa` |
| Corpus size | 48 files, **183,648 tokens** (Gemini's tokenizer) |
| Answerer | `gemini-3.1-flash-lite` — $0.25/M in, $1.50/M out |
| Embeddings | `gemini-embedding-001` at 768 dimensions — $0.15/M |
| Judge | `openai/gpt-oss-120b` on Groq — $0.15/M in, $0.60/M out |
| Context cap | 128,000 tokens, applied to every strategy |
| Chunks | 744, median 199 tokens |

**The entire benchmark ran on free tiers. Total spend: $0.00.** Reported costs are published list prices applied to measured token counts — what these queries would cost in production. Prices were checked on 18 Aug 2026 and are recorded in `config/models.ts` with source links.

---

## Architecture, and the alternatives I rejected

Every number a reviewer might check lives in `config/models.ts`, committed, so it can be verified without holding any API key.

**Next.js App Router on Vercel.** Required by the assignment. API routes handle retrieval and the model call.

**The full benchmark is precomputed and committed; live mode is single query only.** This is the most important call in the build. Vercel functions have a hard timeout and full stuffing alone took 33 seconds in testing — a four-strategy sweep cannot happen inside one request. So the deployed site loads instantly, shows real results without burning an API key, and cannot break from a rate limit. Live mode exists so a reviewer can try their own question.

*Rejected:* running the sweep live. It would time out. *Also rejected:* streaming, which would work but is a bigger failure surface than precomputing, for a page whose main job is to show finished numbers reliably.

**Live mode runs one strategy per request, fanned out in parallel from the browser.** Four requests, each comfortably inside the timeout, results filling in as they land. It also gives honest per-strategy latency and degrades to three results instead of zero if one strategy fails.

**Embeddings precomputed at build time, committed as JSON.** 744 chunks at 768 dimensions is roughly 2.3M multiply-adds per query, which runs in single-digit milliseconds in plain JavaScript — faster than a network round trip to a hosted vector store.

*Rejected:* a vector database. It earns its place at millions of chunks, not hundreds. Here it would add a service to provision, a dependency to break, and an index a reviewer cannot read.

**Embeddings truncated to 768 dimensions.** The default 3072 would make the committed index about 47 MB. At 768, stored as base64 float32, it is 3.8 MB — small enough to commit, which is what makes the whole thing reproducible.

**Chunking on symbol boundaries, not fixed windows.** A fixed 400-token window cuts through the middle of functions, so retrieved chunks routinely open mid-body with no signature. Splitting on `def`/`class` boundaries means every chunk is a unit a model can reason about, and can name the symbol it came from — which is what makes citation scoring possible at all.

**Token counting from Gemini's own tokenizer, not an estimate.** I started with `gpt-tokenizer`. My first full-stuffing call came back at **151,659 tokens against a stated 128,000 cap** — `gpt-tokenizer` under-counts Gemini by **19.35%** on this corpus. The stated methodology was not the one being applied. Now `scripts/build-fullstuff.ts` binary-searches the exact cut using Gemini's `countTokens` endpoint and commits a deterministic plan, so full stuffing lands at 125,917 tokens, genuinely under cap.

This is also why the corpus is described as 183,648 tokens rather than the 153,531 that `gpt-tokenizer` reports. Both numbers are in `corpus/manifest.json` and `data/fullstuff.json`.

**The answerer is a small model on purpose.** `gemini-3.1-flash-lite` emits **zero reasoning tokens** (asserted in `npm run smoke`), so cost reproduces exactly run to run. `gemini-2.5-flash` is closed to new accounts; `gemini-3.6-flash` returned 503 under load and burned 205 reasoning tokens on a one-token prompt, which would have made cost non-deterministic.

There is also a methodological reason: a stronger model answers FastAPI questions correctly almost regardless of what you retrieve, which compresses all four strategies into noise. A lighter model is more sensitive to context quality. *(Given that everything came out a tie anyway, this choice arguably did not go far enough — see limitations.)*

**The judge is a different model family from the answerer.** Groq's `gpt-oss-120b` grades Gemini's answers. Self-preference is a real effect and a same-family judge would quietly inflate whichever strategy the answerer favours. The judge also never sees which strategy produced an answer — it gets the question, a reference answer, and one candidate.

**A response cache keyed on (model, prompt, params).** The free tier allows roughly 250 answer requests a day and a full run is 56, so an uncached rerun after a one-line change would burn a fifth of the daily budget. With the cache, changing one strategy re-runs only that strategy. On serverless it writes to `/tmp`, because everything else is read-only.

---

## Evaluation design

**14 questions** in `eval/questions.json`, across three types: 5 factual, 5 cross-file, 4 architectural. Cross-file and architectural questions are where strategies separate; pure lookups make everything look equal.

Every question carries an `expectedFiles` list, a reference answer, and a **`verify` field with `file:line` pointers** into the pinned commit, so each reference answer can be checked against the source in seconds rather than taken on trust.

**Two scoring methods, both reported.**
1. **Rubric judge**, 0-5, with the rubric written out in full in `lib/judge.ts` — not described, written, so the actual instrument is readable.
2. **Citation precision and recall** — did the answer name the right files.

**The spread is computed before anything is compared.** `scripts/analyze.ts` prints the within-strategy standard deviation as step 1 and only then compares strategies. Any gap smaller than the pooled SD of the pair is reported as a tie. That rule is stated here and applied in the code; the word "tie" appears in the output and on the site.

**Improvements are measured against Top-8 retrieval**, which is what a competent engineer builds by default. Full stuffing is there to establish the cost ceiling, not to flatter the numbers.

---

## Understanding the product

I installed Superbrain and looked at what it actually is, because the assignment asks how the three components interact and I would rather answer that from evidence than from the landing page.

- **IDE**: a VS Code fork, `Superbrain IDE 1.121.0-beta`.
- **Agent**: `anthropic.claude-code` version 2.1.235, installed from the marketplace. It is the only extension present, and it is unmodified. The default model in `settings.json` was `claude-opus-4-8`.
- **Context engine**: a file it writes at `.superbrain/manifest.md`.

That manifest is the interesting part, so I measured it against my own artifacts:

| | Tokens | What it contains |
|---|---|---|
| Superbrain `manifest.md` | **1,549** | 93 file paths, sizes, and a `[source]`/`[config]`/`[docs]` tag |
| My structure-aware skeleton | 16,517 | signatures and docstrings for 48 files |
| Full FastAPI corpus | 183,648 | everything |

For a 5.1 MB, 93 file project the whole manifest is 1,549 tokens. It contains **zero symbols, zero signatures, zero docstrings and no import or call graph**. It is a file inventory.

I want to be fair about this, because "it is just a file listing" is the cheap read and I do not think it is the right one. Priming an agent with a map of what exists is a genuinely sensible minimum: it is almost free, it survives any model, and it should measurably cut the blind searching that agents otherwise do. When I asked Claude Code a question about this repo without a manifest, its first action was a `grep` that failed on a bad flag, then a retry, then a `sed` — three tool calls to find one function. A manifest plausibly removes most of that flailing, and their published benchmark (64% fewer tokens, 7 bugs fixed against Claude Code's 8, which they themselves call "too close to call at ten issues") is consistent with exactly that mechanism.

It also means my Strategy 4 was never a reconstruction of their approach. My skeleton is **10.7x richer** than what they ship. Their approach is closer to "manifest plus agentic on-demand reads", which is a fifth strategy my benchmark does not measure — and in hindsight is the one I would most want to add.

## 3A. What I would change or add next

**Put symbols in the manifest.** This is the one change I would make first, and my own numbers are the argument for it.

The manifest tells an agent which files exist. It does not tell it what is inside any of them. So for any question that names a symbol rather than a file — "where is `solve_dependencies` called from" — the manifest cannot help, and the agent is back to searching blind. That is precisely the category where my benchmark shows thin context failing: on architectural questions, top-8 retrieval scored **2.75** while full context scored **4.25**. Breadth matters exactly where a path-only index has nothing to offer.

A signature-only manifest is cheap. My skeleton costs 16,517 tokens for 48 Python files, and that number is inflated by FastAPI documenting inside its type annotations; compacted to structure only it was 10.8% of the corpus. For a 93 file project, a signatures-only index should land under 10k tokens — a rounding error against a 200k window, and it turns "which files exist" into "which files contain what".

**Second: show the user what is in the window.** The compression is the product, and it is currently invisible. I could not tell, at any point, what the engine had decided was relevant, which means when it guesses wrong the user has no idea why the answer is bad or what to correct. The "what made it into the window" view on this site is my sketch of what that could look like — which files entered context versus the repo total. For a product whose entire pitch is context selection, making that legible seems like the highest-value UI work available.

**Third: benchmark the agentic strategy honestly.** Their published comparison is Superbrain against Claude Code, but Superbrain *runs* Claude Code. So the comparison is really "Claude Code with a manifest" against "Claude Code without one", which is a clean and interesting experiment — and I think saying so plainly would make the benchmark more credible, not less. Attributing the 64% to a manifest is a stronger claim than attributing it to an unspecified proprietary engine, because it is falsifiable.

## 3B. UI and product issues

These are all first-run experience, all reproducible, and all things I hit inside the first hour.

**1. Extension install fails with "invalid signature".** Installing the Claude Code extension surfaced a signature validation error. In a VS Code fork this usually means marketplace signing is not fully wired through. It blocks setup, which is the worst possible place for a bug.

**2. The sign-in popup exposed a raw backend IP address and full internal domain.** I am describing this as information disclosure rather than a vulnerability, because I did not test whether anything is exploitable and I am not going to claim impact I cannot demonstrate. But an auth flow showing a bare IP suggests the endpoint is not behind a domain or proxy, and it hands out infrastructure detail for free. Normally I would report this privately rather than write it in a submission document; I am including it because the assignment asked what I disliked, and it was the most serious thing I saw.

**3. The rate limit error contradicts the error it is wrapping.** The UI said *"Your Gemini API quota is exhausted for this model — retrying won't help. Enable billing on your key."* The underlying API error, in the same message, said *"Please retry in 23.823293474s"* — a per-minute limit of 5 requests, not an exhausted quota. So the product told me to go enable billing when I needed to wait half a minute. A user who trusts that message either pays or leaves.

**4. The model list offers models that no longer exist.** Selecting `gemini-2.5-flash` returned "This model is no longer available to new users." I hit the identical error independently while pinning models for this project, so it is Google deprecating access rather than anything Superbrain did wrong — but the model picker is offering choices it cannot fulfil, and the user finds out by failing.

The through-line is that every one of these is a **setup-time** problem. The product's actual value proposition — context compression — I never got to evaluate properly, because I spent my hour on signature errors, quota messages and dead models. For a tool competing against `npm install`-grade onboarding, that first hour is the whole battle.

## Limitations, honestly

- **14 questions is not many.** With a within-strategy SD of ~1.3, this design can only detect quality differences of roughly 1 point. Smaller real differences would be invisible. Separating these strategies would need substantially more questions, or harder ones.
- **One corpus, one model.** Everything here is a statement about FastAPI answered by `gemini-3.1-flash-lite`. The architectural-question reversal in particular could be a property of this repo's structure.
- **The judge is a single model.** No human agreement check, no multi-judge panel. A judge that systematically misreads one answer style would not show up.
- **Question-type cells have 4-5 questions each.** That table is directional and I would not defend any individual cell.
- **The skeleton is corpus-dependent.** See below — on FastAPI a naive skeleton was nearly half the repo.

## Things that surprised me

**The skeleton was 48% of the repo before I compacted it.** FastAPI annotates parameters as `Annotated[str, Doc("""...prose...""")]`, so "signatures and docstrings only" carried nearly all the prose anyway — 74,049 tokens. Reducing signatures to structure (parameter names, short types, return type) brought it to 16,517 tokens, or 10.8%. Structure-aware compression is much more corpus-dependent than it sounds; on a codebase that documents inside its type annotations, the naive version barely compresses at all.

**Two files are 55% of the corpus.** `routing.py` (49,172 tokens) and `applications.py` (34,517). Any budget-filling strategy is really making a decision about those two files.

**Writing a Python parser in TypeScript is a trap.** `lib/python.ts` is validated against Python's own `ast` module over all 48 files by `npm run verify-parser`, which fails the build on any disagreement. It currently agrees on all 502 symbols. Getting there took five fixes: `def`s inside docstring code examples being parsed as real symbols (FastAPI's docstrings are full of them — 554 symbols found vs 480 actual), trailing comments breaking signature detection (`class Color:  # type: ignore` does not end in `:`), `Doc("""...""")` blocks inside parameter lists desyncing bracket counting, Protocol stubs with inline bodies (`def dumps(self) -> str: ...`), and sibling functions inside `if` blocks sitting deeper than their predecessors without being nested in them.

**The judge silently produced garbage at first.** `gpt-oss-120b` is a reasoning model — it spends completion tokens thinking before it emits. At `max_tokens: 200` the reasoning consumed the whole budget and 50 of 56 verdicts came back empty or truncated mid-word. It looked like a parsing bug. Worse, when I fixed the cap, the response cache served the broken verdicts back because the cache key had not changed; the only tell was the runner reporting "0 new model calls".

---

## What I would build next in the harness itself

*(3A above is about Superbrain. This is about ContextLab.)*

**More questions, targeted at the disagreement.** The single most valuable next step is not a new strategy, it is 50-100 questions so the eval can actually resolve differences below 1 rubric point. Right now the harness is measuring question difficulty more than it is measuring strategy.

**A hybrid that switches on question type.** The by-type table is the most actionable thing here: retrieval wins factual, breadth wins architectural. A router that classifies the question first and picks a strategy would plausibly beat all four fixed strategies — and it is cheap, because classification is one small call.

**Structure-aware compression that is actually adaptive.** The skeleton is currently the whole repo's signatures. It should probably be the whole tree plus signatures only for modules adjacent to the retrieved chunks, which would cut its 6x cost premium substantially.

**Human agreement on a sample.** Score 20 answers by hand and check how well the judge tracks. Without that, the rubric numbers rest on one model's opinion.
