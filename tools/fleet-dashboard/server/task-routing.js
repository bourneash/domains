'use strict';

// Editorial/marketing ownership is distinct from implementation ownership.
// Technical follow-on work should use type=engineering after the owning role
// has made the editorial or marketing decision.
const OWNERS_BY_TYPE = Object.freeze({
  seo: ['seo-analyst'],
  content: ['content-writer'],
  refresh: ['content-writer'],
  marketing: ['social-media'],
  social: ['social-media'],
});

function ownersForType(type) {
  return (
    OWNERS_BY_TYPE[
      String(type || '')
        .trim()
        .toLowerCase()
    ] || []
  );
}

function assignedRoleForType(type, assignedRole) {
  const owners = ownersForType(type);
  if (owners.length && !owners.includes(String(assignedRole || '').trim())) return owners[0];
  return assignedRole || undefined;
}

function ownershipMismatch(type, assignedRole) {
  const owners = ownersForType(type);
  if (!owners.length || owners.includes(String(assignedRole || '').trim())) return null;
  return { expected_role: owners[0], allowed_roles: owners };
}

module.exports = { OWNERS_BY_TYPE, assignedRoleForType, ownershipMismatch, ownersForType };
