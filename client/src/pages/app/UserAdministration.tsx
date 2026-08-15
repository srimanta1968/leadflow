import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  ApiError,
  type LocalRoleSummary,
  type RegisterUser,
  type UserRegisterList,
} from '../../services/api';
import { DataTable, type Column } from '../../design-system/data/DataTable';
import { isAllowed, usePermissions } from '../../platform/permissions';
import { chipClass } from '../../design-system/tokens';
import { AddressVerdict, useAddressCheck } from '../../features/email/AddressCheck';

/**
 * The user register — the screen that did not exist.
 *
 * BEFORE THIS, THERE WAS NO WAY TO ADD A COLLEAGUE OR CHANGE A ROLE. `/signup`
 * creates a TENANT rather than a teammate, no user create or update route
 * existed, and `users.role` could be set only by the development seed — which
 * refuses to run under NODE_ENV=production — or by editing the database by hand.
 * The consequence was visible in the sidebar rather than in a log: Governance,
 * Offers and Campaign Enrollment were permanently Locked for every user, because
 * no local role bridged to the SOP roles holding legal_policy.approve,
 * offer.change_terms and campaign.configure, and there was no screen through
 * which anybody could grant them.
 *
 * THE ROLE PICKER SPELLS OUT WHAT IT GRANTS, and that is the point of it rather
 * than a nicety. "steward" tells an operator nothing; "can promote a source
 * record and review identity merges" tells them everything. The wording is not
 * written here — it is read from GET /api/users/roles, which derives it from the
 * role bridge and the SOP role definitions at request time, so a screen cannot
 * describe an authority the server no longer grants.
 *
 * DEACTIVATE, NEVER DELETE. Every audit entry, routing rule, lead assignment and
 * coverage window names a user id. A departed colleague's actions have to stay
 * attributable, so the row survives and only the ability to sign in goes.
 */

/** How each state is chipped. Pending is work outstanding, not a problem. */
const STATE_ROLE = {
  pending: 'warning',
  active: 'success',
  deactivated: 'blocked',
} as const;

/** A short, plain-language gloss for each assignable role. */
const ROLE_LABEL: Record<string, string> = {
  admin: 'Administrator',
  manager: 'Manager',
  user: 'Team member',
  steward: 'Data steward',
  privacy: 'Privacy officer',
};

