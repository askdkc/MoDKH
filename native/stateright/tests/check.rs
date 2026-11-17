use modkh_stateright::{check, Spec};
#[test]
fn counter_and_refutation() {
    let good = check(include_bytes!("../../../test/fixtures/formal/good.json")).unwrap();
    assert_eq!(good.status, "passed");
    assert!(good.complete);
    assert_eq!(good.explored_states, 3);
    let bad = check(include_bytes!("../../../test/fixtures/formal/bad.json")).unwrap();
    assert_eq!(bad.status, "failed");
    assert_eq!(bad.counterexample.unwrap(), ["0", "1", "2"]);
    assert_eq!(bad.violated_invariants, ["Bad"]);
}
#[test]
fn cycles_deadlocks_and_invalid_models() {
    let mut value: serde_json::Value =
        serde_json::from_slice(include_bytes!("../../../test/fixtures/formal/good.json")).unwrap();
    value["checkDeadlocks"] = true.into();
    let report = check(&serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(report.deadlock);
    assert_eq!(report.status, "failed");
    value["transitions"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({"from":"2","to":"0","action":"reset"}));
    assert_eq!(
        check(&serde_json::to_vec(&value).unwrap()).unwrap().status,
        "passed"
    );
    value["initial"] = serde_json::json!(["missing"]);
    assert!(Spec::parse(&serde_json::to_vec(&value).unwrap()).is_err());
    value["initial"] = serde_json::json!(["0"]);
    value["invariants"] = serde_json::json!([]);
    assert!(Spec::parse(&serde_json::to_vec(&value).unwrap()).is_err());
}

#[test]
fn branching_multiple_initial_states_and_unreachable_violations() {
    let mut value = serde_json::json!({
        "schemaVersion": 1, "states": ["start", "safe", "bad", "unreachable"],
        "initial": ["start"], "checkDeadlocks": false,
        "transitions": [
            {"from":"start", "to":"safe", "action":"safe branch"},
            {"from":"start", "to":"bad", "action":"bad branch"}
        ],
        "invariants": [{"name":"Safety", "allowedStates":["start", "safe"]}]
    });
    let report = check(&serde_json::to_vec(&value).unwrap()).unwrap();
    assert_eq!(report.status, "failed");
    assert_eq!(report.counterexample.unwrap(), ["start", "bad"]);
    assert_eq!(report.actions.unwrap(), ["bad branch"]);
    value["transitions"].as_array_mut().unwrap().pop();
    assert_eq!(
        check(&serde_json::to_vec(&value).unwrap()).unwrap().status,
        "passed"
    );
    value["initial"] = serde_json::json!(["start", "bad"]);
    let report = check(&serde_json::to_vec(&value).unwrap()).unwrap();
    assert_eq!(report.status, "failed");
    assert_eq!(report.counterexample.unwrap(), ["bad"]);
    assert!(report.actions.unwrap().is_empty());
}
