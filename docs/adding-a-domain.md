# Adding a New Domain

The signal-harvester engine is domain-agnostic. A new monitoring domain requires **one YAML file and zero code changes**.

---

## Template

Copy `configs/profiles/security-grc.yaml` and edit these sections:

```yaml
profile: my-domain              # unique identifier, used in output paths and DB filename
dashboard_title: "My Domain Intelligence"

feeds:
  - name: Source One            # human-readable label shown in the dashboard
    url: https://example.com/feed.xml
    trust: high                 # high | medium | low (reserved for future trust-weighting)
  - name: Source Two
    url: https://example.com/atom.xml
    trust: medium

watch_topics:                   # what the LLM pays attention to
  - topic one
  - topic two

sentiment_target: "our team's exposure to X"   # sentiment is relative to THIS

tiers:
  T1: >
    Write a concrete, specific definition of a T1 event for this domain.
    Examples work better than abstractions — name real events that would qualify.
  T2: >
    Important but not immediately actionable. Secondary signals.
  T3: >
    Background context, opinion, slow trends.

llm:
  model: qwen3:8b               # or harvester-enrich for the 12B model
  base_url: http://localhost:11434/v1

output:
  root: "output/my-domain"      # each domain gets its own output tree
  formats: [json, markdown]
```

---

## Tier criteria: the most important config

Good tier criteria are the difference between T1-inflation (everything is critical) and a useful signal. Write them as if briefing a new analyst:

**Effective pattern:** Name the event type, qualify it with a threshold, and optionally add a source-trust hint.

```yaml
tiers:
  T1: >
    Confirmed [event_type] affecting [scope]; [threshold]; [immediacy indicator].
    Example for security: "Active exploitation confirmed in the wild; CVE with CVSS 9.0+ and
    public proof-of-concept; breach confirmed at a peer organization."
  T2: >
    [Event type] disclosed but [mitigating condition]. Important development without
    immediate action required.
  T3: >
    Opinion, analysis, historical context, slow-burn trends, vendor content with substance.
```

The instruction `"When uncertain between two tiers, choose the LOWER tier"` is baked into the prompt. This fights small-model tier inflation — your criteria should describe T1 conservatively.

---

## Finding good RSS feeds

- **Government/regulatory:** Most publish Atom/RSS (CISA, NIST, FDA, SEC EDGAR, etc.)
- **News outlets:** Use `/feed/`, `/rss/`, or `/rss.xml` suffixes; check `<link rel="alternate" type="application/rss+xml">` in the HTML source
- **arXiv:** `https://rss.arxiv.org/rss/cs.CV` — replace the subject area
- **Substack newsletters:** Append `/feed` to any Substack URL
- **Blogs:** Almost all support RSS; try `/feed`, `/atom.xml`, `/rss.xml`
- **Test a feed:** `python -c "import feedparser; f = feedparser.parse('URL'); print(len(f.entries), 'entries')"`

---

## Validate before running

```bash
python -m harvester --profile configs/profiles/my-domain.yaml validate-config
```

This catches YAML syntax errors, missing required fields, and empty feeds/topics before you wait for a pipeline run.

---

## Building a golden set (recommended)

After your first run, hand-label 20–30 articles with expected tiers and sentiment. Save them in `tests/golden/my-domain/`:

```json
{
  "id": "abc123",
  "url": "https://example.com/article",
  "title": "Article title",
  "extracted_text": "Full article text...",
  "expected": {
    "tier": "T2",
    "sentiment_label": "negative"
  }
}
```

Then measure accuracy:

```bash
python -m harvester --profile configs/profiles/my-domain.yaml eval --golden-set tests/golden/my-domain
```

Publish the numbers. Honest metrics beat unverified claims.
