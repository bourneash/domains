'use strict';

// Editorial/marketing ownership is distinct from implementation ownership.
// Technical follow-on work should use type=engineering after the owning role
// has made the editorial or marketing decision.
const OWNERS_BY_TYPE = Object.freeze({
  engineering: ['engineer'],
  seo: ['seo-analyst'],
  content: ['content-writer'],
  refresh: ['content-writer'],
  marketing: ['social-media'],
  social: ['social-media'],
});

// These are role-equivalent fallbacks for sites whose installed role set
// predates the fleet-wide canonical names. They are intentionally ordered:
// prefer the canonical owner, then the site's closest existing specialist.
// SEO intentionally has no engineering fallback: growth strategy, content,
// and link-building are outside the engineer role's authority. Technical SEO
// work is filed as engineering separately by the producer.
const SITE_FALLBACKS_BY_TYPE = Object.freeze({
  engineering: ['engineer', 'principal-engineer'],
  seo: ['seo-analyst'],
  content: ['content-writer', 'news-writer', 'guide-writer', 'weekly-editorial', 'breaking-news'],
  refresh: ['content-writer', 'news-writer', 'guide-writer', 'weekly-editorial', 'breaking-news'],
  marketing: ['social-media', 'social-poster', 'promoter'],
  social: ['social-media', 'social-poster', 'promoter'],
});

// Executive review roles are control-plane workers, not site mutation roles.
// They may run only bounded report-only work and never qualify for direct
// deployment or production changes.
const EXECUTIVE_READ_ONLY_ROLES = Object.freeze(['legal']);

function isExecutiveReadOnlyRole(role, deliveryMode) {
  return (
    EXECUTIVE_READ_ONLY_ROLES.includes(String(role || '').trim()) && deliveryMode === 'report_only'
  );
}

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

function assignedRoleForSite(type, assignedRole, availableRoles = [], options = {}) {
  const normalized = String(type || '')
    .trim()
    .toLowerCase();
  const available = new Set(
    (Array.isArray(availableRoles) ? availableRoles : [])
      .map(role => String(role || '').trim())
      .filter(Boolean)
  );
  // An empty inventory is not evidence that the canonical role is available.
  // Callers that need legacy behavior must resolve it explicitly before
  // entering site-aware routing.
  if (!available.size) return undefined;
  const candidates = SITE_FALLBACKS_BY_TYPE[normalized];
  if (!candidates?.length)
    return available.has(String(assignedRole || '').trim()) ? assignedRole : undefined;
  const requested = String(assignedRole || '').trim();
  // Report-only SEO is evidence collection, not SEO publishing or outreach.
  // Legacy sites may not have an SEO analyst; an installed engineer may
  // produce the bounded read-only artifact without becoming the site's SEO
  // owner for production work.
  if (
    normalized === 'seo' &&
    String(options.delivery_mode || '') === 'report_only' &&
    ['engineer', 'principal-engineer'].includes(requested) &&
    available.has(requested)
  )
    return requested;
  // Preserve an explicitly selected role when it is actually installed and
  // belongs to the allowed lane; otherwise do not route into a nonexistent
  // canonical role just because the site uses an older naming convention.
  if (requested && candidates.includes(requested) && available.has(requested)) return requested;
  return candidates.find(role => available.has(role));
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
  EXECUTIVE_READ_ONLY_ROLES,
  isExecutiveReadOnlyRole,
};
