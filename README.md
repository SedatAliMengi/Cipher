# Cipher

**Transform documents into knowledge.**

Cipher is a local desktop application that turns documents into structured, machine-readable data using AI.

Drop a PDF or DOCX file into the app, choose the kind of output you want, and Cipher sends the document text to Anthropic's Claude, which returns a clean JSON object. Each run produces a downloadable ZIP containing both the structured JSON output and a ready-to-use AI training entry in Alpaca format — no extra processing required. The **Convert to AI Data** mode goes further and turns the whole document into a ready-to-train dataset of question–answer pairs.

> ⚠️ **Status: Work in Progress.** Cipher is currently a local-first personal tool, actively being built. A hosted web version is planned (see [Roadmap](#roadmap)).

---

## What it does

You give Cipher a document and a target format. It gives you back structured knowledge.

It isn't a plain file converter — the model reads and interprets the document, then extracts information shaped for a specific use case. Each output mode returns its own JSON schema, optimized for what that data is actually for.

---

## Output modes

| Mode | What it produces | Best for |
|------|------------------|----------|
| **Knowledge Base** | Main topic, summary, key facts, key concepts, connections to related fields, and questions the document raises | Feeding a personal AI model or knowledge/RAG system |
| **Student Summary** | Title, difficulty level, one-liner, short summary, key points, and plain-language definitions of key terms | Turning dense material into beginner-friendly study notes |
| **Academic Research** | Hypothesis, research type, methodology, sample & data, findings, key figures & statistics, citations, limitations, and suggested future research | Analyzing research papers (rejects non-academic documents) |
| **Analytics** | Document type, key metrics with values & context, trends, patterns, anomalies, data sources, insights, and visualizable datasets | Financial reports, business reports, market analysis (rejects documents with no meaningful data) |
| **Convert to AI Data** | Up to six instruction–response pairs for every ~2,000-token chunk of the whole document, plus the raw text chunks | Fine-tuning a model on a document's knowledge, or building a retrieval corpus |

Each schema is **fixed** — the same fields appear on every run, so the output is safe to consume programmatically.

---

## Training data pipeline

Downloads from the four structured modes include a `training.jsonl` file alongside `output.json`.

The JSONL entry is formatted in **Alpaca format** (`instruction`, `input`, `output`) and is directly usable for fine-tuning a language model without any extra processing. This makes Cipher not just a document reader, but a pipeline for building structured training and retrieval data from your own document library.

```
output.zip
├── output.json      # structured extraction for the chosen mode
└── training.jsonl   # Alpaca-format entry, ready for fine-tuning
```

### Convert to AI Data

This mode turns an entire document into a fine-tuning dataset. Cipher splits the text into chunks of about 2,000 tokens, asks Claude for up to six grounded instruction–response pairs per chunk (written in the document's own language), and shows a progress bar while it works.

```
document_ai-data.zip
├── alpaca.jsonl   # {"instruction", "input", "output", "source", "chunk"} — Alpaca format + where each pair came from
├── chat.jsonl     # {"messages": [user, assistant]} — chat format used by most fine-tuning tools
├── chunks.jsonl   # the raw text chunks with their source, for retrieval (RAG) or continued pretraining
└── stats.json     # source file, model, date, chunk/pair counts and approximate tokens
```

Token counts are estimates (about 4 characters per token). If some chunks fail — for example because of a rate limit — Cipher keeps the pairs it did generate and lists the skipped chunks in `stats.json`.

### Combining datasets

The **Combine datasets** tab merges any number of "Convert to AI Data" ZIPs into one training-ready dataset. Drop the ZIPs in (or pick them with the file chooser), and Cipher:

- removes duplicate pairs, ignoring differences in case, punctuation and spacing
- sets aside about 10% of the pairs for validation, chosen by a hash of each pair's text, so a pair stays in the same split as the dataset grows
- keeps every pair's source file and chunk, and counts pairs per source

```
combined_dataset.zip
├── alpaca/train.jsonl       alpaca/validation.jsonl
├── chat/train.jsonl         chat/validation.jsonl
├── chunks.jsonl             # all chunks, deduplicated
└── stats.json               # sources, duplicates removed, split sizes, skipped files
```

A combined ZIP can itself be combined again, so you can keep adding new documents to the same dataset.

---

## Tech stack

- **Electron** — runs locally as a native desktop app, no browser required
- **React + TypeScript** — frontend UI
- **Claude Haiku 4.5 (Anthropic)** — document understanding and extraction
- **Supported inputs** — PDF and DOCX

---

## Getting started

> Requires [Node.js](https://nodejs.org/) and an [Anthropic API key](https://platform.claude.com/) with some prepaid credit.

```bash
# 1. Clone the repo
git clone https://github.com/SedatAliMengi/cipher.git
cd cipher

# 2. Install dependencies
npm install

# 3. Add your Anthropic API key
#    Create a .env file in the project root:
echo "CLAUDE_API_KEY=your_key_here" > .env

# 4. Run the app
npm run dev
```

Your API key lives only in `.env`, which is excluded from version control via `.gitignore`. Never commit your key.

Cipher uses Claude Haiku 4.5 (`claude-haiku-4-5`), the cheapest Claude model: $1 per million input tokens and $5 per million output tokens, which works out to a few cents per document. To use a different model, add a line like `CLAUDE_MODEL=claude-sonnet-5` to `.env`.

API usage is paid from prepaid credit. To cap what you can spend, set a monthly spend limit in the [Claude Console](https://platform.claude.com/settings/billing) under Settings → Billing.

---

## Roadmap

Cipher is being built local-first, then expanded outward.

- [x] Core pipeline — file in, structured JSON out
- [x] Four output modes (Knowledge Base, Student Summary, Academic Research, Analytics)
- [x] Alpaca-format training data export
- [x] Convert to AI Data — whole-document fine-tuning datasets (Alpaca + chat JSONL)
- [x] Combine datasets — merge, deduplicate and split into train/validation
- [ ] Custom output mode — user-defined schemas
- [ ] Excel/spreadsheet input support
- [ ] Batch processing — multiple documents at once
- [ ] **Cipher (Web)** — a planned hosted SaaS version of the same engine, with accounts and a bring-your-own-key / credit model, built for researchers, students, and developers

The current desktop tool also doubles as the data pipeline for a long-term personal AI/knowledge project — Knowledge Base output feeds retrieval, and the training export feeds fine-tuning.

---

## License

_TBD — add a license of your choice (e.g. MIT) before public release._
