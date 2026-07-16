"""
Shared Jinja2 templates configuration.

This module provides a configured templates instance with custom filters
that all route modules can import.
"""

from datetime import datetime
from pathlib import Path

from fastapi.templating import Jinja2Templates

# Templates directory
TEMPLATES_DIR = Path(__file__).parent / "templates"
TEMPLATES_DIR.mkdir(exist_ok=True)

# Create templates instance
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))


# Custom template filters
def format_datetime(value, format="%B %d, %Y at %I:%M %p"):
    """Format datetime for display in local timezone."""
    from zoneinfo import ZoneInfo
    import os
    local_tz = ZoneInfo(os.environ.get("USER_TIMEZONE", "America/Chicago"))

    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return value
    if value:
        # If naive datetime, assume it's UTC (database stores in UTC)
        if value.tzinfo is None:
            value = value.replace(tzinfo=ZoneInfo("UTC"))
        # Convert to local timezone
        value = value.astimezone(local_tz)
        return value.strftime(format)
    return "N/A"


def days_until(value):
    """Calculate calendar days until a date using local timezone."""
    from zoneinfo import ZoneInfo
    import os
    local_tz = ZoneInfo(os.environ.get("USER_TIMEZONE", "America/Chicago"))

    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return "?"
    if value:
        now = datetime.now(local_tz)
        # Interpret naive due dates as local time (how Canvas displays them)
        if value.tzinfo is None:
            value = value.replace(tzinfo=local_tz)  # NOT UTC!
        # Calculate calendar days until due (not time-based)
        return (value.date() - now.date()).days
    return "?"


def render_markdown(value):
    """Convert markdown text to HTML with auto-linked URLs."""
    import markdown2
    import re
    if value:
        return markdown2.markdown(
            value,
            extras=[
                "fenced-code-blocks",
                "tables",
                "strike",
                "task_list",
                "link-patterns",
            ],
            link_patterns=[
                (re.compile(r'https?://[^\s<>\[\]()]+'), r'\g<0>'),
            ]
        )
    return ""


# Register filters
templates.env.filters["datetime"] = format_datetime
templates.env.filters["days_until"] = days_until
templates.env.filters["markdown"] = render_markdown
