# Design review: S1-3b Ask XO on every screen

Status: **needs owner review**. Branch `s1-3b/ask-anywhere`, stacked on `s1-3/shell-and-routing`.

## What changed for a person

The box at the top of every screen (and the bar on a phone) now takes any of five kinds of request and answers with a
card or a saved reply: an answer from your documents, a document read, a prepared start, "go there", or a plain "XO can't,
and here is what would help". The placeholder says where you are ("Ask XO, analyse a document, or start a process…" on Home,
"Ask about runs, or open one…" on Activity). Cmd/Ctrl+J opens it. A document can be dropped into the panel to have XO read it.

## Rules kept

- Nothing starts from the box. A "start" is a card that opens the existing start screen, which keeps its own check before starting.
- The person's role bounds every answer: a Viewer can ask and navigate; reading a document and preparing a start need the author role.
- The card for a read document shows only what XO recorded (counts and kinds); it adds nothing until the person chooses "Use it as a source".
- Audit records the kind, the place and counts: never the words typed, a document's content or an answer.

## Screens

Before (Activity, dark): `before-*-activity-dark.jpg`. After: `after-{desktop,phone}-ask-{home,activity}-{dark,light}.jpg`
in `docs/reviews/s1-3b/ask-anywhere/`.

## Hand checks

Axe passes at every journey checkpoint in both viewports (J8 included). Keyboard order is covered by the Studio tests (box, send,
cards, dismiss). **Not done by a person:** screen-reader listening, 200% zoom and reduced-motion review. Listed as owner items.
