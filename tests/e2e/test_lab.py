"""Interactive lab end to end: real HTTP path to a FAKE Groq, real agents, real orchestrator."""
import io, json
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from tests.fake_groq import FakeGroq


@pytest.fixture
def env(tmp_path, monkeypatch):
    fake = FakeGroq().start()
    monkeypatch.setenv("GROQ_BASE_URL", fake.base_url)
    monkeypatch.setenv("GROQ_API_KEY", "test-key-0123456789abcdef")
    monkeypatch.setenv("INPUT_DIR", str(tmp_path / "in"))
    from orchestration import api, lab
    from orchestration.store import FileStore
    store = FileStore(tmp_path / "out")
    monkeypatch.setattr(api, "STORE", store)
    lab.init(store)
    yield TestClient(api.app), fake
    fake.stop()


def img(color="blue"):
    b = io.BytesIO(); Image.new("RGB", (320, 240), color).save(b, "JPEG"); return b.getvalue()


def post(client, stage, data, n=1, roles=None, key="photos"):
    files = [(key, (f"p{i}.jpg", img(), "image/jpeg")) for i in range(n)]
    return client.post("/api/lab/run", data={"stage": stage, "data": json.dumps(data), "roles": json.dumps(roles or [])}, files=files)


def rec(r, stage):
    return next(e for e in r.json()["evidence"].values() if e["stage"] == stage)


def test_config_and_connection(env):
    c, _ = env
    assert c.get("/api/config").json()["key_set"] is True
    assert "test-key" not in c.get("/api/config").text
    t = c.post("/api/config/groq/test").json()
    assert t["ok"] and t["model_available"] and "whisper-large-v3" not in t["models"]


def test_receiving_short_and_damaged(env):
    c, fake = env
    fake.scenario["receiving"] = "short_damaged"
    r = post(c, "receiving", {"po": {"sku": "SKU-BOTTLE-750", "product_title": "Water Bottle", "spec_colour": "blue",
             "spec_variant": "750ml", "cartons_ordered": 1, "units_per_carton_ordered": 24, "qty_ordered": 24}}, roles=["carton"])
    assert r.status_code == 200, r.text
    e = rec(r, "receiving")
    by = {k["check_key"]: k["verdict"] for k in e["checks"]}
    assert by["quantity"] == "FAIL" and by["carton_damage"] == "FAIL" and by["identity_match"] == "PASS"
    assert e["decision"]["outcome"] == "accept_with_exceptions" and e["model"]["provider"] == "groq"


def test_receiving_blurry_is_uncertain(env):
    c, fake = env
    fake.scenario["receiving"] = "blurry"
    r = post(c, "receiving", {"po": {"sku": "S", "product_title": "Water Bottle", "cartons_ordered": 1, "units_per_carton_ordered": 24}})
    assert rec(r, "receiving")["decision"]["verdict"] == "UNCERTAIN"


@pytest.mark.parametrize("sc,expected", [("ok", "SEAL"), ("wrong_cap", "STOP & FIX"), ("missing", "STOP & FIX"),
                                          ("extra", "STOP & FIX"), ("blurry", "UNCERTAIN")])
def test_pack(env, sc, expected):
    c, fake = env
    fake.scenario["pack"] = sc
    r = post(c, "pack", {"order": [{"name": "Black T-Shirt", "quantity": 2}, {"name": "Blue Cap", "quantity": 1}]})
    assert r.status_code == 200, r.text
    assert rec(r, "pack")["payload"]["decision_label"] == expected if sc != "blurry" else rec(r, "pack")["decision"]["verdict"] == "UNCERTAIN"


