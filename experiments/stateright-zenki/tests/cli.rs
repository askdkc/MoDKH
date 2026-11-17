use std::process::Command;

#[test]
fn exit_codes_and_json_distinguish_success_counterexample_and_invalid_input() {
    for (arg, code, status, invariant) in
        [("good", 0, "passed", "Good"), ("bad", 1, "failed", "Bad")]
    {
        let result = Command::new(env!("CARGO_BIN_EXE_modkh-zenki-prototype"))
            .arg(arg)
            .output()
            .unwrap();
        assert_eq!(result.status.code(), Some(code));
        let report: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(report["status"], status);
        assert_eq!(report["invariant"], invariant);
        assert_eq!(report["exploredStates"], 3);
        if arg == "bad" {
            assert_eq!(report["counterexample"], serde_json::json!([0, 1, 2]));
        }
        assert!(result.stderr.is_empty());
    }
    for args in [vec![], vec!["unknown"], vec!["good", "bad"]] {
        let result = Command::new(env!("CARGO_BIN_EXE_modkh-zenki-prototype"))
            .args(args)
            .output()
            .unwrap();
        assert_eq!(result.status.code(), Some(2));
        assert!(
            result.stdout.is_empty(),
            "invalid requests must not emit a verification result"
        );
        assert!(String::from_utf8_lossy(&result.stderr).contains("Usage:"));
    }
}
