import { Link, useParams } from 'react-router-dom';
import {
  TRAINING_GROUPS,
  guideById,
  guidesInGroup,
  type TrainingGuide,
} from '../../content/trainingGuides';
import { isAllowed, usePermissions } from '../../platform/permissions';
import { chipClass } from '../../design-system/tokens';

/**
 * The training centre — card grid and one-guide view on the same route.
 *
 * GROUPED THE WAY THE SIDEBAR IS GROUPED, so the map matches the product. A
 * training area organised by its own taxonomy makes the reader translate twice:
 * once from their problem to the training's categories, and again from a guide
 * back to where the screen actually lives.
 *
 * EVERY CARD STATES ITS GRANT, and the state of that grant is resolved LIVE
 * against the policy decision point rather than described. "Most support
 * questions on this product will be why is this greyed out, and the answer is
 * nearly always a role" — so a card that names the grant AND tells the reader
 * whether they personally hold it has answered the question before it is asked.
 *
 * WHAT THIS DOES NOT DO. There is no guide for a screen that renders Soon, and
 * where a single step is behind a grant the reader may lack, the step says so
 * rather than describing a flow they cannot complete. Training that does not
 * match the product teaches people the product is broken.
 */

/** Every distinct grant the guides mention, for one batched PDP call. */
const GUIDE_ACTIONS = [
  ...new Set(
    TRAINING_GROUPS.flatMap((group) => guidesInGroup(group))
      .map((guide) => guide.grant)
      .filter((grant): grant is string => grant !== null)
  ),
];

/** The reader's standing with one guide's grant. */
type GrantStanding = 'open' | 'held' | 'not_held' | 'checking';

function standingFor(
  guide: TrainingGuide,
  loading: boolean,
  allowed: (action: string) => boolean
): GrantStanding {
  if (guide.grant === null) return 'open';
  if (loading) return 'checking';
  return allowed(guide.grant) ? 'held' : 'not_held';
}

const STANDING_TEXT: Record<GrantStanding, string> = {
  open: 'No grant needed',
  held: 'You hold this',
  not_held: 'You do not hold this',
  checking: 'Checking your permissions...',
};

const STANDING_ROLE = {
  open: 'info',
  held: 'success',
  not_held: 'warning',
  checking: 'info',
} as const;

/** One card in the grid. */
function GuideCard({ guide, standing }: { guide: TrainingGuide; standing: GrantStanding }) {
  return (
    <li className="lf-card flex flex-col p-4">
      <Link to={`/app/training/${guide.id}`} className="text-sm font-semibold text-text hover:underline">
        {guide.title}
      </Link>
      <p className="mt-1 flex-1 text-sm text-muted">{guide.outcome}</p>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <span className="lf-pill border-line2 text-soft">{guide.minutes} min</span>
        {guide.roles.map((role) => (
          <span key={role} className={`lf-pill border ${chipClass('info')}`}>
            {role}
          </span>
        ))}
      </div>

      <p className="mt-3 text-xs text-soft">
        {guide.grant === null ? 'Open to every operator.' : `Needs ${guide.grant}.`}{' '}
        <span className={`lf-pill border ${chipClass(STANDING_ROLE[standing])}`}>
          {STANDING_TEXT[standing]}
        </span>
      </p>
    </li>
  );
}

/** The card grid. */
function GuideIndex({
  loading,
  allowed,
}: {
  loading: boolean;
  allowed: (action: string) => boolean;
}) {
  return (
    <div className="mx-auto max-w-7xl">
      <h1 className="text-2xl font-bold text-text">Training Centre</h1>
      <p className="mt-1.5 max-w-3xl text-sm text-muted">
        Step-by-step guides for the screens this product actually has. Each one ends with how you
        will know it worked, and each card states the grant its task needs — because "why is this
        greyed out" is nearly always a role rather than a fault.
      </p>

      <p className="mt-4 rounded border border-line bg-panel2 px-3 py-2 text-sm text-muted">
        Stuck on a particular screen? Use the "Guide" button in the top bar and you will land on
        the guide for the screen you are looking at.
      </p>

      {TRAINING_GROUPS.map((group) => {
        const guides = guidesInGroup(group);
        if (guides.length === 0) return null;
        return (
          <section key={group} className="mt-6" aria-label={group}>
            <h2 className="lf-eyebrow">{group}</h2>
            <ul className="mt-2 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {guides.map((guide) => (
                <GuideCard
                  key={guide.id}
                  guide={guide}
                  standing={standingFor(guide, loading, allowed)}
                />
              ))}
            </ul>
          </section>
        );
      })}

      <section className="lf-panel mt-6 p-5" aria-label="Screens with no guide">
        <h2 className="lf-eyebrow">Screens with no guide, and why</h2>
        <p className="mt-1 text-sm text-muted">
          Contact Command and Associated Properties render as "Soon" in the sidebar because they
          are not built. There is deliberately no guide for either: a guide describing a flow you
          cannot complete teaches you the product is broken, which is worse than admitting the
          screen is not here yet.
        </p>
      </section>
    </div>
  );
}

