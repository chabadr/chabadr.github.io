#!/bin/bash
# One run in Cloud Shell sets up the e-mail sending of the הנוסע המתמיד PDF:
# asks for the sending Gmail address and its app password, saves them as
# secrets, installs the packages and deploys the functions.
#   Run:  bash functions/setup-pdf-mail.sh      (from the project folder)
set -e
cd "$(dirname "$0")/.."

echo "Sending Gmail address (the account the e-mails are sent from):"
read -r SMTP_USER
echo "Its app password (16 letters, spaces don't matter; nothing shows while you type):"
read -r -s SMTP_PASS
echo
SMTP_PASS="${SMTP_PASS// /}"
if [ -z "$SMTP_USER" ] || [ -z "$SMTP_PASS" ]; then echo "Both are needed."; exit 1; fi

printf '%s' "$SMTP_USER" | firebase functions:secrets:set SMTP_USER --data-file -
printf '%s' "$SMTP_PASS" | firebase functions:secrets:set SMTP_PASS --data-file -
(cd functions && npm install)
firebase deploy --only functions
echo
echo "Done. Now set the receiving address in the admin page (tab 'Variables')."
