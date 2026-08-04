/**
 * The AI agent modules: SDR qualification and the Sales Coach scorecard.
 *
 * Everything either module produces is a PROPOSAL. The SOP permits AI to
 * suggest messages, scores, summaries and next actions, and requires a
 * qualified human to review consequential outputs.
 */
export { default as aiRoutes } from './aiRoutes';
export { AiCoachController, AiSdrController } from './aiController';
export { AiReviewGateController } from './reviewGateController';
export { qualifyLead, acceptProposal, TEMPLATE_VERSION } from './sdrQualifyService';
export type { SdrProposal, SdrChannel, ScoreComponent, ResearchFact } from './sdrQualifyService';
export { registerCall, scoreCall, mapObjection } from './coachScorecardService';
export type { Scorecard, DimensionScore, DetectedObjection } from './coachScorecardService';
export { verifyRecordingBasis } from './recordingConsent';
export type { ConsentVerification } from './recordingConsent';
export {
  assertOfferTruth,
  findOfferTruthViolations,
  OFFER_TRUTH_RULES,
  FEATURE_STATUS_LABELS,
} from './offerTruth';
export type { OfferTruthViolation } from './offerTruth';
