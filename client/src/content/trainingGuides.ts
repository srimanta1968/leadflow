/**
 * The training centre's content, as a typed module.
 *
 * NOT A CMS, and the reason is drift. A guide describes controls by name; a
 * screen renames a control in a pull request. If the guide lives in a database,
 * those two events happen weeks apart and nobody finds out until an operator
 * follows a step that no longer exists — which teaches them the product is
 * broken, and training that contradicts the product is worse than none. Here the
 * screen and its guide move in one commit, and a renamed control is a diff on
 * this file in the same review.
 *
 * TWO RULES KEEP IT HONEST, and both are enforced by what this file is allowed
 * to say rather than by a linter:
 *
 *   1. A GUIDE DESCRIBES WHAT THE PRODUCT ACTUALLY DOES TODAY. There is no guide
 *      for Contact Command or Associated Properties, because both are `planned`
 *      in the nav and render as Soon. Where a step is unreachable for the
 *      reader, it says so in `note` rather than describing a flow they cannot
 *      complete.
 *   2. EVERY CARD STATES THE GRANT ITS TASK NEEDS. Most support questions about
 *      this product will be "why is this greyed out", and the answer is nearly
 *      always a role rather than a fault. A card that cannot answer that has
 *      sent the reader to a person instead of to a screen.
 *
 * Every quoted control name in `steps` is a real `name` attribute or rendered
 * label, copied from the screen it belongs to.
 */

/** The six groups, in the sidebar's own order so the map matches the product. */
export const TRAINING_GROUPS = [
  'Getting started',
  'Contact operations',
  'Identity and trust',
  'Revenue',
  'Insight',
  'Administration',
] as const;

export type TrainingGroup = (typeof TRAINING_GROUPS)[number];

export interface GuideStep {
  /** The action, naming the control exactly as the screen labels it. */
  action: string;
  /**
   * A caveat the reader needs BEFORE they try the step.
   *
   * Where a step is behind a grant they may not hold, or reaches an upstream
   * this deployment may not have, saying so here is the difference between a
   * reader who understands what they are seeing and one who concludes the
   * product is broken.
   */
  note?: string;
}

export interface TrainingGuide {
  /** Slug, and the `/app/training/:guideId` segment. */
  id: string;
  title: string;
  group: TrainingGroup;
  /** What the reader will have DONE, not which screen they will have opened. */
  outcome: string;
  /** Honest reading-and-doing time, in minutes. */
  minutes: number;
  /** Who this is for, so a rep is not handed the RevOps material. */
  roles: string[];
  /**
   * The route this guide teaches.
   *
   * What the Guide affordance in the top bar matches on. Null for a guide about
   * the application as a whole rather than one screen.
   */
  screen: string | null;
  /** The policy action the task needs, or null when nothing gates it. */
  grant: string | null;
  /** Which role holds that grant, in the words the permission matrix uses. */
  grantHolder?: string;
  steps: GuideStep[];
  /** How the reader knows it worked. A guide that stops at the last click does not say. */
  successCheck: string;
}

