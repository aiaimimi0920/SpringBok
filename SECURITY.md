# Security policy

Never commit real credentials, `.env` files, private keys, cookies, state files,
or production deployment output. Use sanitized examples for documentation.

Report sensitive findings using the repository's private security-advisory flow
if available. If unavailable, ask for a private contact channel without posting
credentials or exploit details publicly. Revoke exposed credentials; deleting a
line from the latest commit does not invalidate a leaked secret.

Repository checks run with minimal permissions. A passing scan is not evidence
that a future application or deployment is secure.
