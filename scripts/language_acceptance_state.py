"""Recognize the public diagnostic states used by the installed CLI acceptance test."""


def analysis_observed(output):
    return "解析: ok typescript [typescript:observed]" in output


def retry_read(output, elapsed_seconds):
    # A partial response is not evidence of either an error or a clean file.
    return "typescript:waiting" in output and elapsed_seconds < 30
