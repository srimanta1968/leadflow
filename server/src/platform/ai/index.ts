/**
 * The AI foundation.
 *
 * Everything an agent module needs and nothing an agent module may bypass: the
 * gateway that is the only way a prompt leaves the process, the runtime that
 * mints per-run capability tokens from the registry, the kill switch that halts
 * all of it, the per-tenant budget, the activity ledger, and the human-review
 * gate through which every consequential output reaches a person.
 */
export { complete } from './aiGateway';
export type { CompletionRequest, CompletionResult } from './aiGateway';

export {
  startRun,
  endRun,
  mintCapabilityToken,
  revokeCapabilityToken,
  haltAllRuns,
  activeRuns,
  replayRun,
} from './agentRuntime';
export type { AgentRun, CapabilityToken, HaltSummary } from './agentRuntime';

export {
  killSwitchState,
  engageKillSwitch,
  assertAiPermitted,
  resetKillSwitchCache,
} from './killSwitch';
export type { KillSwitchState } from './killSwitch';

export {
  currentBudget,
  reserveTokens,
  settleTokens,
  releaseReservation,
  setPeriodLimit,
  budgetTenantId,
} from './aiBudget';
export type { BudgetStatus, BudgetReservation } from './aiBudget';

export { recordCompletion, completionById, recentCompletions } from './activityLedger';
export type { CompletionRecord, CompletionOutcome, LedgerEntry } from './activityLedger';

export { propose, decide, proposalById, awaitingReview } from './reviewGate';
export type { Proposal, ProposeInput, DecideInput, DecisionResult } from './reviewGate';

export { redact, redactSlots, REDACTION_RULES } from './redaction';
export type { RedactionResult, RedactionHit } from './redaction';

export { resolveTemplate, renderTemplate, resetPromptLibraryCache } from './promptLibrary';
export type { ResolvedTemplate } from './promptLibrary';

export { verifyAiConsentBasis } from './aiConsent';
export type { AiConsentVerification } from './aiConsent';
