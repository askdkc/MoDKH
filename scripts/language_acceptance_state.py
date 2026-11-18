"""Recognize the public diagnostic states used by the installed CLI acceptance test."""


def analysis_observed(output):
    return "解析: ok typescript [typescript:observed]" in output


def retry_read(output, elapsed_seconds, expected_diagnostic):
    if elapsed_seconds >= 30:
        return False
    # The TypeScript server may publish syntax diagnostics before semantic diagnostics.
    return "typescript:waiting" in output or (
        analysis_observed(output) and expected_diagnostic not in output
    )
