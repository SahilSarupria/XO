# Real-document corpus (UW-3c)

Documents XO was not written against, used by the `real-documents` evaluation suite (`packages/evaluation/suites/real-documents.ts`,
labels in `packages/evaluation/sets/real-documents.json`). All are works of the United States Government, in the public domain in
the United States and dedicated worldwide under CC0 1.0 by their publishers. The licence texts are in `sources/`.

## Originals (`sources/`)

| File                         | Origin                                                                                                     | Authored in                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `18f-weekly-ship.docx`       | 18F Handbook `downloads/TEMPLATE_Weekly_ship_template.docx`                                                | Microsoft Word                 |
| `18f-team-charter.docx`      | 18F Handbook `downloads/TEMPLATE_Team_charter.docx`                                                        | Microsoft Word                 |
| `18f-kickoff-agenda.docx`    | 18F Handbook `downloads/TEMPLATE_Internal_kickoff_agenda.docx`                                             | Microsoft Word                 |
| `18f-project-readme.docx`    | 18F Handbook `downloads/TEMPLATE_Project_README.docx`                                                      | Microsoft Word                 |
| `gsa-eft-form.pdf`           | 18F Handbook `downloads/EFT_Enrollment_Form.pdf` (GSA)                                                     | Adobe LiveCycle Designer       |
| `google-docs-demo.pdf`       | 18F Handbook `downloads/my-form.pdf`                                                                       | Google Docs PDF export         |
| `18f-out-of-office.md`       | 18F Handbook `pages/travel-and-leave/going-out-of-office.md`                                               | Markdown with Liquid tags      |
| `cisa-onboarding.md`         | CISA development guide `onboarding-checklist.md`                                                           | Markdown (GitHub task lists)   |
| `cisa-branch-protection.md`  | CISA development guide `project_setup/branch-protection.md`                                                | Markdown (GitHub task lists)   |
| `cisa-skeletonize.md`        | CISA development guide `project_setup/skeletonize-existing-repository.md`                                  | Markdown                       |
| `cisa-style-guide.md`        | CISA development guide `style-guide.md`                                                                    | Markdown                       |
| `usds-play-01.md`, `-04`, `-12` | USDS Digital Services Playbook `_plays/01.md`, `04.md`, `12.md`                                         | Markdown with front matter     |

Repositories and commits:

- 18F Handbook: https://github.com/18F/handbook at `c220f93896b39e9e4ab0f486a1d5bf346ac06e3e` (`LICENSE.md`: public domain and CC0 1.0).
- CISA development guide: https://github.com/cisagov/development-guide at `c22ca838ba50b8f5e7dc44b79ca0515c48497a6a` (`LICENSE`: CC0 1.0).
- USDS Digital Services Playbook: https://github.com/usds/playbook at `f5d71f1939efe87db9f0be414bcfa7c489e01c19` (README: public domain and CC0 1.0).

## Format variants (this folder)

`build.sh` derives them from the originals without editing content, the way documents travel in practice:

- Markdown → web page (`*.html`): pandoc, standalone HTML5.
- Markdown → Word (`*.docx`): pandoc, with real Word numbering and task-list check boxes.
- Word → PDF (`*.pdf`): LibreOffice.
- Word → HTML (`*.word.html`): LibreOffice "Save as HTML", the markup a Word export produces.
- PDF → scan (`*.scan.pdf`): 150 dpi greyscale, 0.6° skew, noise and blur, JPEG pages in an image-only PDF (no text layer).

The derived files are committed, and their SHA-256 hashes are recorded in the labelled set. Re-running `build.sh` can change bytes
(LibreOffice stamps dates), so a rebuild must be followed by updating those hashes.
