# Change management

Never modify production blindly. Default in the maturity phase: PR, never
auto-merge.

For every implementation:
1. Inspect the current implementation and its dependencies (templates, routes, generated files).
2. Make the smallest coherent change on an isolated branch/worktree.
3. Run the repo's own checks (build, typecheck, tests) **and** the search quality gates (`policies/quality-gates.md`).
4. Run the compliance gate on the diff (`cli compliance`).
5. Review the diff adversarially: unintended routes/templates, tracking, metadata regressions.
6. Write the experiment record (`schemas/experiment.schema.json`): expected result, measurement window (≥14 days, usually 28), guardrails, rollback instructions.
7. Open a PR using `templates/pr-body.md`. High-risk categories are labelled and blocked on human approval.
8. After deploy: log IMPLEMENTED_CHANGE with date in `reports/changelog.md` so later analysis can separate site changes from search movement.

Rollback: every PR body states the exact revert (commit revert or config value) and who can execute it.
