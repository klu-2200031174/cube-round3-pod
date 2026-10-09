"use client";

import { useActionState } from "react";
import { overrideAction, retryAction } from "../../actions";

export function RetryButton({ recordId }: { recordId: string }) {
  const [state, action, pending] = useActionState(() => retryAction(recordId), undefined);
  return (
    <form action={action} style={{ marginTop: 10 }}>
      {state?.error && <div className="error">{state.error}</div>}
      <button disabled={pending}>{pending ? "Asking the model again…" : "Retry the model call"}</button>
    </form>
  );
}

export function OverrideForm({ recordId, checks }: { recordId: string; checks: { name: string; verdict: string }[] }) {
  const [state, action, pending] = useActionState(overrideAction, undefined);
  return (
    <form action={action}>
      <input type="hidden" name="record_id" value={recordId} />
      <div className="row field">
        <div>
          <label htmlFor="check_name">Check</label>
          <select id="check_name" name="check_name">
            {checks.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name} (now {c.verdict})
              </option>
            ))}
          </select>
        </div>
        <div className="narrow">
          <label htmlFor="new_verdict">New verdict</label>
          <select id="new_verdict" name="new_verdict">
            <option>PASS</option>
            <option>FAIL</option>
            <option>UNCERTAIN</option>
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="reason">Reason</label>
        <textarea id="reason" name="reason" rows={2} required minLength={3} placeholder="e.g. Recounted by hand: 12 units in the opened carton" />
      </div>
      {state?.error && <div className="error">{state.error}</div>}
      {state?.ok && <div className="ok">{state.ok}</div>}
      <button className="primary" disabled={pending}>
        {pending ? "Saving…" : "Add override"}
      </button>
    </form>
  );
}
