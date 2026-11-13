# Ingestion (UW-3)

What XO reads, how faithfully, and what it refuses. Everything here runs on the server; nothing is parsed on the client.

## Formats

| Format           | Frontend                                     | What comes out                                                                                                                                     |
| ---------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| PDF              | `sources/pdf-frontend.ts`                    | Text with page provenance; every page accounted for (read, recovered, excluded as blank, or left unaccounted). Recovered text is marked per block. |
| Word (.docx)     | `sources/docx-frontend.ts`                   | Text, headings and tables.                                                                                                                         |
| Excel (.xlsx)    | `sources/xlsx-frontend.ts`, `tabular/`       | Record sets (below), and the same cells as text for rule extraction, from one parse.                                                               |
| CSV              | `sources/structured-frontend.ts`, `tabular/` | Record sets; one field block per value, naming its cell.                                                                                           |
| Email (.eml)     | `sources/eml-frontend.ts`, `sources/mime.ts` | Envelope (from, to, cc, date, subject, message id) and the readable body. Attachments are opened as sources of their own at upload (below).        |
| HTML, JSON, text | existing frontends                           | Unchanged by UW-3.                                                                                                                                 |
| Images           | `sources/image-frontend.ts`                  | A photo or scan is read by the same recovery tiers as a scanned PDF page (below); its text is marked as recovered. Unread, it stays binary.        |

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

### Attachments

When an email is uploaded (or imported from a link), the API opens its attachments there and then
(`apps/api/src/sources/email-attachments.ts`). Each readable attachment is stored as a source of its own and goes through the same door
as a direct upload: the same format checks, the same notes and counts, and an audit entry (`source.extracted`). Its origin names the
email: `{ kind: 'email-attachment', emailSourceId, emailDigestSha256, emailFilename, part }`. The email's record lists every
attachment in MIME order, with either the `sourceId` it became or the reason it was not opened:

- **Not a readable format**, e.g. `.pptx`, or a type with no name that maps to nothing XO reads.
- **Could not be read.** A corrupt `.docx` or a broken workbook is reported on the email; the email still stores.
- **Decoration.** An image under 16 KiB shown inside the body (a `Content-ID` part), such as a signature logo or tracking pixel. A
  larger inline image, such as a photo pasted into the message, is opened.
- **Identical** to an earlier attachment of the same email. It is stored once, and both entries point at it.
- **Limits.**
  - At most 20 attachments are opened per email.
  - An attached email is opened, with its own attachments, up to two levels below the uploaded one; anything deeper is listed.

Names from inside an email are untrusted. Only the last path segment is kept, control characters and `..` are removed, and the name
is capped at 200 characters. An attachment with no name is called `attachment-<part>` plus the extension for its declared type. If
the email itself cannot be stored, the attachments stored for it are removed.

## Recovered text and page accounting

A PDF page whose text could not be read from its own text layer goes to recovery tiers (`extraction/`) in cost order. A photo or
scanned image (`.png`, `.jpg`, `.gif`, `.webp`) is treated as a one-page document (`extraction/image-document.ts`) and goes to the tiers
that declare `acceptsImages`:

- **Local OCR (tesseract):** reads the image as it is.
- **Vision:** sends the original bytes for JPEG and PNG up to 5 MB. Another type, or a larger file, is not sent.

The second PDF reader (pdfium) never sees an image. Its text then follows exactly the path of a recovered page: coverage counts it as
an OCR page, every block carries `textSource`, and the document kind is proposed from the words on the photo, not the file name.

The API builds the tiers from server configuration (`apps/api/src/compilations/extraction-tiers.ts`):

- **Local reading is on by default** (`XO_OCR=local`). The tiers are pdfium for unreadable text layers, then tesseract for scans and
  photos; nothing leaves the machine. `XO_OCR=off` turns it off.
- **Vision is off unless every confirmation is set:** a provider configured on this server (`XO_OCR_VISION_PROVIDER`), a model
  (`XO_OCR_VISION_MODEL`), `XO_OCR_VISION_SENDS_IMAGES=yes`, and a per-document budget (`XO_OCR_MAX_COST_USD`). The budget defaults
  to 0, which means the model is never called.

Invalid settings stop the server at startup. A compilation's `sourceReport.textRecovery` gives the pages that needed reading, how
many were read, by which tiers, and at what cost. Every block from
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
