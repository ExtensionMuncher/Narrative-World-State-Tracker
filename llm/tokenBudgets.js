// =============================================================================
// NWST LLM Completion Budgets — llm/tokenBudgets.js
// =============================================================================
// Explicit response ceilings keep reasoning-heavy public models from exhausting
// their completion allowance before emitting the structured answer NWST needs.
// These are ceilings, not targets: terse/non-reasoning models may stop normally.
// =============================================================================

export const LLM_TOKEN_BUDGETS = Object.freeze({
    SMALL: 4096,
    MEDIUM: 8192,
    HEAVY: 12288,
    BULK: 16384,
});
