// Attio CRM capture. On sign-in the backend asserts a person record (email + display name) in the
// operator's Attio workspace.
//
// Design, in order:
//   1. Signing in must NEVER fail or stall because the CRM is slow or down - the call is fired and
//      not awaited, with a timeout.
//   2. Inert without an API key: an operator who never configured a CRM must not have anyone's email
//      shipped anywhere, nor accumulate it in a local queue.
//   3. Only STANDARD attributes are sent. Custom workspace attributes 400 on workspaces lacking them.
//
// openmw-web backs this with a durable outbox because a missed signup there is lost for good. ja2-web
// does not need one: the assert is idempotent on the email, and a session here lasts one browser
// session, so the next sign-in re-asserts whatever a CRM outage dropped. Skipping the queue also
// means no file of email addresses sitting on the box.
// ponytail: no outbox; add one only if capture-exactly-once-on-first-signin ever matters.
//
// PRIVACY: this sends an email address to a third party. Disclose it wherever the site explains what
// it stores, and treat the workspace as holding user PII.

const ENDPOINT = '/v2/objects/people/records?matching_attribute=email_addresses';

// Returns the fetch promise so tests can await it; callers on the hot path deliberately do not.
export function attioCapture({ apiKey, baseUrl = 'https://api.attio.com', fetchFn = fetch, log } = {}, person) {
  if (!apiKey || !person || !person.email) return null;
  const body = { data: { values: {
    email_addresses: [{ email_address: person.email }],
    ...(person.name ? { name: [{ first_name: person.name, last_name: '', full_name: person.name }] } : {}),
  } } };
  return fetchFn(`${baseUrl}${ENDPOINT}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })
    .then((r) => { log?.(r.ok ? 'info' : 'warn', r.ok ? 'attio.upserted' : 'attio.upsert_failed',
      { status: r.status, provider: person.provider }); return r.ok; })
    .catch((e) => { log?.('warn', 'attio.unreachable', { error: String(e) }); return false; });
}
