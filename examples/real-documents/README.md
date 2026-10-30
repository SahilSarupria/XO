# Real-document wild runs

The synthetic corpus in `../insurance-dev-corpus` was written alongside the rule patterns, so it can only guard against
regressions. This folder is how the compiler meets documents it was **not** written against.

- `manifest.json` lists 16 public policy wordings published by insurers and one regulator (motor, home, travel, health /
  personal accident, commercial property and business interruption). They were found by web search; **none has been
  downloaded or opened yet**, so a link may have moved. The PDFs are never committed: copyright stays with the publishers.
- `fetch.sh` downloads them into `downloads/` (gitignored) and records a sha256 per file. Run it on a machine with open
  internet access.
- `wild-run.mts` compiles every PDF in a folder and prints, per document, page accounting, rules and how many have a
  checkable condition, capabilities by confidence band, and the size of the review list (with how many of those carry
  a threshold, deadline or limit). It also writes `report/review-labelling-sheet.csv`.

```sh
sh examples/real-documents/fetch.sh
node --import tsx examples/real-documents/wild-run.mts
```

These counts are not accuracy. To get accuracy, mark which rows of `review-labelling-sheet.csv` are real rules (and add the
rules the compiler already found that are wrong); a handful of documents labelled that way is the held-out set phase 2 needs.
