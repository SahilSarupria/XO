# Ingestion (UW-3)

What XO reads, how faithfully, and what it refuses. Everything here runs on the server; nothing is parsed on the client.

## Formats

| Format           | Frontend                                     | What comes out                                                                                                                                     |
| ---------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| PDF              | `sources/pdf-frontend.ts`                    | Text with page provenance; every page accounted for (read, recovered, excluded as blank, or left unaccounted). Recovered text is marked per block. |
| Word (.docx)     | `sources/docx-frontend.ts`                   | Text, headings and tables.                                                                                                                         |
| Excel (.xlsx)    | `sources/xlsx-frontend.ts`, `tabular/`       | Record sets (below), and the same cells as text for rule extraction, from one parse.                                                               |
| CSV              | `sources/structured-frontend.ts`, `tabular/` | Record sets; one field block per value, naming its cell.                                                                                           |
| Email (.eml)     | `sources/eml-frontend.ts`, `sources/mime.ts` | Envelope (from, to, cc, date, subject, message id), the readable body, and the attachment list.                                                    |
| HTML, JSON, text | existing frontends                           | Unchanged by UW-3.                                                                                                                                 |
| Images           | `sources/image-frontend.ts`                  | Stored and described; no text yet (see limitations). A file name still yields a document-kind proposal.                                            |

## Tabular data: record sets

A workbook or CSV becomes record sets (`packages/compiler/src/tabular/types.ts`): a header, typed columns, and records whose every
value keeps the exact text it was stored as and its cell (`Clients!B7`).

- **Nothing is converted.**
  - A column has a declared type (`string`, `integer`, `decimal`, `boolean`, `date`, `error`, `mixed`, `empty`), worked out from its
    values.
  - The value itself stays as stored. `cellValue()` converts only when a consumer asks.
  - Leading-zero identifiers (`00123`) are text.
- **Dates only where declared.**
  - A workbook cell is a date only if its own number format says so. It is read in the workbook's 1900 or 1904 system, and the serial
    is kept beside the ISO reading.
  - In CSV, only ISO dates (`2026-03-31`) are dates. `03/04/2026` reads differently day-first and month-first, so it stays text, with
    an `AMBIGUOUS_DATE_FORMAT` finding.
- **Formulas are never evaluated.** The value is the result the workbook cached; the formula is recorded, and the column notes how many
  values are formula results.
- **Headers.**
  - Within a table (two or more blank rows end one), the header is the first wide-enough row of distinct text with data below it.
    Year headings (`Particulars | 2024 | 2025`) count.
  - Single-cell rows above the header are kept as titles.
  - With no qualifying row, columns are named by letter and the table carries `HEADER_NOT_FOUND`.
- **Findings, never guesses.** The reader records these as findings rather than guessing:
  - merged cells (never filled in)
  - hidden sheets (read and marked)
  - duplicate or empty headers
  - values outside the header
  - mixed columns
  - separator-formatted numbers
  - error values
  - stray quotes
  - the fictitious 1900-02-29

  The API shows them to the person who uploaded the file.

Measured on the labelled synthetic corpus (`packages/compiler/test/tabular/labelled-corpus.ts`, 170 tables, seeded):

| Category                                            |  Tables | Header right | Column type right |
| --------------------------------------------------- | ------: | -----------: | ----------------: |
| Clean                                               |      80 |         100% |              100% |
| Titled (title rows above the header)                |      40 |         100% |              100% |
| Typed edges (leading zeros, dates, booleans, mixed) |      20 |         100% |              100% |
| Headerless numeric                                  |      20 |         100% |              100% |
| Known hard (year headings; headerless text lists)   |      10 |          50% |               60% |
| **All**                                             | **170** |    **97.1%** |         **98.7%** |

The known-hard misses are headerless lists of plain text (`Asha, Pune`). No reader can tell those from a header (`Name, City`) without
knowing what names are; they are taken as headed, and the evidence says so. This set measures the reader against what it was designed
for. Accuracy on real customer documents needs a labelled set of real documents (UW-13). No acceptance threshold is set here: those are
the owner's to ratify.

## Email

`.eml` (RFC 5322 / MIME) is read without dependencies:

- header unfolding, RFC 2047 encoded words and RFC 2231 parameters;
- nested multipart, with the preamble and epilogue ignored;
- quoted-printable and base64;
- the declared charset (one the platform cannot decode is read as UTF-8 and reported).

The body is the `text/plain` part when there is one; otherwise the HTML reduced to text, with scripts and styles removed.
Attachments are listed with name, type, size and SHA-256 and are **not** read: upload each one to use its contents.

## Recovered text and page accounting

A PDF page whose text could not be read from its own text layer goes to recovery tiers (`extraction/`) in cost order. Every block from
a recovered page carries `Provenance.textSource = { kind: 'recovered', tier, confidence, costClass }` into every unit built from it. A
page nothing could read stays `unaccounted`: never guessed, and the source is `partial` until a person decides.

## What kind of document is this?

`sources/kind-proposals.ts` proposes kinds (certificate, invoice, policy, contract, statement, register, correspondence, form) from a
cue pack that is data and can be replaced per operator or vertical.

- Each proposal lists every cue that matched, the text it matched and where it matched (page, cell, email header, title, file name).
- Proposals are always `status: 'proposed'`; only a person confirms a kind.
- When nothing matches, the answer is an empty list.
- The compile report carries them per source, and so does the API's compilation record (`sourceReport`).

## Uploads

- `POST /workspaces/:id/sources` takes a file in one request.
- `/workspaces/:id/uploads` is resumable, for unreliable networks:
  1. Open a session with the file's size and SHA-256.
  2. Send chunks at explicit offsets.
  3. After a dropped connection, ask where the server got to.
  4. Complete. The size and checksum are verified, then the file goes through the same door as a single-request upload.
- Studio uses the resumable route for files over 4 MB.
- `.docx`, `.xlsx`, `.csv` and `.eml` are read at the door, so a broken or hostile file is refused with the reason before anything is
  stored.

## Refused loudly

- Anything the hardened ZIP reader refuses:
  - decompression bombs, including ones that lie about their size;
  - zip64, encrypted entries, bad checksums;
  - more than 10,000 entries, or entries over 50 MB.
- An XML part with a DOCTYPE or entity declarations (entity-expansion and external-entity attacks).
- Shared-string indexes that do not exist.
- CSV with NUL bytes or an unclosed quote.
- Email without headers, with NUL bytes in headers, with broken base64, with multipart that has no boundary, or nested too deep.
- Anything past the limits (`tabular/limits.ts`: 1,000,000 values, Excel's row, column and cell-length limits, 255 sheets).

A file past a limit is refused, never truncated. A partial table read as if it were whole would be a silent wrong answer.
