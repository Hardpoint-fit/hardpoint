// The text and size limits of a stored fit. Pure, with no server import, so the builder's form and
// the data layer (queries.ts) read the same numbers.

export const TITLE_MAX = 80;
export const DESCRIPTION_MAX = 10_000;
export const COMMENT_MAX = 2_000;
export const REPORT_REASON_MAX = 1_000;
export const FIT_JSON_MAX_BYTES = 200_000;
export const BIO_MAX = 500;
export const REVISION_NOTE_MAX = 200;
export const BAN_REASON_MAX = 500;
