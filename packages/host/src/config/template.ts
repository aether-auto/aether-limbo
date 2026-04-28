/**
 * Seed TOML template written on first-run or via `limbo config edit --init`.
 *
 * Every key is documented and defaults are filled in.
 * Chord strings use TOML basic-string escape syntax: \x0c, \x1b, etc.
 */
export const CONFIG_TEMPLATE = `# aether-limbo configuration
# Location: ~/.config/aether-limbo/config.toml
# Edit with: limbo config edit
# Reset to defaults: delete this file and run limbo

# ---------------------------------------------------------------------------
# [hotkey] — overlay activation chord
# ---------------------------------------------------------------------------
[hotkey]
# Byte string that triggers the overlay.
# TOML basic strings support \\uXXXX escapes (4 hex digits).
# Note: \\xXX is NOT valid TOML — use \\uXXXX instead.
# Examples:
#   chord = "\\u000c"        # Ctrl+L  (default)
#   chord = "\\u001b[24~"   # F12
#   chord = "\\u001bOP"     # F1
chord = "\\u000c"

# ---------------------------------------------------------------------------
# [guard] — shame banner shown when the chord is pressed
# ---------------------------------------------------------------------------
[guard]
# Text displayed in the shame banner.
message = "be productive, dumbass."

# How long (milliseconds) the shame banner stays on screen before the overlay opens.
hold_ms = 1200

# After this many idle-attempt firings show an escalation message instead of the
# default shame copy. Set to 0 to disable (default).
idle_attempts_before_escalation = 0

# Round-robin escalation messages (only used when idle_attempts_before_escalation > 0).
# escalation_messages = [
#   "seriously, get back to work.",
#   "you've done this N times today.",
# ]
escalation_messages = []

# ---------------------------------------------------------------------------
# [snapback] — auto-return to Claude when a response completes
# ---------------------------------------------------------------------------
[snapback]
# Close the overlay automatically when Claude finishes responding.
enabled = true

# ---------------------------------------------------------------------------
# [adapters] — tab configuration and adapter behaviour
# ---------------------------------------------------------------------------
[adapters]
# Tabs shown in the overlay, in display order.
# Valid IDs: "reels", "feed", "dms", "x", "tiktok"
tab_order = ["reels", "feed", "dms", "x", "tiktok"]

# Keep sidecar processes alive across overlay close/open (avoids cold-start latency).
keep_warm = false

# Per-tab enabled flags. Set to false to hide a tab entirely.
[adapters.enabled]
reels  = true
feed   = true
dms    = true
x      = true
tiktok = true

# ---------------------------------------------------------------------------
# [adapters.instagram]
# ---------------------------------------------------------------------------
[adapters.instagram]
# Render sixel/kitty image thumbnails in the Feed view (requires terminal support).
thumbnails = true

# Maximum cell rows used to display a single thumbnail.
thumbnail_max_rows = 6

# ---------------------------------------------------------------------------
# [adapters.twitter]
# ---------------------------------------------------------------------------
[adapters.twitter]
# Authentication backend: "twikit" (cookie-based, default) or "tweepy" (API key).
auth = "twikit"

# Cache DM availability at session level — skips redundant probes for accounts
# that have no DMs access.
cache_dms = false

# BCP-47 language tag used to filter the timeline.
language = "en-US"

# ---------------------------------------------------------------------------
# [adapters.tiktok]
# ---------------------------------------------------------------------------
[adapters.tiktok]
# Attempt a transparent ms_token refresh once before surfacing the token form.
refresh_on_failure = false

# Keep the Playwright context warm across sidecar respawns.
keep_warm = false
`;
