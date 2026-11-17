use modkh_zenki_prototype::{check, Invariant};
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let invariant = match args.as_slice() {
        [name] if name == "good" => Invariant::Good,
        [name] if name == "bad" => Invariant::Bad,
        _ => {
            eprintln!("Usage: modkh-zenki-prototype <good|bad> (Counter model only)");
            return ExitCode::from(2);
        }
    };
    let report = check(invariant);
    println!(
        "{}",
        serde_json::to_string(&report).expect("serializable report")
    );
    ExitCode::from(match report.status {
        "passed" => 0,
        "failed" => 1,
        _ => 2,
    })
}
