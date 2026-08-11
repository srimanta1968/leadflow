/**
 * Orchestration: the intake saga and the channel-decision composer.
 *
 * Both exist for the same reason. A decision spread across several call sites is
 * a decision each of them can get subtly wrong, and the one that gets it wrong is
 * invisible until it has already sent the message or created the duplicate lead.
 * Putting each behind a single entry point makes the rule enforceable rather than
 * remembered — see tests/unit/orchestration.test.ts, which fails the build if a
 * send path reaches sdk-notification without a channel decision.
 */
export { orchestrateIntake, intakeSteps } from './leadIntakeOrchestrator';
export type { IntakeInput } from './leadIntakeOrchestrator';
export { runSaga, sagaSteps } from './saga';
export { runClosedWon, closedWonSteps } from './closedWonSaga';
export type { ClosedWonInput } from './closedWonSaga';
export { handleRung, ESCALATION_RULES } from './escalationGlue';
export type { RungEvent, Rung, EscalationOutcome } from './escalationGlue';
export type { SagaStep, SagaResult, StepContext } from './saga';
export {
  compose,
  composeBulk,
  evaluateBulk,
  toPublicDecision,
  authoriseDispatch,
  decisionById,
} from './channelDecision';
export type {
  ChannelDecision,
  PublicChannelDecision,
  ChannelDecisionInput,
  BulkDecisionResult,
  DispatchAuthorisation,
  DecisionReason,
  Verdict,
  Channel,
  Audience,
} from './channelDecision';
export { orchestrationRoutes } from './orchestrationController';
