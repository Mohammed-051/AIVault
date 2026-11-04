# memory/

One file per project. Agents read the project's file before working and append one dated line to its Log when done.

Create one with `vault new-project "<name>" --type dev|writing|content|media|research|business|other`.

Files here are private and git-ignored. Keep each under ~150 lines: fold old log lines into "Current status".
Never store passwords, API keys or tokens here.
