# ADR-0061: AI-suggested import mapping from column names and masked samples

- **Status:** Accepted. Pre-approved by the user at the S56a.2 brief on 2026-11-06 ("Pre-approved with your recommendations").
- **Date:** 2026-11-06
- **Builds on:** ADR-0049 (import batches; its Consequences reserved "an AI suggestion for the rest, column names and masked samples only"), ADR-0027 (the provider adapter), ADR-0029 (the AI over the domain), ADR-0040 (one forced, metered call for words the domain checks), ADR-0060 (guess and confirm)

## Context
S48's mapping places a column by the other tool's preset, by its header, or by its values (emails, phones). An export from a tool Pepper doesn't know still leaves some columns unplaced. One may say "Guest", "When" or "Born", and the owner has to pick a field for each. The model can guess these well from the column's name and the shape of its values. But a client file is the business's most private data, and its column names came from someone else's file.

## Decision
1. **What the model sees (D-3).** Only the columns nothing placed, at most 20. These are columns with no field, nothing Pepper recognised, and no owner decision. For each one the model gets:
   - its name, labelled untrusted;
   - at most 3 distinct samples, masked to their shape by the imports module (`maskSample`): capitals become `A`, other letters `a`, digits `9`, combining marks are dropped, and punctuation and spaces stay. At most 40 characters.

   It also gets the fields still open: a field that one column fills alone is left out once it is taken. No value of the file, client, business or member reaches the model.
2. **One forced tool call (`suggest_mapping`) on the routine model.** It is metered against the business's monthly budget like the draft writer, at most 2,000 tokens. Its answer is a field or `null` for each column, with no free text (D-4), so nothing the model writes is ever shown.
3. **The domain checks every answer (`acceptSuggestions`).** It keeps a suggestion only when all of these hold:
   - the column was asked about and is still unplaced;
   - the field is still open;
   - for a field one column fills alone, this is the first column suggested for it;
   - a full name wins over first and last names;
   - for a visit field, the file then has a visit date.

   Every column asked about is marked asked (`{ field: null }` when nothing fits), so it is never asked again.
4. **Stored on the batch's columns, with no migration.** `ImportColumn.suggestion` (default `null`) lives in `import_batches.columns`, the jsonb column that already holds the mapping. A suggestion changes nothing: the mapping, plan, counts and problems stay as they were until the owner taps "Use it", which is an ordinary remap (`by: 'owner'`). A column the owner sets to "Don't import" is now marked `by: 'owner'` too, so it is never asked about.
5. **`POST /v1/imports/:id/suggestions`** (`clients.manage`, 10 requests per 10 minutes per member) lives in the chat module, beside the model. It always answers `{ outcome, preview }`, with outcome `answered`, `refused`, `nothing_to_ask`, `no_budget`, `ai_off` or `unavailable`. Without the AI the screen works as before (AC-X-2).
6. **The screen asks once, by itself (D-2).** It asks when the columns step opens with an unplaced column, and shows "Looks like Phone to me" and "Use it" under that column. An answer that arrives after the owner changed a column is dropped. Before Import, one line names each column left out and why (AC-W1-48).
7. **Layering.** `@pepper/ai` may import `@pepper/imports` (as it imports `@pepper/appointments`). `suggestImportColumns` is the one path for the api and the evals.

## Consequences
- A file from any tool is matched in fewer taps. The owner still decides every column, and a wrong suggestion costs one tap to ignore.
- A shape can still say a little: a name's length, or that a column holds dates. It never carries a letter or a digit.
- A file without a header row turns its first row into the column names. When any of those names looks like an email or a phone, nothing is asked (review fix). Some first rows hold no contact, such as a name and a tag only. Their names would still go to the model, a known residual, accepted because the owner sees such a file's columns as one client's details and fixes the file.
- A hostile column name can only make the model suggest a wrong field, and the domain's checks bound what that field can be. The new `import_mapping` eval set (gate 0.9, 0.8 at pass^3) checks such a header and a field asked for twice on the scripted cassettes. S56b records it.
- The eval set found that S48's header rule maps any column whose name ends in "email" or "phone", even a sentence. The rule is left as it is, since such a column only fills a contact when its values are valid.

## Built (S56a.2)
- contracts: `ImportColumn.suggestion`, `IMPORT_SUGGESTION_LIMITS`, `ImportMappingQuestion`/`Answer`, `ImportSuggestionsResult`.
- imports: `suggestions.ts` (`maskSample`, `mappingQuestion`, `openFields`, `acceptSuggestions`) and the services `importMappingQuestion` and `saveImportSuggestions`.
- ai: `imports/mapping-suggester.ts`, with `askMapping` and `suggestImportColumns`.
- api: `ImportSuggestionsController` in the chat module, and the e2e model's mapping answer.
- web: suggestions with "Use it" on the columns step, and the left-out line on the preview.
- evals: the `importFile` turn, the mapping grader and `import-mapping-s56.json` (7 cases).

## Recorded (S56b)
On `gpt-6-luna` (low), the routine route. The probe's first pass missed `mapping-visits-file`: with "Prefer null to a guess" and samples masked to their shape, the model left Treatment and Stylist empty, or the date column, which the domain needs before it keeps a visit's service and staff. The instructions now give each field's usual column names and say a visits file's columns go together; a tags column must be named for labels (a probe suggested tags for "Fav colour"). `import_mapping` 7/7 at pass^1 and pass^3 (gate 0.9 / 0.8). Spend in [ai-budget.md](../plan/ai-budget.md).