/** One guide, in full. */
function GuideDetail({
  guide,
  standing,
}: {
  guide: TrainingGuide;
  standing: GrantStanding;
}) {
  return (
    <div className="mx-auto max-w-4xl">
      <Link to="/app/training" className="text-sm text-muted hover:underline">
        Back to all guides
      </Link>

      <h1 className="mt-2 text-2xl font-bold text-text">{guide.title}</h1>
      <p className="mt-1.5 text-sm text-muted">{guide.outcome}</p>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <span className="lf-pill border-line2 text-soft">{guide.group}</span>
        <span className="lf-pill border-line2 text-soft">{guide.minutes} min</span>
        {guide.roles.map((role) => (
          <span key={role} className={`lf-pill border ${chipClass('info')}`}>
            {role}
          </span>
        ))}
        <span className={`lf-pill border ${chipClass(STANDING_ROLE[standing])}`}>
          {STANDING_TEXT[standing]}
        </span>
      </div>

      <section className="lf-panel mt-4 p-5" aria-label="What this needs">
        <h2 className="lf-eyebrow">What this needs</h2>
        <p className="mt-1 text-sm text-muted">
          {guide.grant === null
            ? 'No grant. Every operator can do this.'
            : `This task needs ${guide.grant}.`}
        </p>
        {guide.grantHolder && <p className="mt-1 text-sm text-muted">{guide.grantHolder}</p>}
        {standing === 'not_held' && (
          <p className="mt-2 rounded border border-gold/40 bg-gold/10 px-3 py-2 text-sm text-gold">
            You do not hold this grant, so the controls named below will be disabled for you. That
            is the policy answering, not a fault. Ask an administrator, or open the Permission
            Matrix to see which role holds it.
          </p>
        )}
      </section>

      <section className="lf-panel mt-4 p-5" aria-label="Steps">
        <h2 className="lf-eyebrow">Steps</h2>
        <ol className="mt-2 space-y-3">
          {guide.steps.map((step, index) => (
            <li key={`${guide.id}-step-${index}`} className="lf-card p-3">
              <p className="text-sm text-text">
                <span className="text-soft">{index + 1}.</span> {step.action}
              </p>
              {step.note && <p className="mt-1 text-xs text-soft">{step.note}</p>}
            </li>
          ))}
        </ol>
      </section>

      <section className="lf-panel mt-4 border-green/40 p-5" aria-label="You will know it worked when">
        <h2 className="lf-eyebrow text-green">You will know it worked when</h2>
        <p className="mt-1 text-sm text-muted">{guide.successCheck}</p>
      </section>

      {guide.screen && (
        <Link to={guide.screen} className="lf-btn-primary mt-4 inline-block px-4 py-2">
          Open the screen
        </Link>
      )}
    </div>
  );
}

export default function TrainingCentre() {
  const { guideId } = useParams<{ guideId: string }>();

  // ONE batch for every grant the guides mention, so opening the index does not
  // spend one round trip per card before its first paint.
  const permissions = usePermissions(
    GUIDE_ACTIONS.map((action) => ({ action, resourceType: 'screen' }))
  );
  const allowed = (action: string): boolean => isAllowed(permissions, action);

  const guide = guideId ? guideById(guideId) : undefined;

  if (guideId && !guide) {
    return (
      <div className="mx-auto max-w-4xl">
        <h1 className="text-2xl font-bold text-text">No such guide</h1>
        <p className="mt-1.5 text-sm text-muted">
          There is no guide with that name. It may have been renamed, or it may never have
          existed — a guide is not written for a screen that is not built.
        </p>
        <Link to="/app/training" className="lf-btn-ghost mt-4 inline-block px-4 py-2">
          Back to all guides
        </Link>
      </div>
    );
  }

  return guide ? (
    <GuideDetail guide={guide} standing={standingFor(guide, permissions.loading, allowed)} />
  ) : (
    <GuideIndex loading={permissions.loading} allowed={allowed} />
  );
}
