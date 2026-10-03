# P0 scope / rights / retention review — 2026-10-01

## Owner decision

The owner reviewed `outputs/p0-next-review.html` in the paid-release task and stated:

> 容量は3年持つなら今のところ問題ない。他もOK、進めてください

Recorded on 2026-10-01 JST. This accepts the proposed five-provider / 17-field scope and the proposed rights and retention decisions, conditional on validating three years of capacity. This is not a finding that capacity or production runtime has passed. The original requirement for separate approval immediately before each remote migration and production deployment remains in force. Main merge is not part of this candidate preparation.

## Approved scope and rights basis

Providers: openai, anthropic, google, xai, mistral. Fields are exactly the 17 groups in `config/proposals/models_dev.v3.json`, copied unchanged to `config/candidates/models_dev.v3.json`. New identifiers within those providers can be tracked automatically. Other providers and direct provider acquisition are outside the approval.

The seven approved gates are automated_collection, private_storage, internal_analysis, public_display, normalized_redistribution, derived_redistribution and commercial_redistribution. This applies the existing scoped MIT assessment in [the policy proposal](models-expansion.md#policy-proposal); it does not invent a third-party grant. Root LICENSE at models.dev commit `747925c4fb0142db3e508cac02202c2748a34cf0` was fetched again on 2026-10-01 and confirmed to contain the MIT permission and copyright notice. API attribution and the complete existing notice remain required. Logos, descriptions, arbitrary URLs, benchmarks, model weights and request bodies/headers are excluded. Raw redistribution and external LLM processing are denied in the candidate.

Evidence 90 days, archive 365 days, normalized/public/events 1,095 days and backup 30 days are accepted, with capacity validation still required. The 2026-12-26 policy review deadline is preserved; it is an operational review deadline, not a claim that the MIT license expires then. Three years of storage capacity does not replace that review.

## Isolated capacity evaluation

The approved scope may be measured locally before activation. The evaluation uses no production D1, R2, Worker invocation or credentials. It permits one bounded GET to the fixed catalog endpoint, no redirects, a 16 MB input limit and a finite timeout. It uses the reviewed parser and the same 500-model / 64-component limits, with no scope truncation. The local runtime review reference identifies only this evaluation and must never be copied into production configuration.

Only the approved projection may persist in ignored local `work/` storage. Reports contain aggregate counts, issue codes, byte sizes and hashes; no catalog payload or private evidence body is sent to an LLM, committed, or printed. Capacity estimates must distinguish local SQLite/workerd measurements from Cloudflare measurements and include model/component growth and event overhead. A failed evaluation leaves the candidate disabled and the existing ECB/Mistral v2 source configuration unchanged.

The subsequent [technical review](p0-runtime-review.md) records the measured current scope and the limits of its three-year forecast. The local release source now references that review; this has not activated production. `config/proposals/models_dev.v3.json` remains the original unapproved template, and the prior v2 source is preserved in `config/history/models_dev.v2.json`. Source bodies remain excluded from both the review and Git.
