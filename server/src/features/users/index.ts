/**
 * The user register — invitation, role assignment, activation and closure.
 *
 * The one place in the product where somebody is added to the team or has their
 * authority changed. Before this existed, `users.role` could be set only by the
 * development seed or by editing the database by hand, which meant three SOP
 * roles had no local holder and the screens gated on them were permanently
 * Locked for everybody.
 */
export { UserAdminController } from './userAdminController';
export {
  localRoleCatalogue,
  isAssignableLocalRole,
  permissionMatrix,
  allPolicyActions,
} from './roleCatalogue';
export type { LocalRoleSummary, SopRoleSummary, MatrixRow } from './roleCatalogue';
export { toRegisterUser, stateOf, listRegister, findUserById, findUserByEmail } from './userRegister';
export type { RegisterUser, RegisterState } from './userRegister';
