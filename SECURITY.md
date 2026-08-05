# Security Policy

adport handles live advertising-account credentials. Take findings seriously and report them privately.

## Reporting a vulnerability

Email **management@reviewdoctor.ai** with details and reproduction steps. Do not open a public issue for security reports. You will get an acknowledgement within 72 hours.

## Scope notes

- Credentials are stored in `${ADPORT_HOME:-~/.config/adport}/credentials.json` with mode 0600. adport never transmits credentials anywhere except the ad platform APIs themselves.
- All mutations require the two-step validate→apply flow and are written to a local audit log.
- adport contains no telemetry.

## Supported versions

Pre-1.0: only the latest release receives security fixes.