def test_prep(env):
    c, fake = env
    wo = {"work_order": {"sku": "SKU-X", "fnsku": "X00DUMMY", "polybag": True, "suffocation_warning": True, "handling_marks": ["Fragile"]}}
    e0 = rec(post(c, "prep", wo), "prep")
    print([(k["check_key"], k["verdict"]) for k in e0["checks"]])
    assert e0["decision"]["verdict"] in ("PASS", "UNCERTAIN")  # bag thickness is never visually verifiable
    fake.scenario["prep"] = "label_on_seam"
    e = rec(post(c, "prep", wo), "prep")
    assert e["decision"]["verdict"] == "FAIL"
    fake.scenario["prep"] = "ambiguous"
    assert rec(post(c, "prep", wo), "prep")["decision"]["verdict"] == "UNCERTAIN"


def test_returns(env):
    c, fake = env
    prod = {"product": {"title": "Wireless Headphones", "parts": ["carrying case", "usb cable", "manual"]}}
    e = rec(post(c, "returns", prod), "returns")
    assert e["decision"]["outcome"] in ("restock", "refurbish", "liquidate", "dispose", "pending_review")
    fake.scenario["returns"] = "missing_part"
    e = rec(post(c, "returns", prod), "returns")
    assert any(k["check_key"] == "completeness" and k["verdict"] == "FAIL" for k in e["checks"])
    fake.scenario["returns"] = "wrong_item"
    e = rec(post(c, "returns", prod), "returns")
    assert any(k["check_key"] == "identity_match" and k["verdict"] == "FAIL" for k in e["checks"])


def test_no_photo_is_refused(env):
    c, _ = env
    r = c.post("/api/lab/run", data={"stage": "pack", "data": json.dumps({"order": [{"name": "Cap", "quantity": 1}]})})
    assert r.status_code == 422


def test_bad_file_refused(env):
    c, _ = env
    r = c.post("/api/lab/run", data={"stage": "pack", "data": json.dumps({"order": [{"name": "Cap", "quantity": 1}]})},
               files=[("photos", ("x.jpg", b"not an image", "image/jpeg"))])
    assert r.status_code == 415


def test_pipeline_and_recovery(env):
    c, fake = env
    data = {"route": "mfn",
            "receiving": {"po": {"sku": "SKU-BOTTLE-750", "product_title": "Water Bottle", "spec_colour": "blue", "spec_variant": "750ml",
                                 "cartons_ordered": 1, "units_per_carton_ordered": 24}},
            "pack": {"order": [{"name": "Black T-Shirt", "quantity": 2}, {"name": "Blue Cap", "quantity": 1}]},
            "fees": "Charge ID: 48291\nShipment: SHP-10291\nReason: Packaging defect\nAmount: $38"}
    files = [(f"photos_{s}", (f"a.jpg", img(), "image/jpeg")) for s in ("receiving", "pack")]
    r = c.post("/api/lab/run", data={"stage": "pipeline", "data": json.dumps(data), "roles": json.dumps({"receiving": ["carton"]})}, files=files)
    assert r.status_code == 200, r.text
    stages = {e["stage"] for e in r.json()["evidence"].values()}
    assert {"receiving", "pack", "recovery"} <= stages and "prep" not in stages
    rc = rec(r, "recovery")
    assert rc["payload"]["charges"][0]["charge_type"] == "inbound_defect_fee"
    a = c.get("/api/analytics").json()
    assert a["kpis"]["workflows"] == 1 and a["kpis"]["ai_records"] >= 2


def test_recovery_parse_and_silent(env):
    c, _ = env
    csv = "line_id,reason,amount\nA1,Packaging defect,$38\nA2,weight tier,4.5"
    r = c.post("/api/lab/recovery", json={"report": csv})
    assert r.status_code == 200, r.text
    ch = r.json()["output"]["evidence"]["payload"]["charges"]
    assert [x["position"] for x in ch] == ["SILENT", "SILENT"] and r.json()["output"]["evidence"]["payload"]["claimable_usd"] == 0
    assert c.post("/api/lab/recovery", json={"report": "garbage"}).status_code == 422