export const TRAINING_GUIDES: TrainingGuide[] = [
  /* ------------------------------------------------------- getting started */
  {
    id: 'finding-your-way-around',
    title: 'Finding your way around',
    group: 'Getting started',
    outcome: 'Reach any screen you are entitled to, and understand what Locked and Soon mean',
    minutes: 4,
    roles: ['Everyone'],
    screen: null,
    grant: null,
    steps: [
      {
        action:
          'Read the sidebar top to bottom. It is grouped the way the product is: Contact operations, Identity & trust, Revenue, Insight, Related, Administration.',
      },
      {
        action:
          'Notice that some entries are grey rather than clickable, with a word on the right. "Soon" means the screen is not built yet. "Locked" means it exists and your role does not include it.',
        note:
          'Locked is not a fault. It is the policy decision point answering honestly before you click, rather than letting you open a screen that would then refuse you.',
      },
      {
        action: 'Press Ctrl+K (or Cmd+K) anywhere to open the command palette and jump by name.',
      },
      {
        action:
          'Use the "Guide" button in the top bar on any screen to open the guide for that screen.',
      },
      {
        action: 'Open "Permission Matrix" under Administration to see exactly what your role grants.',
      },
    ],
    successCheck:
      'You can name one screen that is Locked for you and say which grant would unlock it.',
  },

  /* ---------------------------------------------------- contact operations */
  {
    id: 'capture-and-resolve-a-lead',
    title: 'Capture a lead, then resolve it',
    group: 'Contact operations',
    outcome: 'Get a real enquiry into the system and off the unresolved queue',
    minutes: 8,
    roles: ['Sales Rep', 'Data Steward'],
    screen: '/app/capture',
    grant: 'source_record.promote',
    grantHolder: 'Data Steward. Capturing is open to everyone; RESOLVING a capture is not.',
    steps: [
      { action: 'Open "Quick Capture" in the sidebar.' },
      { action: 'Fill "name", "email" and "phone" with what the prospect actually gave you.' },
      {
        action: 'Choose "origin_class" — where this record came from.',
        note:
          'There is no default and there will not be one. Origin class decides where the record sits on the trust ladder, so guessing it writes a claim nobody made.',
      },
      { action: 'Choose "source" for the channel it arrived through, then "consent" if they gave one.' },
      { action: 'Submit the form. You will land on a confirmation naming the record you created.' },
      { action: 'Open "Capture Inbox". Your capture is in the unresolved queue.' },
      {
        action: 'Open the capture and work the resolution modal through its stages.',
        note:
          'This step needs source_record.promote. Without it you can read the queue and see the evidence, but the resolve control will be disabled.',
      },
    ],
    successCheck:
      'The capture no longer appears in the unresolved count on the Capture Inbox sidebar badge, and the contact is findable from the Contacts screen.',
  },

  /* ----------------------------------------------------- identity and trust */
  {
    id: 'consent-suppression-and-the-export-gate',
    title: 'Consent, suppression and the export purpose gate',
    group: 'Identity and trust',
    outcome: 'Export a contact list that provably excludes everyone who asked us to stop',
    minutes: 10,
    roles: ['Privacy Officer', 'Marketing Ops'],
    screen: '/app/consent',
    grant: 'consent.purpose_manage',
    grantHolder: 'Privacy Officer. It is the one role that may override a suppression unaided.',
    steps: [
      { action: 'Open "Consent & Preferences" under Identity & trust.' },
      {
        action:
          'Read the "Consent Receipt Register": every row is one receipt with its Purpose, Jurisdiction and Valid Until.',
      },
      {
        action:
          'Read "Suppression Controls". A STOP, unsubscribe, complaint, invalid number or do-not-contact registration lands here and suppresses queued sends immediately.',
      },
      { action: 'Open "Contacts" and set the filters for the list you want.' },
      {
        action: 'Click "export_eligible", then state "export_purpose" — why this data is leaving.',
        note:
          'The purpose is required. An export with no stated purpose cannot be defended afterwards, which is the only moment anybody asks about it.',
      },
      { action: 'Click "run_export".' },
    ],
    successCheck:
      'The export names how many contacts were withheld and why. If that number is zero on a list you know contains an unsubscribe, stop and raise it — the gate is not working.',
  },
  {
    id: 'data-review-case-resolution',
    title: 'Resolve a Data Review case',
    group: 'Identity and trust',
    outcome: 'Clear a governed case and leave the evidence behind for it',
    minutes: 9,
    roles: ['Data Steward'],
    screen: '/app/data-review',
    grant: 'source_record.promote',
    grantHolder: 'Data Steward, who adjudicates identity merges and promotions.',
    steps: [
      { action: 'Open "Data Review" under Identity & trust.' },
      { action: 'Pick a case tile to filter the unified queue, then click "open_case" on a row.' },
      { action: 'Read the case report before deciding. Click "case_report" to open it.' },
      {
        action:
          'For a bulk resolution, click "bulk_resolve", then "acknowledge_blast_radius" to confirm you have seen how many records it touches, then "confirm_bulk".',
        note:
          'The blast radius acknowledgement is deliberate friction. A bulk resolution is the one action on this screen that cannot be reviewed row by row afterwards.',
      },
      { action: 'Click "open_next_case" to work the queue down rather than returning to the list.' },
    ],
    successCheck:
      'The case tile count drops by what you resolved, and the case appears on the audit timeline with your name against it.',
  },
  {
    id: 'audit-timeline-and-evidence-bundles',
    title: 'Read the audit timeline and pull an evidence bundle',
    group: 'Identity and trust',
    outcome: 'Answer "who did this, when, and what permitted it" with something you can hand over',
    minutes: 7,
    roles: ['Everyone', 'Privacy Officer', 'Leadership'],
    screen: '/app/audit',
    grant: null,
    grantHolder:
      'Reading the chain is deliberately open to every operator. audit.delete_event is the only gated audit capability, and it is denied to every role with no escalation path.',
    steps: [
      { action: 'Open "Audit & History" under Identity & trust.' },
      { action: 'Fill "subject_ref" with the record you are asking about.' },
      { action: 'Click "read_chain" to verify the chain across the range you are looking at.' },
      {
        action: 'Click "advanced_query" for a filtered search across governed actions.',
        note:
          'The search runs against sdk-search. Where no ProjexCloud gateway is configured the screen says so rather than showing an empty result, because "we could not check" and "nothing happened" are opposites here.',
      },
      { action: 'Click "export_evidence_bundle" to produce the pack you can hand to somebody else.' },
    ],
    successCheck:
      'The chain reports verified for your range, and the bundle names the actor, the purpose and the decision reference for every action in it. A chain that reports BROKEN is a finding, not a bug in this screen — escalate it.',
  },

  /* ----------------------------------------------------------------- revenue */
  {
    id: 'routing-configuration-and-decision-trace',
    title: 'Configure routing, then read a decision trace',
    group: 'Revenue',
    outcome: 'Change who gets which leads, and prove afterwards why one lead went where it went',
    minutes: 12,
    roles: ['Revenue Operations'],
    screen: '/app/routing-config',
    grant: 'routing.configure',
    grantHolder: 'Revenue Operations, which configures data, routing, automation and integrations.',
    steps: [
      { action: 'Open "Routing configuration" under Revenue.' },
      {
        action:
          'Work through the six steps of the decision engine in order. Each step narrows the candidate set; the order is the engine, not a layout.',
      },
      { action: 'Click "publish_config" when the configuration is what you intend to run.' },
      {
        action:
          'To explain a past decision, fill "trace_lead_id" with the lead and click "read_trace".',
      },
      { action: 'Click "open_decision_trace" on the result to see each step and why it fired.' },
      {
        action:
          'Before publishing anything consequential, open "Routing simulation" and replay it against real leads first.',
      },
    ],
    successCheck:
      'The trace for a lead you routed names the rule that matched and the step that chose the owner. If the trace is empty for a lead that has an owner, the assignment did not come from the engine — find out what set it.',
  },
  {
    id: 'coverage-and-the-opening-validation',
    title: 'Coverage and the 8:45 opening validation',
    group: 'Revenue',
    outcome: 'Confirm every window has a named person before the day starts',
    minutes: 6,
    roles: ['Sales Manager', 'Revenue Operations'],
    screen: '/app/coverage',
    grant: 'sla.configure',
    grantHolder: 'Revenue Operations unaided; a Sales Manager holds sla.configure with approval.',
    steps: [
      { action: 'Open "Coverage" under Revenue, at 8:45 local time.' },
      { action: 'Click "check_overnight_queue" and work anything that arrived out of hours.' },
      { action: 'Click "manager_confirms_coverage" once every window resolves to a named person.' },
      { action: 'Click "record_opening_validation" to stamp the day.' },
      {
        action:
          'If a window has no named person, do not record the validation. Fix the gap first — the stamp is the claim that somebody checked.',
      },
    ],
    successCheck:
      'The opening validation is recorded for today and no window shows an unnamed owner. A recorded validation over an uncovered window is worse than no validation, because it is a claim somebody will rely on.',
  },
  {
    id: 'pipeline-stage-gate-and-next-actions',
    title: 'The pipeline stage gate and NEXT actions',
    group: 'Revenue',
    outcome: 'Move a deal forward with an owner, a next action and a date on it',
    minutes: 7,
    roles: ['Sales Rep', 'Sales Manager'],
    screen: '/app/pipeline',
    grant: 'stage.update',
    grantHolder: 'Sales Rep and Backup Rep, on records they own or back up.',
    steps: [
      { action: 'Open "Pipeline" under Revenue.' },
      { action: 'Click "move_card" on the record you are advancing and pick a "target_stage".' },
      {
        action: 'Click "confirm_move".',
        note:
          'The gate refuses a move that would leave the record without an owner, a backup, a NEXT action or an intended outcome. That refusal is the product working.',
      },
      {
        action:
          'To change a due date, click "reschedule_next", set "next_due_date", give a "reschedule_reason" and click "confirm_reschedule".',
        note:
          'The reason is required. A silently moved date is how a slipping deal stops looking like one.',
      },
    ],
    successCheck:
      'The card sits in the new stage with a NEXT action and a date visible on it. If the move was refused, the message names which of the four the record is missing.',
  },
  {
    id: 'sequences-and-the-reply-pause',
    title: 'Sequences and the reply-pause rule',
    group: 'Revenue',
    outcome: 'Run automated follow-up that stops the moment a human replies',
    minutes: 8,
    roles: ['Revenue Operations', 'Marketing Ops'],
    screen: '/app/sequences',
    grant: 'automation.publish',
    grantHolder: 'Revenue Operations unaided; a Sales Manager holds automation.publish with approval.',
    steps: [
      { action: 'Open "Sequences" under Revenue.' },
      {
        action:
          'Read each sequence with its steps, then the reply-paused list and the suppressed list beneath it.',
      },
      {
        action:
          'An inbound reply pauses the enrollment and raises an urgent task for the owner. You do not do this; you check that it happened.',
      },
      {
        action:
          'To stop everything on one sequence, click "pause_sequence", give a "pause_reason" and click "confirm_pause".',
        note:
          'This is the loop breaker. It cancels every queued step across every enrollment on that sequence, which is what you want during a duplicate-send incident and never what you want by accident.',
      },
    ],
    successCheck:
      'A contact who replied appears in the reply-paused list with the reason, and the sequence shows no further queued steps for them.',
  },
  {
    id: 'approved-templates-and-the-sms-gate',
    title: 'The approved template library and the SMS gate',
    group: 'Revenue',
    outcome: 'Send governed messages whose wording you can account for afterwards',
    minutes: 6,
    roles: ['Marketing Ops', 'Revenue Operations'],
    screen: '/app/templates',
    grant: 'message.publish_template',
    grantHolder: 'Marketing Ops and Revenue Operations. A Sales Rep holds it with approval.',
    steps: [
      { action: 'Open "Message templates" under Revenue.' },
      {
        action:
          'Read "The SMS gate". An automated text runs only with an approved eligibility or consent basis AND inside allowed hours.',
      },
      {
        action:
          'Check "Triggers with no approved template". Each one is a moment the playbook expects a message and none can be sent.',
      },
      {
        action: 'Click "new_template" to add one.',
        note:
          'Without message.publish_template the control is disabled and the screen names the grant. You can still read the whole library.',
      },
      {
        action:
          'Give the template ONE intended action, and keep the opt-out wording in the body rather than attaching it at send time.',
      },
    ],
    successCheck:
      'The uncovered-trigger list is shorter than when you started, and every template you added shows an Opt-out value rather than "Absent - cannot publish".',
  },

  /* ------------------------------------------------------------------ insight */
  {
    id: 'go-live-governance',
    title: 'Post-mortems, certification and go-live',
    group: 'Insight',
    outcome: 'Close an incident properly and know whether the product may go live',
    minutes: 11,
    roles: ['Leadership', 'Revenue Operations'],
    screen: '/app/governance',
    grant: 'legal_policy.approve',
    grantHolder:
      'Privacy Officer unaided; Revenue Operations holds it with approval. This is why Governance shows as Locked for most operators.',
    steps: [
      { action: 'Open "Governance" under Insight.' },
      { action: 'Read the go-live gates and the signatures. Both must be complete; neither substitutes for the other.' },
      {
        action:
          'For a post-mortem, click "add_corrective_action", then fill "action_text", "action_owner" and "action_due" for each one.',
      },
      {
        action: 'Click "submit_post_mortem" when every corrective action has an owner and a date.',
        note:
          'A corrective action without a named owner is a wish. The form asks for one because a post-mortem nobody owns changes nothing.',
      },
      {
        action:
          'Check rep certification before expecting live P0 or P1 leads to flow — until it passes, they do not.',
      },
    ],
    successCheck:
      'The go-live panel states ready, or names the specific gate and the missing signature. "Not ready" with a named cause is a good outcome; "ready" with a gate you know is unmet is the one to escalate.',
  },

  /* ----------------------------------------------------------- administration */
  {
    id: 'adding-a-user',
    title: 'Add a user and assign a role',
    group: 'Administration',
    outcome: 'Get a new colleague onto the register with the authority they need, and no more',
    minutes: 6,
    roles: ['Revenue Operations', 'Sales Manager'],
    screen: '/app/admin/users',
    grant: 'user.invite',
    grantHolder:
      'Revenue Operations unaided; a Sales Manager holds it with a second party\'s approval.',
    steps: [
      { action: 'Open "User Administration" under Administration.' },
      { action: 'Fill "email", and "first_name" and "last_name" if you have them.' },
      {
        action:
          'Choose a "role". Read the panel beside the picker before you commit — it lists exactly what the role grants unaided and what it needs approval for.',
      },
      { action: 'Click "invite_user".' },
      {
        action:
          'The account is created PENDING with no usable password. Find the row and click its Activate control to open it for use.',
        note:
          'LeadFlow has no mail transport, so there is no invitation link to send. Activation is a second, deliberate act rather than something that happens on the invitee\'s behalf.',
      },
      {
        action:
          'To change somebody\'s role later, use the role dropdown on their row. The change is written to the audit chain with the role they held before it.',
      },
    ],
    successCheck:
      'The person appears on the register as active with the role you chose, and the sidebar entries that role unlocks are clickable when they sign in rather than Locked.',
  },
  {
    id: 'what-each-role-can-do',
    title: 'What each role can do, and why Locked is not a bug',
    group: 'Administration',
    outcome: 'Answer "why is this greyed out" without opening a support ticket',
    minutes: 5,
    roles: ['Everyone'],
    screen: '/app/admin/permissions',
    grant: null,
    grantHolder:
      'Nothing gates this screen. It explains why the OTHER screens are Locked, so hiding it from the people being refused would be the one gate that makes the product less honest.',
    steps: [
      { action: 'Open "Permission Matrix" under Administration.' },
      {
        action:
          'Find the role in the left column. "Can do" is what it may do alone; "Needs approval" is what it may do with a second party.',
      },
      {
        action:
          'Needs approval is NOT denied. It is an escalation path, and the product will tell you so rather than refusing you outright.',
      },
      {
        action:
          'Match the greyed-out screen to its grant: Governance needs legal_policy.approve, Offers needs offer.change_terms, Campaign Enrollment needs campaign.configure.',
      },
      {
        action:
          'The grid cannot be edited here, and there is no hidden control that would let you. Roles and policies are versioned code; changing what a role grants means shipping a change, not clicking a cell.',
      },
    ],
    successCheck:
      'You can take any Locked sidebar entry, name the grant it needs and name a role that holds it.',
  },
];

/** Every guide in one group, in declaration order. */
export function guidesInGroup(group: TrainingGroup): TrainingGuide[] {
  return TRAINING_GUIDES.filter((guide) => guide.group === group);
}

/** One guide by its slug. */
export function guideById(id: string): TrainingGuide | undefined {
  return TRAINING_GUIDES.find((guide) => guide.id === id);
}

/**
 * The guide for the screen the reader is currently on.
 *
 * LONGEST MATCH WINS, so `/app/admin/users` resolves to the register's guide
 * rather than to anything matching the `/app` prefix, and a deep link such as
 * `/app/contacts/<id>/overview` still finds the guide for `/app/contacts` if one
 * is ever written. Returns undefined rather than a default: a Guide button that
 * silently opens the wrong guide is worse than one that opens the index.
 */
export function guideForPath(pathname: string): TrainingGuide | undefined {
  return TRAINING_GUIDES.filter(
    (guide) => guide.screen !== null && (pathname === guide.screen || pathname.startsWith(`${guide.screen}/`))
  ).sort((a, b) => (b.screen ?? '').length - (a.screen ?? '').length)[0];
}
