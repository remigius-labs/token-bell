# From Omarchy

`omarchy-agent-usage-claude` is taken unchanged from [Omarchy](https://github.com/basecamp/omarchy)
(commit 492b883, 2026-10-13), where it feeds the Agents panel in the top bar. It prints one
display-ready JSON record: plan, rate limits with reset times, and token counts by day and model.
main.py runs it with the system Python and the panel draws the record.

Omarchy is MIT licensed; its licence is in this folder. To update, copy the newer file over this one.