def test_recovery_narrative_rejects_invented_amount():
    from agents.recovery import narrative
    ch = [{"line_id": "L1", "charge_type": "inbound_defect_fee", "amount_usd": 38.0, "claim_amount_usd": 38.0,
           "position": "CONTRADICTS", "reason": "r", "evidence_record_ids": ["PRP-1"]}]
    fake = lambda *a, **k: type("R", (), {"json": {"notes": [{"line_id": "L1", "text": "Refund $99 per PRP-1"}]}, "model": "m", "latency_ms": 1})()
    out = narrative.build(ch, chat_fn=fake)
    assert out["source"] == "template" and out["rejected"] == ["L1"]


def test_review_queue_override_flow_and_views(env):
    c, fake = env
    fake.scenario["pack"] = "blurry"
    r = post(c, "pack", {"order": [{"name": "Black T-Shirt", "quantity": 2}]})
    wf = r.json()["workflow"]["workflow_id"]
    q = c.get("/api/review-queue").json()
    assert len(q) == 1 and q[0]["stage"] == "pack"
    o = c.post(f"/workflows/{wf}/overrides", json={"record_id": q[0]["record_id"], "new_verdict": "FAIL", "actor": "sam", "reason": "box was empty"})
    assert o.status_code == 200
    assert c.get("/api/review-queue").json() == []
    assert any(w["workflow_id"] == wf for w in c.get("/api/workflow-list").json())
    assert any(e["stage"] == "pack" for e in c.get("/api/evidence-list").json())
    assert len(c.get("/api/agents").json()) == 5


def _pipeline(c, parallel):
    data = {"route": "mfn", "receiving": {"po": {"sku": "SKU-BOTTLE-750", "product_title": "Water Bottle", "spec_colour": "blue", "spec_variant": "750ml",
            "cartons_ordered": 1, "units_per_carton_ordered": 24}}, "pack": {"order": [{"name": "Black T-Shirt", "quantity": 2}, {"name": "Blue Cap", "quantity": 1}]},
            "returns": {"product": {"title": "Wireless Headphones", "parts": ["case", "cable"]}}, "fees": [{"charge_type": "inbound_defect_fee", "amount_usd": 3}]}
    files = [(f"photos_{s}", ("a.jpg", img(), "image/jpeg")) for s in ("receiving", "pack", "returns")]
    return c.post("/api/lab/run", data={"stage": "pipeline", "data": json.dumps(data), "roles": json.dumps({"receiving": ["carton"]}),
                                        "parallel": "1" if parallel else "0"}, files=files)


def test_parallel_orchestration_overlaps_independent_agents_and_keeps_dependencies(env):
    import time
    from datetime import datetime
    c, fake = env
    fake.delay = 0.7
    t = time.monotonic(); seq = _pipeline(c, False); t_seq = time.monotonic() - t
    t = time.monotonic(); par = _pipeline(c, True); t_par = time.monotonic() - t
    assert seq.status_code == par.status_code == 200
    assert t_par < t_seq - 0.5, (t_seq, t_par)
    wf = par.json()["workflow"]
    sr = {s["stage"]: s for s in wf["stage_results"]}
    ts = lambda x: datetime.fromisoformat(x.replace("Z", "+00:00"))  # noqa: E731
    assert ts(sr["pack"]["started_at"]) <= ts(sr["receiving"]["finished_at"])          # receiving and pack overlapped
    assert ts(sr["returns"]["started_at"]) >= ts(sr["pack"]["finished_at"])            # returns waited for pack
    assert ts(sr["recovery"]["started_at"]) >= ts(sr["returns"]["finished_at"])        # recovery waited for everything
    assert any(t["event"] == "wave_started" and "parallel" in t["detail"] for t in wf["transitions"])
    # same decisions either way
    assert seq.json()["workflow"]["final_outcome"]["outcome"] == wf["final_outcome"]["outcome"]
    assert {e["stage"] for e in par.json()["evidence"].values()} == {"receiving", "pack", "returns", "recovery"}


