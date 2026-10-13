# Claude usage counter

`omarchy-agent-usage-claude` is the Claude usage counter Token Bell is built on, taken unchanged from
https://github.com/basecamp/omarchy/blob/master/bin/omarchy-agent-usage-claude (commit 492b883,
2026-10-13). It prints one display-ready JSON record: plan and rate limits with reset times.
main.py runs it with the system Python and the panel draws the record.

The counter is MIT licensed; its licence is in this folder and has to stay with it. To update,
copy the newer file over this one.
