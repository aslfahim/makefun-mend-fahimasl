# makefun-mend-fahimasl

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/aslfahim/makefun-mend-fahimasl/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/aslfahim/makefun-mend-fahimasl/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies AI-written edits in four formats to a tree of
text files, to the specification in `SPEC.md`: unified diffs (with wrong line numbers),
SEARCH/REPLACE blocks, V4A patches, and JSON tool calls. It finds the lines an edit names
even when the model drifted their whitespace or indentation, and it changes every file or
none.

## Run

Node 22 and its standard library only; nothing is installed.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is the patch file, or `-`/absent for standard input. `--format` is `auto`
(the default, which detects the format), `unified`, `search-replace`, `v4a` or `json`.
`--check` prints what would change and writes nothing. `--strict` matches lines
exactly (tier 0 only).

## Matching

An edit's old lines are found at the first of three tiers at which they occur at least
once: tier 0, every line equal; tier 1, every line equal once trailing spaces and tabs
are removed; tier 2, every line equal once leading and trailing spaces and tabs are
removed. A unified hunk takes the occurrence nearest its (possibly wrong) line number;
a SEARCH/REPLACE block needs exactly one occurrence; a V4A chunk takes the first
occurrence at or after its cursor, or after its anchor. Context lines are written as
the file's own lines, and at tier 2 added lines are re-indented to the file's indent.

## Output

Exit 0 lists what changed (`A`, `D`, `M`, `R old -> new`) and ends with `ok: <n> files`.
Exit 1 lists one `error: <code> <path>` line per failed edit and ends with
`failed: <k> of <n> edits`; nothing is written. Exit 2 is a usage, missing-patch,
format or parse error, one line, nothing written. Standard error is never compared.

## Layout

- `main.ts` — the CLI: argument parsing, format detection, the four readers, the
  three-tier matcher, and the all-or-nothing write.
- `runner.ts` — the kit's trial runner (kept as handed out): reads the trial's checks
  from the env and runs `main.ts` on each one.
- `check.ts` — runs `main.ts` on the kit's public practice set:
  `node check.ts <practice.json>`.
- `SPEC.md` — the whole contract this tool implements.

## Local score

Practice set (100 checks: unified 30, search_replace 20, v4a 20, json 15, cli 15):

    100 of 100 passed: practice score 1000
