// @governance-tracked
// Definition: tests/api_definitions/channels/email-health-get.json
// Definition: tests/api_definitions/channels/sms-eligibility-get.json
// Definition: tests/api_definitions/channels/sms-eligibility-post.json
// Definition: tests/api_definitions/channels/calls-dial-post.json
// Definition: tests/api_definitions/channels/calls-id-disposition-post.json
// Definition: tests/api_definitions/channels/templates-get.json
// Definition: tests/api_definitions/channels/templates-id-publish-post.json

export { channelRoutes, callRoutes, templateRoutes } from './channelsController';
export { checkSmsEligibility, grantEligibility, logSmsSend, ELIGIBILITY_BASES, DAILY_AUTOMATED_CAP, DEDUP_WINDOW_MINUTES } from './smsEligibility';
export type { EligibilityBasis, EligibilityVerdict, IneligibleReason } from './smsEligibility';
export { dialCall, recordCallDisposition, CALLING_HOURS } from './voiceService';
export type { DialResult } from './voiceService';
export { listTemplates, publishTemplateVersion, TEMPLATE_CATALOG } from './templateLibrary';
export type { TemplateRow, PublishResult } from './templateLibrary';
