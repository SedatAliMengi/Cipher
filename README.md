# Cipher

**Transform documents into knowledge.**

Cipher is a local desktop application that turns documents into structured, machine-readable data using AI.

Drop a PDF or DOCX file into the app, choose the kind of output you want, and Cipher sends the document text to Google's Gemini model, which returns a clean JSON object. Each run produces a downloadable ZIP containing both the structured JSON output and a ready-to-use AI training entry in Alpaca format — no extra processing required.

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

Each schema is **fixed** — the same fields appear on every run, so the output is safe to consume programmatically.

---

## Training data pipeline

Every download automatically includes a `training.jsonl` file alongside `output.json`.

The JSONL entry is formatted in **Alpaca format** (`instruction`, `input`, `output`) and is directly usable for fine-tuning a language model without any extra processing. This makes Cipher not just a document reader, but a pipeline for building structured training and retrieval data from your own document library.

```
output.zip
├── output.json      # structured extraction for the chosen mode
└── training.jsonl   # Alpaca-format entry, ready for fine-tuning
```

---

## Tech stack

- **Electron** — runs locally as a native desktop app, no browser required
- **React + TypeScript** — frontend UI
- **Google Gemini (2.5 Flash)** — document understanding and extraction
- **Supported inputs** — PDF and DOCX

---

## Getting started

> Requires [Node.js](https://nodejs.org/) and a [Google Gemini API key](https://aistudio.google.com/).

```bash
# 1. Clone the repo
git clone https://github.com/YOUR_USERNAME/cipher.git
cd cipher

# 2. Install dependencies
npm install

# 3. Add your Gemini API key
#    Create a .env file in the project root:
echo "GEMINI_API_KEY=your_key_here" > .env

# 4. Run the app
npm start
```

Your API key lives only in `.env`, which is excluded from version control via `.gitignore`. Never commit your key.

---

## Roadmap

Cipher is being built local-first, then expanded outward.

- [x] Core pipeline — file in, structured JSON out
- [x] Four output modes (Knowledge Base, Student Summary, Academic Research, Analytics)
- [x] Alpaca-format training data export
- [ ] Custom output mode — user-defined schemas
- [ ] Excel/spreadsheet input support
- [ ] Batch processing — multiple documents at once
- [ ] **Cipher (Web)** — a planned hosted SaaS version of the same engine, with accounts and a bring-your-own-key / credit model, built for researchers, students, and developers

The current desktop tool also doubles as the data pipeline for a long-term personal AI/knowledge project — Knowledge Base output feeds retrieval, and the training export feeds fine-tuning.

---

## License

_TBD — add a license of your choice (e.g. MIT) before public release._