def test_async_start_and_live_polling(env):
    import time
    c, fake = env
    fake.delay = 0.4
    data = {"order": [{"name": "Black T-Shirt", "quantity": 2}]}
    r = c.post("/api/lab/run", data={"stage": "pack", "data": json.dumps(data), "async": "1", "parallel": "1"}, files=[("photos", ("a.jpg", img(), "image/jpeg"))])
    wf_id = r.json()["workflow_id"]; seen = set()
    for _ in range(60):
        live = c.get(f"/api/lab/live/{wf_id}").json()
        seen |= {s["state"] for s in live["stages"].values()}
        if live["done"]:
            break
        time.sleep(0.1)
    assert live["done"] and "running" in seen and live["stages"]["pack"]["state"] == "completed"


def test_all_five_agents_pipeline_never_sends_route_all_to_receiving(env):
    c, fake = env
    data = {
        "pipeline": "all",
        "route": "unknown",
        "receiving": {
            "po": {
                "sku": "SKU-BOTTLE-750",
                "product_title": "Water Bottle",
                "spec_colour": "blue",
                "spec_variant": "750ml",
                "cartons_ordered": 1,
                "units_per_carton_ordered": 24
            }
        },
        "prep": {
            "work_order": {
                "sku": "SKU-BOTTLE-750",
                "fnsku": "X00123",
                "polybag": True,
                "suffocation_warning": True
            }
        },
        "pack": {
            "order": [
                {"name": "Water Bottle", "quantity": 1}
            ]
        },
        "returns": {
            "product": {
                "title": "Water Bottle",
                "parts": ["cap"]
            }
        },
        "fees": [
            {"charge_type": "inbound_defect_fee", "amount_usd": 3.0}
        ]
    }
    files = [(f"photos_{s}", ("a.jpg", img(), "image/jpeg")) for s in ("receiving", "prep", "pack", "returns")]
    r = c.post("/api/lab/run", data={"stage": "pipeline", "data": json.dumps(data), "roles": json.dumps({"receiving": ["carton"]})}, files=files)
    assert r.status_code == 200, r.text
    evidence = r.json()["evidence"]
    stages = {e["stage"] for e in evidence.values()}
    assert {"receiving", "prep", "pack", "returns", "recovery"} <= stages
    wf = r.json()["workflow"]
    assert wf["context"]["route"] in ("fba", "mfn", "unknown")
    assert wf["context"]["route"] == "unknown"


def test_legacy_route_all_is_sanitized_to_unknown_and_runs_all_agents(env):
    c, fake = env
    data = {
        "route": "all",
        "receiving": {
            "po": {
                "sku": "SKU-BOTTLE-750",
                "product_title": "Water Bottle",
                "spec_colour": "blue",
                "spec_variant": "750ml",
                "cartons_ordered": 1,
                "units_per_carton_ordered": 24
            }
        },
        "prep": {
            "work_order": {
                "sku": "SKU-BOTTLE-750",
                "fnsku": "X00123",
                "polybag": True,
                "suffocation_warning": True
            }
        },
        "pack": {
            "order": [
                {"name": "Water Bottle", "quantity": 1}
            ]
        },
        "fees": [
            {"charge_type": "inbound_defect_fee", "amount_usd": 3.0}
        ]
    }
    files = [(f"photos_{s}", ("a.jpg", img(), "image/jpeg")) for s in ("receiving", "prep", "pack")]
    r = c.post("/api/lab/run", data={"stage": "pipeline", "data": json.dumps(data), "roles": json.dumps({"receiving": ["carton"]})}, files=files)
    assert r.status_code == 200, r.text
    evidence = r.json()["evidence"]
    stages = {e["stage"] for e in evidence.values()}
    assert {"receiving", "prep", "pack", "recovery"} <= stages
    wf = r.json()["workflow"]
    assert wf["context"]["route"] == "unknown"
    assert wf["context"]["route"] != "all"

