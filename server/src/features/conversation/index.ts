/**
 * The conversation intelligence pipeline.
 *
 * Recording capture under a verified basis, then transcription, diarization,
 * summary, sentiment, objections, action items, deal risk and coaching input —
 * with every derived artifact carrying its offset into the source recording and
 * every stage writing a link into an append-only chain of custody.
 */
export { default as conversationRoutes } from './conversationRoutes';
export { ConversationController } from './conversationController';
export { checkRecordingEligibility } from './recordingEligibility';
export type { RecordingEligibility, BlockCode } from './recordingEligibility';
export { appendCustody, custodyChain, verifyChain } from './custodyLedger';
export type { CustodyEntry, CustodyStage, ChainVerdict } from './custodyLedger';
export {
  captureRecording,
  markStored,
  analyseRecording,
  recordingForCall,
  artifactsFor,
} from './intelligencePipeline';
export type {
  DerivedArtifact,
  RecordingRecord,
  TranscriptSegment,
} from './intelligencePipeline';
