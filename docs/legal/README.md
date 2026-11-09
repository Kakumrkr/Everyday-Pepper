# Legal pages

**The terms of service and the privacy policy live in [`apps/web/lib/legal.ts`](../../apps/web/lib/legal.ts)** since S59.5 ([ADR-0064](../adr/0064-legal-pages-and-ai-disclosure.md)), published at `/terms` and `/privacy` with a draft banner until the lawyer's review. That file is the one source: the S51 Markdown drafts that were here are replaced by it, so the lawyer reviews the live pages (or that file).

Keep the text in step with behaviour: a change to what Pepper collects, keeps, shares or sends changes `legal.ts` in the same PR (`legal.test.ts` checks the sections and the periods stated).

Before they come into force:
- The lawyer's review, and the dispute clause.
- The company's legal name, address and governing state, once it is formed (STATUS "Waiting on the user" 3 and 5).
- The backup retention period, set with the backups (S58a).
- The final subprocessor list (SMS and payments arrive in Phases 14–15).
- US state privacy notices if a pilot business is in such a state (for example California).
