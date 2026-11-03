# Compiler regression corpus

Every `*.md` here is compiled through the production path by `test/policy/corpus.test.ts` and its quality report is
compared with `baselines.json`. A change that makes any manual worse (fewer rules understood, a tree lost, more tree
problems, more blocking questions, fewer rules) fails the test. Improvements pass; refresh the baseline deliberately:

    UPDATE_CORPUS_BASELINE=1 node ../../scripts/run-tests.mjs test

To add a customer manual: drop the sanitised text here as `<name>.md`, refresh the baseline, and commit both. Keep
manuals the compiler was NOT developed against — those are the ones that show regressions on unfamiliar phrasing.
