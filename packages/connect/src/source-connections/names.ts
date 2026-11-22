// UW-5 (ADR 0040): the name matcher moved to `@xo/knowledge-base` (resolution/names.ts) so one matcher serves file matching and
// entity resolution. Re-exported here so existing `@xo/connect` imports are unchanged.
export {
  NAME_MATCH_TIERS,
  matchPath,
  nameWords,
  personName,
  spellingKey,
  type DocumentMatch,
  type NameMatchKind,
  type PersonName,
} from '@xo/knowledge-base';
