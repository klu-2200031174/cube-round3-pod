"use client";

import { useActionState, useState } from "react";
import type { PoLine } from "@/lib/types";
import { inspectAction } from "./actions";

const ROLES = ["pallet", "carton", "unit", "label", "other"] as const;
const MAX_PHOTOS = 8;

export function InspectForm({ lines }: { lines: PoLine[] }) {
  const [state, action, pending] = useActionState(inspectAction, undefined);
  const [unitId, setUnitId] = useState(lines[0]?.unit_id ?? "");
  const [slots, setSlots] = useState([0, 1, 2]);
  const po = lines.find((l) => l.unit_id === unitId);

  return (
    <form action={action} className="panel">
      <h2>1. PO line</h2>
      <div className="field">
        <label htmlFor="unit_id">Unit</label>
        <select id="unit_id" name="unit_id" value={unitId} onChange={(e) => setUnitId(e.target.value)}>
          {lines.map((l) => (
            <option key={l.unit_id} value={l.unit_id}>
              {l.unit_id} · {l.po_number}/{l.po_line} · {l.product_title}
            </option>
          ))}
        </select>
      </div>
      {po && (
        <dl className="kv" style={{ marginBottom: 18 }}>
          <dt>SKU</dt>
          <dd className="mono">{po.sku}</dd>
          <dt>Spec</dt>
          <dd>
            colour {po.spec_colour}, variant {po.spec_variant}
          </dd>
          <dt>Components</dt>
          <dd>{po.spec_components.join(", ")}</dd>
          <dt>Ordered</dt>
          <dd>
            {po.cartons_ordered} cartons × {po.units_per_carton_ordered} units = {po.qty_ordered}
          </dd>
        </dl>
      )}

      <h2>2. Photos</h2>
      <p className="sub">One per view is enough: the pallet or cartons, an opened carton, one unit, the label.</p>
      {slots.map((slot) => (
        <div className="row field" key={slot}>
          <select name={`role_${slot}`} className="narrow" defaultValue={ROLES[Math.min(slot, 2)]}>
            {ROLES.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
          <input type="file" name={`photo_${slot}`} accept="image/jpeg,image/png,image/webp" capture="environment" />
        </div>
      ))}
      {slots.length < MAX_PHOTOS && (
        <button type="button" onClick={() => setSlots((s) => [...s, s.length])} style={{ marginBottom: 18 }}>
          + another photo
        </button>
      )}

      <h2>3. Your counts (optional)</h2>
      <p className="sub">When given, these are the primary count and the photos only corroborate them.</p>
      <div className="row field">
        <div>
          <label htmlFor="cartons_received">Cartons received</label>
          <input id="cartons_received" name="cartons_received" type="number" min={0} inputMode="numeric" />
        </div>
        <div>
          <label htmlFor="upc">Units in an opened carton</label>
          <input id="upc" name="units_per_carton_counted" type="number" min={0} inputMode="numeric" />
        </div>
      </div>

      {state?.error && <div className="error">{state.error}</div>}
      {pending && <div className="note">Uploading photos and asking the model. On CPU this can take a minute or two.</div>}
      <button className="primary" disabled={pending || !po}>
        {pending ? "Inspecting…" : "Inspect"}
      </button>
    </form>
  );
}
