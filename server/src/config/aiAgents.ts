import { PERMISSIONS } from './roles';

/**
 * The AI agent registry — the ONLY place an agent's reach is declared.
 *
 * A capability token is minted from this file and from nothing else. That is the
 * whole mechanism behind "capability tokens scope each agent to the minimum
 * necessary access": the alternative, letting each call site name the scopes it
 * wants, produces a system where the reach of an agent can only be discovered by
 * reading every call site, and where widening it is a one-line change nobody
 * reviews.
 *
 * ADDING A CAPABILITY HERE IS THE REVIEWABLE ACT. `mintCapabilityToken` refuses
 * any scope not listed on the agent, so an agent that starts needing a new one
 * fails loudly at the mint rather than quietly acquiring it.
 */

/**
 * What an agent may touch, as `<resource>.<verb>` strings.
 *
 * READ AND WRITE ARE SEPARATE CAPABILITIES even where a workflow uses both,
 * because the interesting question about an agent is almost never "can it see
 * leads" — it is "can it change them".
 */
export const AI_CAPABILITIES = {
  LEAD_READ: 'lead.read',
  LEAD_ANNOTATE: 'lead.annotate',
  CONVERSATION_READ: 'conversation.read',
  CONVERSATION_DRAFT: 'conversation.draft',
  RESEARCH_LOOKUP: 'research.lookup',
  SCORECARD_WRITE: 'scorecard.write',
  PROPOSAL_CREATE: 'proposal.create',
} as const;

export type AiCapability = (typeof AI_CAPABILITIES)[keyof typeof AI_CAPABILITIES];

/**
 * The consequential output kinds the review gate knows.
 *
 * EXACTLY THE FOUR SOP §21 NAMES — "AI may suggest messages, scores, summaries,
 * and next actions" — and the list is closed for that reason rather than for
 * tidiness. A fifth kind would be a category of machine output the SOP has not
 * sanctioned, and adding one to this union is the moment to notice that.
 */
export type ProposalKind = 'message' | 'score' | 'summary' | 'next_action';

export interface AiAgentDefinition {
  /** Stable key. Becomes the sdk-agent-runtime agent name; never rename. */
  key: string;
  label: string;
  /** One line on what this agent is for. */
  purpose: string;
  /** Consent purpose every completion by this agent is taken under. */
  consentPurpose: string;
  /**
   * The MINIMUM capabilities this agent needs to do its job.
   *
   * Minimum is a claim, and the way it stays true is that it is short enough to
   * read. An agent listing six capabilities to do one job is a review finding,
   * not a configuration detail.
   */
  capabilities: AiCapability[];
  /** Output kinds this agent may propose. Anything else is refused at the gate. */
  proposes: ProposalKind[];
  /** Prompt template key from the versioned library. */
  promptTemplateKey: string;
}

export const AI_AGENTS: AiAgentDefinition[] = [
  {
    key: 'sdr_first_touch',
    label: 'AI SDR — first touch',
    purpose: 'Qualifies an inbound lead and drafts the first outbound message.',
    consentPurpose: 'lead_management',
    capabilities: [
      AI_CAPABILITIES.LEAD_READ,
      AI_CAPABILITIES.RESEARCH_LOOKUP,
      AI_CAPABILITIES.CONVERSATION_DRAFT,
      AI_CAPABILITIES.PROPOSAL_CREATE,
    ],
    // NOT lead.annotate. The SDR agent scores a lead but does not write the
    // score onto it — the score reaches the record through an accepted
    // proposal, so the agent needs no write capability at all on leads.
    proposes: ['message', 'score'],
    promptTemplateKey: 'sdr_first_touch',
  },
  {
    key: 'sales_coach',
    label: 'AI Sales Coach',
    purpose: 'Scores a recorded call against the coaching dimensions.',
    consentPurpose: 'quality_assurance',
    capabilities: [
      AI_CAPABILITIES.CONVERSATION_READ,
      AI_CAPABILITIES.SCORECARD_WRITE,
      AI_CAPABILITIES.PROPOSAL_CREATE,
    ],
    proposes: ['summary', 'score'],
    promptTemplateKey: 'coach_call_review',
  },
  {
    key: 'next_action_planner',
    label: 'AI next-action planner',
    purpose: 'Suggests the next action on an open lead from its own history.',
    consentPurpose: 'lead_management',
    // Reads the lead and the thread; proposes. Cannot draft a message and cannot
    // look anything up externally — a planner that could research would be a
    // second SDR agent with nobody's approval.
    capabilities: [
      AI_CAPABILITIES.LEAD_READ,
      AI_CAPABILITIES.CONVERSATION_READ,
      AI_CAPABILITIES.PROPOSAL_CREATE,
    ],
    proposes: ['next_action'],
    promptTemplateKey: 'next_action_plan',
  },
];

/** Look up one agent by key. */
export function agentByKey(key: string): AiAgentDefinition | undefined {
  return AI_AGENTS.find((agent) => agent.key === key);
}

/** Whether a capability is one this agent was registered with. */
export function agentHasCapability(agent: AiAgentDefinition, capability: string): boolean {
  return agent.capabilities.includes(capability as AiCapability);
}

/**
 * The authority a human needs to ACCEPT a proposal of this kind.
 *
 * THIS MAP IS WHAT "QUALIFIED HUMAN" MEANS IN CODE. The SOP requires that "a
 * qualified human reviews consequential outputs", and qualification cannot be
 * "is logged in" — releasing a message to a prospect and approving a change of
 * offer terms are different authorities, held by different people, and a gate
 * that treats them alike is a gate in name only.
 *
 * Every value is an EXISTING SOP §28 permission. Inventing an `ai.approve`
 * permission would have created a second authority for the same real-world act,
 * so a person who may not review a call by hand could review one by accepting a
 * machine's summary of it — which is the loophole this whole feature exists to
 * close. A Sales Manager holds `call.review` and NOT `message.send_approved`, so
 * the map genuinely separates people: the same manager who may accept a call
 * summary may not release a drafted message.
 */
export const KIND_REQUIRES_PERMISSION: Record<ProposalKind, string> = {
  message: PERMISSIONS.MESSAGE_SEND_APPROVED,
  // Accepting a machine's qualification is what moves the lead's stage and
  // priority, so it carries the authority that governs that.
  score: PERMISSIONS.STAGE_UPDATE,
  // A call summary is coaching output about a named rep.
  summary: PERMISSIONS.CALL_REVIEW,
  next_action: PERMISSIONS.NEXT_ACTION_CREATE,
};

/** Every proposal kind the gate accepts. */
export function allProposalKinds(): ProposalKind[] {
  return Object.keys(KIND_REQUIRES_PERMISSION) as ProposalKind[];
}

/** Whether a string names a proposal kind. */
export function isProposalKind(value: string): value is ProposalKind {
  return Object.prototype.hasOwnProperty.call(KIND_REQUIRES_PERMISSION, value);
}
