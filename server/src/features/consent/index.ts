// @governance-tracked
// Definition: tests/api_definitions/consent/overview-get.json

export { consentRoutes } from './consentController';
export {
  listReceipts,
  listSuppressions,
  listBounceEvents,
  readSmsConsent,
  revokeReceipt,
} from './consentGateway';
export type { ReceiptRow, SuppressionRow } from './consentGateway';
