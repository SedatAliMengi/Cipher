# Cipher

**Transform documents into knowledge.**

Cipher is a local desktop application that turns documents into structured, machine-readable data using AI.

Give Cipher a document — a PDF, Word file, slide deck, spreadsheet, e-book, web page or even a photo of a page — choose the kind of output you want, and Cipher sends the content to Anthropic's Claude, which returns a clean JSON object. Each run produces a downloadable ZIP containing both the structured JSON output and a ready-to-use AI training entry in Alpaca format — no extra processing required. The **Convert to AI Data** mode goes further and turns the whole document into a ready-to-train dataset of fact-checked question–answer pairs. You can process one document, many files or a whole folder in one go.

> ⚠️ **Status: Work in Progress.** Cipher is currently a local-first personal tool, actively being built. A hosted web version is planned (see [Roadmap](#roadmap)).

---

## What it does

You give Cipher a document and a target format. It gives you back structured knowledge.

It isn't a plain file converter — the model reads and interprets the document, then extracts information shaped for a specific use case. Each output mode returns its own JSON schema, optimized for what that data is actually for.

---

## Inputs

| Input | How Cipher reads it |
|-------|---------------------|
| **PDF** | The text is extracted locally, for free. Scanned PDFs (pages that are only pictures) are read by Claude instead, ten pages at a time. |
| **Word** (`.docx`) | Text extracted locally |
| **PowerPoint** (`.pptx`) | Slide text and speaker notes, in presentation order |
| **Excel** (`.xlsx`) | Every sheet as a table (up to 5,000 rows per workbook) |
| **EPUB** e-books | Chapters in reading order |
| **Text, Markdown, CSV** | Read as they are |
| **HTML files and web links** | Only the page's main content, without menus, footers and scripts. Paste any `http://` or `https://` link; links to PDFs and images work too. |
| **Images** (`.png`, `.jpg`, `.webp`, `.gif`, up to 3.75 MB) | Read by Claude: text is transcribed, tables become Markdown tables, and charts and figures are described with their numbers |

Everything except scanned PDFs and images is read on your computer at no cost. Reading with Claude costs about $0.005 per page or image.

For PDFs where the figures matter, turn on **Read images, charts and tables inside PDFs**: every page is then sent to Claude, which transcribes the text and describes each chart, figure and table. It is off by default.

### Many files at once

Drop several files or a whole folder (subfolders included, up to 500 files per folder), add links, and press **Process**. Cipher works through them one by one:

- With the four structured modes, the ZIP holds one folder per document (`output.json` + `training.jsonl`) and a `batch_summary.json`.
- With Convert to AI Data, the documents are merged straight into one combined dataset (see [Combining datasets](#combining-datasets)).
- A file that can't be read is listed with the reason, and the rest carry on. Only a problem that would stop every file — a rejected API key, no credit left, no internet — ends the batch early.
- **Stop** ends a run early; whatever is already finished is kept.

---

## Output modes

| Mode | What it produces | Best for |
|------|------------------|----------|
| **Knowledge Base** | Main topic, summary, key facts, key concepts, connections to related fields, and questions the document raises | Feeding a personal AI model or knowledge/RAG system |
| **Student Summary** | Title, difficulty level, one-liner, short summary, key points, and plain-language definitions of key terms | Turning dense material into beginner-friendly study notes |
| **Academic Research** | Hypothesis, research type, methodology, sample & data, findings, key figures & statistics, citations, limitations, and suggested future research | Analyzing research papers (rejects non-academic documents) |
| **Analytics** | Document type, key metrics with values & context, trends, patterns, anomalies, data sources, insights, and visualizable datasets | Financial reports, business reports, market analysis (rejects documents with no meaningful data) |
| **Convert to AI Data** | Up to six fact-checked instruction–response pairs for every ~2,000-token chunk of the whole document, in several training formats, plus search-ready text chunks | Fine-tuning a model on a document's knowledge, or building a retrieval corpus |

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

This mode turns an entire document into a fine-tuning dataset. Cipher first reads the start of the document for its title, language and a short summary. It then splits the text into chunks of about 2,000 tokens and asks Claude for up to six grounded instruction–response pairs per chunk, written in the document's own language. A progress bar shows how far along it is.

Every pair is checked before it is kept:

- **Quote check** (free) — Claude must copy, word for word, the sentence or sentences each answer is based on. Cipher looks for that quote in the chunk and drops the pair if it isn't there, which catches made-up answers.
- **Double-check** (optional, about 40% more cost) — a second Claude call reviews every pair against its chunk and removes answers with unsupported claims, questions that don't make sense on their own, and weak pairs (a score below 3 out of 5).
- **Duplicates** within the document are removed.

**Extra formats** (optional, about 70% more cost) adds two reworded versions of every question, a plausible but flawed answer to each one for preference training, and a short multi-turn conversation per chunk. Both options are on by default.

```
document_ai-data.zip
├── pairs.jsonl          # master record: question, answer, quote, reworded questions, flawed answer, source, chunk
├── alpaca.jsonl         # {"instruction", "input", "output", "source", "chunk", "pair_id", "variant"}
├── chat.jsonl           # {"messages": [user, assistant]}, the chat format most fine-tuning tools use
├── preferences.jsonl    # {"prompt", "chosen", "rejected"}, for preference training (DPO)   (extra formats)
├── conversations.jsonl  # {"messages": [...]}, multi-turn conversations                    (extra formats)
├── chunks.jsonl         # the text chunks with "context" and "search_text", for retrieval (RAG)
├── stats.json           # source, title, language, model, options, counts, and what was removed and why
└── README.md            # Hugging Face dataset card
```

- Reworded questions become extra rows in `alpaca.jsonl` and `chat.jsonl`, all with the same answer. In `alpaca.jsonl`, `pair_id` links them to the original pair and `variant` is 0 for the original wording.
- Each chunk's `context` is a sentence or two placing it within the whole document, and `search_text` is that context followed by the chunk, ready to embed or index. Search finds chunks more reliably this way than from the chunk text alone (a technique known as contextual retrieval).
- `README.md` is a [Hugging Face dataset card](https://huggingface.co/docs/hub/datasets-cards): upload the folder to the Hub and each format appears as its own configuration, along with a description, the sources and how the data was made.

Token counts are estimates (about 4 characters per token). If some chunks fail — for example because of a rate limit — Cipher keeps the pairs it did generate, lists the skipped chunks in `stats.json` and says so on screen.

**Cost:** with Claude Haiku 4.5 and both options on, each chunk costs about $0.017, so a 50-page document comes to roughly $0.30 (about $0.12 with both options off).

### Combining datasets

The **Combine datasets** tab merges any number of Convert to AI Data ZIPs into one training-ready dataset. Drop the ZIPs in (or pick them with the file chooser), and Cipher:

- removes duplicate pairs, ignoring differences in case, punctuation and spacing
- sets aside about 10% of the pairs for validation, chosen by a hash of each pair's text, so a pair stays in the same split as the dataset grows; the reworded versions of a question always land in the same split as the original, so nothing leaks from training into validation
- keeps every pair's source file and chunk, and counts pairs per source
- writes a dataset card listing the sources, languages and models, and whether every pair was double-checked

```
combined_dataset.zip
├── pairs.jsonl                  # every pair, master record
├── alpaca/train.jsonl           alpaca/validation.jsonl
├── chat/train.jsonl             chat/validation.jsonl
├── preferences/train.jsonl      preferences/validation.jsonl     # when the sources have them
├── conversations/train.jsonl    conversations/validation.jsonl   # when the sources have them
├── chunks.jsonl                 # all chunks, deduplicated
├── stats.json                   # sources, languages, models, duplicates removed, split sizes, skipped files
└── README.md                    # Hugging Face dataset card with train and validation splits
```

A combined ZIP can itself be combined again, so you can keep adding documents to the same dataset, and ZIPs made by earlier versions of Cipher still work. Processing several documents with Convert to AI Data produces this same layout directly.

---

## Tech stack

- **Electron** — runs locally as a native desktop app, no browser required
- **React + TypeScript** — frontend UI
- **Claude Haiku 4.5 (Anthropic)** — document understanding and extraction, and reading scanned pages and images
- **pdf-parse, pdf-lib, mammoth, html-to-text, JSZip** — reading files locally and writing the ZIPs

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

Cipher uses Claude Haiku 4.5 (`claude-haiku-4-5`), the cheapest Claude model: $1 per million input tokens and $5 per million output tokens, which works out to a few cents per document in the structured modes (see [Convert to AI Data](#convert-to-ai-data) for dataset costs). To use a different model, add a line like `CLAUDE_MODEL=claude-sonnet-5` to `.env`.

API usage is paid from prepaid credit. To cap what you can spend, set a monthly spend limit in the [Claude Console](https://platform.claude.com/settings/billing) under Settings → Billing.

---

## Roadmap

Cipher is being built local-first, then expanded outward.

- [x] Core pipeline — file in, structured JSON out
- [x] Four output modes (Knowledge Base, Student Summary, Academic Research, Analytics)
- [x] Alpaca-format training data export
- [x] Convert to AI Data — whole-document fine-tuning datasets (Alpaca + chat JSONL)
- [x] Quote-checked and double-checked pairs, preference and multi-turn formats, contextual retrieval chunks, Hugging Face dataset cards
- [x] Combine datasets — merge, deduplicate and split into train/validation
- [x] More inputs — PowerPoint, Excel, EPUB, text, HTML, web links, images and scanned PDFs
- [x] Batch processing — multiple documents or whole folders at once
- [ ] Custom output mode — user-defined schemas
- [ ] **Cipher (Web)** — a planned hosted SaaS version of the same engine, with accounts and a bring-your-own-key / credit model, built for researchers, students, and developers

The current desktop tool also doubles as the data pipeline for a long-term personal AI/knowledge project — Knowledge Base output feeds retrieval, and the training export feeds fine-tuning.

---

## License

_TBD — add a license of your choice (e.g. MIT) before public release._
