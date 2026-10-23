# ADR-0036: Forget takes the AI's answers that recalled a fact

- **Status:** Accepted. The user chose this option in S30b on 2026-10-23 ("Turn-level + verbatim"), from four Claude offered.
- **Date:** 2026-10-23
- **Amends:** ADR-0034 (forget everywhere): a forget now also replaces AI answers by turn, not only matching words. ADR-0035 (facts in the AI): the instruction on warnings, and quoting values exactly.

## Context
S30b recorded every eval set on the real models (Luna + Sol). The fakes repeat values word for word; a real model does not. In `md-forget-visit-note`, the note "6N + 20 vol, 35 min" came back as "6N + 20 vol, processed for 35 minutes".

ADR-0034's scrub matches the stored value word for word, so the reworded answer stayed in the chat. The next request in that conversation sent it to the provider again. That fails AC-W7-2 and the 100% deletion gate.

Matching fragments of the value would not fix it. "35 min" does not match "35 minutes" as a whole word, and loose matching erases unrelated words. But ADR-0035 gives an exact signal: stored tool answers name facts by id (`{"$fact": id}`). So the turns that brought a fact to the model are known.

## Decision
1. **Migration 0041, `memory_forget_recalled`:** called by the forget trigger after the value scrub, as the owner, limited to the fact's business. In each conversation with a tool answer naming the fact (since the fact existed), it takes every AI answer after the first such tool answer:
   - non-empty text becomes "[Removed: this answer used a fact that was deleted]";
   - the provider's reasoning items are dropped (the message phase is kept).

   This covers the answer that read the fact and every later answer in that chat, which may repeat it from the history. The member's own words, tool calls and answers (references, no value) and cards (read live) stay. The value scrub still covers them word for word.
2. **Quote remembered values exactly** (instructions, `AGENT_PROMPT_VERSION` 3), so the word-for-word scrub also covers what the model writes about business facts. Those come in the instructions, not by reference.
3. **Two wording fixes** from the same recording:
   - the warning instruction said "mention an allergy … before booking", and Luna asked instead of proposing. Now it says to propose and mention the note; the card shows it, and the member decides there;
   - `forget_fact` says `factId` is a fact's id from the record's memory, never the client's, and "forget everything" means one call per fact.

## Alternatives considered
- **Replace only the answer of the turn that looked the fact up:** smaller, but an answer that repeated the value from history before the forget would survive unless word for word.
- **Instruction only (quote exactly):** no migration, but the 100% gate would rest on the model's wording.
- **Fuzzy or fragment matching on the value:** misses inflections ("min" / "minutes") and erases unrelated text.

## Consequences
- A forget replaces some unrelated AI text: any later answer in a conversation that recalled the fact. Forgetting is rare and deliberate, and the member's own words stay, so the chat still reads as a record.
- Business facts are not recalled by reference (they sit in the instructions). Their removal still relies on the value scrub and the "quote exactly" instruction. S33's pass^3 on `memory_delete` measures it.
- A changed value (not a delete) keeps the old value for the Undo window, as ADR-0034 decided.