const displayName = (user: RegisterUser): string =>
  [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email;

const shortDate = (value: string | null): string =>
  value ? new Date(value).toISOString().slice(0, 10) : '--';

/**
 * What one role grants, as the picker shows it.
 *
 * Rendered beside the picker rather than in a tooltip: the decision this screen
 * asks somebody to make is "should this person hold this authority", and a
 * tooltip is not where you put the only material that answers it.
 */
function RoleExplainer({ role }: { role: LocalRoleSummary | undefined }) {
  if (!role) {
    return (
      <p className="text-sm text-muted">Choose a role to see what it grants.</p>
    );
  }

  if (role.grants_nothing) {
    return (
      <p className="rounded border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">
        This value is not recognised by the role bridge, so it would grant nothing at all.
      </p>
    );
  }

  return (
    <div>
      <ul className="space-y-2">
        {role.sop_roles.map((sop) => (
          <li key={sop.key}>
            <p className="text-sm font-medium text-text">{sop.label}</p>
            <p className="text-sm text-muted">{sop.purpose}</p>
          </li>
        ))}
      </ul>

      <p className="lf-eyebrow mt-4">Can do unaided</p>
      <ul className="mt-1 flex flex-wrap gap-1.5">
        {role.can_do.map((action) => (
          <li key={action} className={`lf-pill border ${chipClass('success')}`}>
            {action}
          </li>
        ))}
      </ul>

      {role.requires_approval.length > 0 && (
        <>
          <p className="lf-eyebrow mt-4">Needs a second party</p>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {role.requires_approval.map((action) => (
              <li key={action} className={`lf-pill border ${chipClass('warning')}`}>
                {action}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export default function UserAdministration() {
  const [data, setData] = useState<UserRegisterList | null>(null);
  const [roles, setRoles] = useState<LocalRoleSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteFirstName, setInviteFirstName] = useState('');
  const [inviteLastName, setInviteLastName] = useState('');
  const [inviteRole, setInviteRole] = useState('user');
  // The address is checked before the invitation is sent, not after it bounces.
  const addressCheck = useAddressCheck();
  const [busy, setBusy] = useState(false);

  const permissions = usePermissions([
    { action: 'user.invite', resourceType: 'user' },
    { action: 'user.role_assign', resourceType: 'user' },
    { action: 'user.deactivate', resourceType: 'user' },
  ]);
  const mayInvite = isAllowed(permissions, 'user.invite');
  const mayAssignRole = isAllowed(permissions, 'user.role_assign');
  const mayChangeAccess = isAllowed(permissions, 'user.deactivate');

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      // Deactivated accounts are included: they are the evidence for the claim
      // this screen makes about attribution, and hiding them would leave an
      // administrator wondering where a departed colleague went.
      const [register, catalogue] = await Promise.all([
        api.userRegister(true, signal),
        api.assignableRoles(signal),
      ]);
      setData(register);
      setRoles(catalogue.roles);
      setError(null);
    } catch (caught) {
      if (signal?.aborted) return;
      setData(null);
      setError(caught instanceof ApiError ? caught.message : 'The register could not be read.');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  /** Run one governed write, then reload so the table cannot disagree with it. */
  async function run(work: () => Promise<string>): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await work());
      await load();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'APPROVAL_REQUIRED') {
        // The distinct code exists precisely so this reads differently from a
        // refusal: the caller MAY do this, with a second party.
        setError(`${caught.message} This action is open to you with a second party's approval.`);
      } else {
        setError(caught instanceof ApiError ? caught.message : 'That change could not be saved.');
      }
    } finally {
      setBusy(false);
    }
  }

  function handleInvite(event: React.FormEvent): void {
    event.preventDefault();
    void run(async () => {
      const result = await api.inviteUser({
        email: inviteEmail.trim(),
        role: inviteRole,
        first_name: inviteFirstName.trim() || undefined,
        last_name: inviteLastName.trim() || undefined,
      });
      setInviteEmail('');
      setInviteFirstName('');
      setInviteLastName('');
      addressCheck.reset();
      const placed = `${result.user.email} is on the register as ${ROLE_LABEL[result.user.role] ?? result.user.role}, pending activation.`;
      /* THE DELIVERY OUTCOME IS PART OF THE OUTCOME. The link is the only way
         into an invited account, so "added to the register" on its own is a
         half-truth an administrator will read as done. */
      return `${placed} ${result.invitation.detail}`;
    });
  }

  const selectedRole = roles.find((entry) => entry.key === inviteRole);

  const columns: Column<RegisterUser>[] = [
    {
      key: 'person',
      header: 'Person',
      width: '24%',
      cell: (row) => (
        <span>
          <span className="text-text">{displayName(row)}</span>
          <span className="block text-xs text-soft">{row.email}</span>
        </span>
      ),
    },
    {
      key: 'state',
      header: 'State',
      width: '10%',
      cell: (row) => (
        <span className={`lf-pill ${chipClass(STATE_ROLE[row.state])}`}>{row.state}</span>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      width: '22%',
      cell: (row) => (
        <select
          name={`role_${row.id}`}
          aria-label={`Role for ${displayName(row)}`}
          value={row.role}
          disabled={!mayAssignRole || busy}
          onChange={(event) =>
            void run(async () => {
              const result = await api.assignUserRole(row.id, event.target.value);
              if (!result.changed) {
                return `${displayName(row)} already held ${result.user.role}; nothing changed.`;
              }
              // The persona outcome is reported rather than assumed. A local
              // role change on a linked account is only half the act, and a
              // message that stopped at "moved to manager" would claim an
              // authority the platform session may not actually enforce.
              return `${displayName(row)} moved from ${result.previous_role} to ${result.user.role}. The change is in the audit chain with both roles. ${result.persona.detail}`;
            })
          }
          className="w-full rounded border border-line bg-panel2 px-2 py-1 text-sm text-text disabled:cursor-not-allowed disabled:opacity-50"
        >
          {roles.map((entry) => (
            <option key={entry.key} value={entry.key}>
              {ROLE_LABEL[entry.key] ?? entry.key}
            </option>
          ))}
        </select>
      ),
    },
    {
      key: 'invited',
      header: 'Invited',
      width: '10%',
      cell: (row) => shortDate(row.invited_at),
    },
    {
      key: 'closed',
      header: 'Closed',
      width: '10%',
      cell: (row) => shortDate(row.deactivated_at),
    },
    {
      key: 'access',
      header: 'Access',
      width: '24%',
      cell: (row) =>
        row.state === 'active' ? (
          <button
            type="button"
            name={`deactivate_${row.id}`}
            disabled={!mayChangeAccess || busy}
            onClick={() =>
              void run(async () => {
                const result = await api.deactivateUser(row.id, 'closed from the user register');
                return `${displayName(row)} can no longer sign in here. Their past actions stay attributable. ${result.persona_note}`;
              })
            }
            className="lf-btn-ghost px-3 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
          >
            Deactivate
          </button>
        ) : (
          <button
            type="button"
            name={`activate_${row.id}`}
            disabled={!mayChangeAccess || busy}
            onClick={() =>
              void run(async () => {
                const result = await api.activateUser(row.id);
                return result.credential_issued
                  ? `${displayName(row)} is active and holds a credential.`
                  : `${displayName(row)} is active. No password was issued, so they still cannot sign in.`;
              })
            }
            className="lf-btn-ghost px-3 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
          >
            Activate
          </button>
        ),
    },
  ];

  return (
    <div className="mx-auto max-w-7xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-text">User Administration</h1>
          <p className="mt-1.5 max-w-3xl text-sm text-muted">
            Who is on this team, what each of them may do, and who decided. Adding a colleague
            and letting them in are two separate governed acts, and every role change is written
            to the audit chain with the role held before it.
          </p>
        </div>
        <Link to="/app/admin/permissions" className="lf-btn-ghost px-4 py-2">
          See what each role grants
        </Link>
      </div>

      {!mayInvite && (
        <p className="mt-4 rounded border border-gold/40 bg-gold/10 px-3 py-2 text-sm text-gold">
          You may read the register but not change it. Inviting a colleague requires user.invite,
          which Revenue Operations holds unaided and a Manager holds with approval.
        </p>
      )}

      {notice && (
        <p className="mt-4 rounded border border-green/40 bg-green/10 px-3 py-2 text-sm text-green">
          {notice}
        </p>
      )}

      {error && (
        <p className="mt-4 rounded border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">
          {error}
        </p>
      )}

      {/* ------------------------------------------------------- the invite */}
      <section className="lf-panel mt-6 p-5" aria-label="Invite a colleague">
        <h2 className="lf-eyebrow">Invite a colleague</h2>
        <div className="mt-3 grid gap-6 lg:grid-cols-2">
          <form onSubmit={handleInvite} className="space-y-3">
            <label className="block text-sm">
              <span className="text-muted">Email</span>
              <input
                type="email"
                name="email"
                required
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
                /* ON BLUR, NOT ON EVERY KEYSTROKE. "ada@g" is not an address
                   anybody meant, and checking it would spend a DNS query to
                   tell somebody mid-word that their half-typed domain does not
                   exist. */
                onBlur={(event) => addressCheck.check(event.target.value)}
                disabled={!mayInvite || busy}
                className="mt-1 w-full rounded border border-line bg-panel2 px-3 py-2 text-sm text-text disabled:opacity-50"
              />
              <AddressVerdict
                verification={addressCheck.verification}
                checking={addressCheck.checking}
                onAcceptSuggestion={(address) => {
                  setInviteEmail(address);
                  addressCheck.check(address);
                }}
              />
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="text-muted">First name</span>
                <input
                  type="text"
                  name="first_name"
                  value={inviteFirstName}
                  onChange={(event) => setInviteFirstName(event.target.value)}
                  disabled={!mayInvite || busy}
                  className="mt-1 w-full rounded border border-line bg-panel2 px-3 py-2 text-sm text-text disabled:opacity-50"
                />
              </label>
              <label className="block text-sm">
                <span className="text-muted">Last name</span>
                <input
                  type="text"
                  name="last_name"
                  value={inviteLastName}
                  onChange={(event) => setInviteLastName(event.target.value)}
                  disabled={!mayInvite || busy}
                  className="mt-1 w-full rounded border border-line bg-panel2 px-3 py-2 text-sm text-text disabled:opacity-50"
                />
              </label>
            </div>

            <label className="block text-sm">
              <span className="text-muted">Role</span>
              <select
                name="role"
                value={inviteRole}
                onChange={(event) => setInviteRole(event.target.value)}
                disabled={!mayInvite || busy}
                className="mt-1 w-full rounded border border-line bg-panel2 px-3 py-2 text-sm text-text disabled:opacity-50"
              >
                {roles.map((entry) => (
                  <option key={entry.key} value={entry.key}>
                    {ROLE_LABEL[entry.key] ?? entry.key}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="submit"
              name="invite_user"
              disabled={!mayInvite || busy}
              className="lf-btn-primary px-4 py-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Send invitation
            </button>

            <p className="text-xs text-soft">
              A new account starts pending, with no usable password: the invitation link is the
              only way into it. The address is checked before anything is sent — an address with
              no mail server behind it is refused here rather than bounced later, and the reason
              is reported above.
            </p>
          </form>

          <div className="lf-card p-4">
            <h3 className="lf-eyebrow">What this role grants</h3>
            <div className="mt-2">
              <RoleExplainer role={selectedRole} />
            </div>
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------- the register */}
      <div className="lf-panel mt-4 p-5">
        <DataTable
          rows={data?.users ?? []}
          columns={columns}
          rowKey={(row) => row.id}
          loading={loading}
          density="dense"
          height={480}
          caption="The team register"
          error={error ? <span>{error}</span> : undefined}
          empty={<span>Nobody is on the register yet.</span>}
        />
      </div>

      {data && !data.local_credentials_permitted && (
        <p className="mt-4 rounded border border-gold/40 bg-gold/10 px-3 py-2 text-sm text-gold">
          ProjexCloud is the identity authority for this deployment, so no password can be issued
          here. Activation still opens the account; the credential comes from ProjexCloud.
        </p>
      )}

      <section className="lf-panel mt-4 p-5" aria-label="Where a role actually lives">
        <h2 className="lf-eyebrow">Where a role actually lives</h2>
        <p className="mt-1 text-sm text-muted">
          ProjexCloud is the identity authority. An account that projects a persona has its
          authority decided by that persona's grants, not by the local role column — so changing
          a role here also pushes it to the persona, and the confirmation tells you whether that
          landed. An account with no persona is local only, and the column is the whole story.
        </p>
        <p className="mt-2 text-sm text-muted">
          Closing an account stops local sign-in. It does not revoke a persona: for a linked
          colleague, revoke them in ProjexCloud as well. This screen says so rather than
          implying a revocation it cannot perform.
        </p>
      </section>

      <section className="lf-panel mt-4 p-5" aria-label="Why deactivation is not deletion">
        <h2 className="lf-eyebrow">Deactivation is not deletion</h2>
        <p className="mt-1 text-sm text-muted">
          Every audit entry, routing rule, lead assignment and coverage window names a user id.
          A departed colleague's actions must stay attributable, so the account is closed rather
          than removed and the register keeps the row with the date and the person who closed it.
        </p>
      </section>
    </div>
  );
}
