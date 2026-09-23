'use strict';

// A terminal worker failure must remain an audit fact, but it must not become
// an invisible tombstone. This module turns the failure into one durable
// executive workbench case with a clear owner and a bounded repair action.

const FOLLOWUP_PREFIX = 'failed-change-request:';

function failureText(request, run) {
  return [request?.error, run?.outcome?.error, run?.validation?.policy?.summary, run?.agent?.error]
    .filter(Boolean)
    .join(' ')
    .trim();
}

function classifyFailure(request, run) {
  const text = failureText(request, run);
  if (request?.delivery_mode === 'report_only' || request?.delivery_mode === 'fleet_report') {
    return {
      kind: 'evidence',
      owner: 'cto',
      priority: 'normal',
      summary: 'The approved evidence request did not produce a verified report artifact.',
      next_action:
        'CTO must inspect the worker log and either requeue a bounded report-only replacement or close the request with the missing evidence documented.',
    };
  }
  if (/reviewer rejected|automatic reviewer did not return pass/i.test(text)) {
    return {
      kind: 'implementation',
      owner: 'cto',
      priority: 'high',
      summary: 'The independent reviewer rejected the worker output after bounded repair attempts.',
      next_action:
        'CTO or Principal Engineer must inspect the reviewer evidence, correct the smallest defect, and explicitly requeue the request or close it with a reason.',
    };
  }
  if (/quality gate|quality gates|build failed|tests failed|preview failed|browser/i.test(text)) {
    return {
      kind: 'implementation',
      owner: 'principal-engineer',
      priority: 'high',
      summary: 'The worker produced output, but a deterministic validation gate did not pass.',
      next_action:
        'Principal Engineer must inspect the failed gate and prepare the smallest correction or mark the request not actionable; do not retry the unchanged checkout.',
    };
  }
  if (
    /handoff|container|docker|connection refused|timed out|timeout|worker process|infrastructure/i.test(
      text
    )
  ) {
    return {
      kind: 'incident',
      owner: 'principal-engineer',
      priority: 'high',
      summary: 'The worker or reviewer environment failed before the request could be completed.',
      next_action:
        'Principal Engineer must repair or verify the isolated worker infrastructure, preserve any durable work, then explicitly requeue the request.',
    };
  }
  return {
    kind: 'incident',
    owner: 'principal-engineer',
    priority: 'normal',
    summary: 'The implementation request ended without a verified delivery.',
    next_action:
      'Principal Engineer must inspect the request and linked run, then explicitly requeue a corrected task or close it with the reason recorded.',
  };
}

function evidenceFor(request, run, reason) {
  return [
    {
      label: 'failed request',
      url: `/api/change-requests/${request.request_id}`,
      note: `${request.request_id}; attempts=${request.attempts || 0}; review_attempts=${request.review_attempts || 0}`,
    },
    ...(run
      ? [
          {
            label: 'linked improvement run',
            url: `/api/improvements/${run.run_id}`,
            note: `${run.run_id}; state=${run.state}; phase=${run.agent?.phase || 'unknown'}`,
          },
        ]
      : []),
    {
      label: 'failure evidence',
      note: String(reason || 'no durable failure reason recorded').slice(0, 1000),
    },
  ];
}

function buildFollowup(request, run) {
  const classification = classifyFailure(request, run);
  const reason = failureText(request, run) || 'no durable failure reason recorded';
  return {
    work_id: `${FOLLOWUP_PREFIX}${request.request_id}`,
    title: `Repair failed request: ${request.title}`,
    kind: classification.kind,
    status: 'open',
    priority: classification.priority,
    owner: classification.owner,
    source_type: 'failed-change-request',
    source_id: request.request_id,
    site: request.site || null,
    summary: `${classification.summary} Failure: ${reason}`.slice(0, 1800),
    next_action: classification.next_action,
    evidence: evidenceFor(request, run, reason),
    created_by: 'system',
  };
}

function upsert(store, request, run) {
  if (!store || !request || request.status !== 'failed') return { changed: false, item: null };
  const payload = buildFollowup(request, run);
  const existing = store.getExecutiveWorkItem(payload.work_id);
  if (!existing)
    return { changed: true, created: true, item: store.createExecutiveWorkItem(payload) };
  // A completed/cancelled repair case is an intentional operator disposition;
  // do not reopen it on every recovery pulse. The original failed request is
  // still visible in the audit trail and can be explicitly requeued.
  if (['done', 'cancelled'].includes(existing.status)) return { changed: false, item: existing };
  const changed = ['summary', 'next_action', 'priority', 'owner', 'kind', 'site'].some(
    key => String(existing[key] ?? '') !== String(payload[key] ?? '')
  );
  return changed
    ? {
        changed: true,
        created: false,
        item: store.updateExecutiveWorkItem(payload.work_id, payload),
      }
    : { changed: false, item: existing };
}

module.exports = {
  FOLLOWUP_PREFIX,
  classifyFailure,
  buildFollowup,
  upsert,
};
