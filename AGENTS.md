# atlas_search

`dsh-tool-atlas` — a zero-dependency MCP server that keeps a three-tier vector catalogue of tools (`catalog.json` + `vectors.json`), so a model can recall candidate tools by intent before it acts.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `bhfgeeichsolo3047-byte/atlas_search`, driven by the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles, spelled identically in this tracker (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), plus the five `wayfinder:*` ticket-type labels. See `docs/agents/triage-labels.md`.

### Domain docs

single-context — one `GLOSSARY.md` and one `docs/adr/` at the repo root. See `docs/agents/domain.md`.
