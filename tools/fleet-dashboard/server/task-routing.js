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

// These are role-equivalent fallbacks for sites whose installed role set
// predates the fleet-wide canonical names. They are intentionally ordered:
// prefer the canonical owner, then the site's closest existing specialist,
// and use engineering only when no content/SEO specialist exists.
const SITE_FALLBACKS_BY_TYPE = Object.freeze({
  seo: ['seo-analyst', 'engineer', 'principal-engineer'],
  content: [
    'content-writer',
    'news-writer',
    'guide-writer',
    'weekly-editorial',
    'breaking-news',
    'engineer',
    'principal-engineer',
  ],
  refresh: [
    'content-writer',
    'news-writer',
    'guide-writer',
    'weekly-editorial',
    'breaking-news',
    'engineer',
    'principal-engineer',
  ],
  marketing: ['social-media', 'social-poster', 'promoter', 'engineer', 'principal-engineer'],
  social: ['social-media', 'social-poster', 'promoter', 'engineer', 'principal-engineer'],
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

function assignedRoleForSite(type, assignedRole, availableRoles = []) {
  const normalized = String(type || '')
    .trim()
    .toLowerCase();
  const available = new Set(
    (Array.isArray(availableRoles) ? availableRoles : [])
      .map(role => String(role || '').trim())
      .filter(Boolean)
  );
  if (!available.size) return assignedRoleForType(type, assignedRole);
  const candidates = SITE_FALLBACKS_BY_TYPE[normalized];
  if (!candidates?.length)
    return available.has(String(assignedRole || '').trim())
      ? assignedRole
      : assignedRole || undefined;
  const requested = String(assignedRole || '').trim();
  // Preserve an explicitly selected role when it is actually installed and
  // belongs to the allowed lane; otherwise do not route into a nonexistent
  // canonical role just because the site uses an older naming convention.
  if (requested && candidates.includes(requested) && available.has(requested)) return requested;
  return (
    candidates.find(role => available.has(role)) ||
    (available.has('engineer') ? 'engineer' : undefined)
  );
}

function ownershipMismatch(type, assignedRole) {
  const owners = ownersForType(type);
  if (!owners.length || owners.includes(String(assignedRole || '').trim())) return null;
  return { expected_role: owners[0], allowed_roles: owners };
}

module.exports = {
  OWNERS_BY_TYPE,
  SITE_FALLBACKS_BY_TYPE,
  assignedRoleForType,
  assignedRoleForSite,
  ownershipMismatch,
  ownersForType,
};
