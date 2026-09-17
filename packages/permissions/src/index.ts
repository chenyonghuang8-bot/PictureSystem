export type FamilyRole = "SUPER_ADMIN" | "ADMIN" | "MEMBER";
export type InvitationRole = "ADMIN" | "MEMBER";
export type MemberMutation =
  | { kind: "ROLE"; role: Exclude<FamilyRole, "SUPER_ADMIN"> }
  | { kind: "DISABLED"; disabled: boolean };

export type AlbumVisibility = "FAMILY" | "CUSTOM";

export type AlbumPermissionGrant = {
  canView: boolean;
  canUpload: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canManageMembers: boolean;
};

export type AlbumPermissionContext = {
  membershipExists: boolean;
  memberActive: boolean;
  sameFamily: boolean;
  albumDeleted: boolean;
  isOwner: boolean;
  visibility: AlbumVisibility;
  explicitGrant?: AlbumPermissionGrant | null;
  /** Family role is deliberately ignored for album-content authorization. */
  familyRole?: FamilyRole;
};

const NO_ALBUM_PERMISSIONS: Readonly<AlbumPermissionGrant> = Object.freeze({
  canView: false,
  canUpload: false,
  canEdit: false,
  canDelete: false,
  canManageMembers: false,
});

const OWNER_ALBUM_PERMISSIONS: Readonly<AlbumPermissionGrant> = Object.freeze({
  canView: true,
  canUpload: true,
  canEdit: true,
  canDelete: true,
  canManageMembers: true,
});

export function evaluateAlbumPermissions(
  context: AlbumPermissionContext,
): AlbumPermissionGrant {
  if (
    !context.membershipExists ||
    !context.memberActive ||
    !context.sameFamily ||
    context.albumDeleted
  ) {
    return { ...NO_ALBUM_PERMISSIONS };
  }

  if (context.isOwner) return { ...OWNER_ALBUM_PERMISSIONS };

  const explicit = context.explicitGrant;
  const permissions: AlbumPermissionGrant = {
    canView: context.visibility === "FAMILY" || explicit?.canView === true,
    canUpload: explicit?.canUpload === true,
    canEdit: explicit?.canEdit === true,
    canDelete: explicit?.canDelete === true,
    canManageMembers: explicit?.canManageMembers === true,
  };

  if (!permissions.canView) return { ...NO_ALBUM_PERMISSIONS };
  return permissions;
}

export function canViewAlbum(context: AlbumPermissionContext) {
  return evaluateAlbumPermissions(context).canView;
}

export function canUploadToAlbum(context: AlbumPermissionContext) {
  return evaluateAlbumPermissions(context).canUpload;
}

export function canEditAlbum(context: AlbumPermissionContext) {
  return evaluateAlbumPermissions(context).canEdit;
}

export function canDeleteFromAlbum(context: AlbumPermissionContext) {
  return evaluateAlbumPermissions(context).canDelete;
}

export function canManageAlbumMembers(context: AlbumPermissionContext) {
  return evaluateAlbumPermissions(context).canManageMembers;
}

export function isPermissionSubset(
  grantor: AlbumPermissionGrant,
  candidate: AlbumPermissionGrant,
) {
  return (
    (!candidate.canView || grantor.canView) &&
    (!candidate.canUpload || grantor.canUpload) &&
    (!candidate.canEdit || grantor.canEdit) &&
    (!candidate.canDelete || grantor.canDelete) &&
    (!candidate.canManageMembers || grantor.canManageMembers)
  );
}

export function canIssueInvitation(
  actorRole: FamilyRole,
  invitationRole: InvitationRole,
) {
  return (
    actorRole === "SUPER_ADMIN" ||
    (actorRole === "ADMIN" && invitationRole === "MEMBER")
  );
}

export function canListInvitations(actorRole: FamilyRole) {
  return actorRole === "SUPER_ADMIN" || actorRole === "ADMIN";
}

export function canRevokeInvitation(
  actorRole: FamilyRole,
  invitationRole: InvitationRole,
) {
  return (
    actorRole === "SUPER_ADMIN" ||
    (actorRole === "ADMIN" && invitationRole === "MEMBER")
  );
}

export function canManageMember(input: {
  actorRole: FamilyRole;
  actorMemberId: string;
  targetRole: FamilyRole;
  targetMemberId: string;
  mutation: MemberMutation;
}) {
  if (
    input.actorMemberId === input.targetMemberId ||
    input.targetRole === "SUPER_ADMIN"
  ) {
    return false;
  }
  if (input.actorRole === "SUPER_ADMIN") return true;
  return (
    input.actorRole === "ADMIN" &&
    input.targetRole === "MEMBER" &&
    input.mutation.kind === "DISABLED"
  );
}
