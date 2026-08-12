// @governance-tracked
// Definition: tests/api_definitions/pipeline/stages-get.json
// Definition: tests/api_definitions/pipeline/stage-guard-get.json
// Definition: tests/api_definitions/pipeline/records-ref-save-gate-get.json
// Definition: tests/api_definitions/pipeline/records-ref-next-action-post.json
// Definition: tests/api_definitions/pipeline/records-ref-disposition-post.json
// Definition: tests/api_definitions/pipeline/records-ref-close-lost-post.json
// Definition: tests/api_definitions/pipeline/records-ref-feature-dependency-post.json

export { pipelineRoutes, recordRoutes } from './pipelineController';
export { checkNext, evaluateGate, checkStageGuard, stageCatalog, NEXT_FIELDS } from './saveGate';
export type { FieldRefusal, GateVerdict, GateSubject, StageGuardVerdict } from './saveGate';
export { runDispositionAutomation, captureClosedLost, recordFeatureDependency, LOST_REASON_CODES } from './dispositionService';
export type { AutomationAction, LostReasonCode } from './dispositionService';
