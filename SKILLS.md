# Skill System

- `skill.md` (repo root): **Deterministic PDF-to-RDLC 2008 Compiler Rules (v3.3)** — canonical rulebook (`[R-PB]`, `[R-PARENT-NESTED]`, `[R-DUAL-TRACK]`, `[R-COLON-GRID]`, `[R-STAIRCASE]`, `[R-SUBGRID-STACK]`, `[R-ROW-PHYS]`, `[R-ROW-BOLD-MERGE]`, `[R-OUTER-LOCK]`, `[R-DENSITY-SPLIT]`, `[R-B-NONE]`, `[R-B-GRID]`, `[R-B-BOX]`, `[R-B-HLINE]`, `[R-ARCH-01]`, `[R-VBFILL-01]`) governing `compiler-dotnet/RdlcBuilder.cs`, `dotnet/ReportGen.VbCompiler/`, `extractor-py/`, `src/engine/rdlc/`, and `src/engine/vector/`.

Skills live as Markdown rulebooks under `skills/<skill-name>/skill.md`:

- `skills/pdf-layout/skill.md`: Layout disambiguation rules for labels, values, cards, timelines, and image fallback.
- `skills/rdlc-tablix/skill.md`: Tablix band decomposition, repeating detail groups, and cell span rules.
- `skills/vb-report/skill.md`: Separation of Data Access, Business Calculations, Formatting, and RDLC expressions.
- `skills/finance-calculation/skill.md`: Excel oracle interpretation, rounding rules, and ambiguity flagging.
- `skills/project-convention/skill.md`: Preserving existing DataSets, namespaces, and overwrite safety.

## Selective Skill Loading
`SkillManager.retrieveRelevantSkills(query)` inspects task metadata (`hasFinancialTerms`, `hasExistingProject`, `hasComplexGraphics`, `taskType`) and loads only matching skills into AI context rather than dumping every skill into every prompt.
