#!/usr/bin/env python3
"""
Create title cards for the Ford video using Pillow.
Run on grackle with: source ~/video-env/bin/activate && python3 create_title_cards.py
"""

from PIL import Image, ImageDraw, ImageFont
import os

# Video dimensions
WIDTH = 1920
HEIGHT = 1080

# Ford Blue color scheme
FORD_BLUE = (0, 52, 120)  # #003478
WHITE = (255, 255, 255)

# Output directory
OUTPUT_DIR = "/home/kh0pp/DSCI-5330/assignment-06-video-script/images/title_cards"

# Title cards to create
TITLE_CARDS = [
    {"filename": "00_opening_title.png", "text": "Will You Buy a Ford?", "subtitle": "A Union Perspective"},
    {"filename": "01_union_value.png", "text": "Union Labor Value", "subtitle": None},
    {"filename": "02_ev_caveat.png", "text": "The EV Caveat", "subtitle": None},
    {"filename": "03_labor_critique.png", "text": "The Labor Critique", "subtitle": None},
    {"filename": "04_infrastructure_critique.png", "text": "The Infrastructure Critique", "subtitle": None},
    {"filename": "05_fords_opportunity.png", "text": "Ford's Opportunity", "subtitle": None},
    {"filename": "06_end_card.png", "text": "Thank You", "subtitle": "DSCI 5330 - Fall 2025"},
]


def get_font(size):
    """Get a font, falling back to default if needed."""
    # Try common font locations on Linux
    font_paths = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
    ]

    for font_path in font_paths:
        if os.path.exists(font_path):
            return ImageFont.truetype(font_path, size)

    # Fall back to default font (limited size support)
    print("Warning: Using default font. Install DejaVu or Liberation fonts for better quality.")
    return ImageFont.load_default()


def create_title_card(text, subtitle=None, filename="title.png"):
    """Create a title card with Ford Blue background and white text."""
    # Create image
    img = Image.new('RGB', (WIDTH, HEIGHT), color=FORD_BLUE)
    draw = ImageDraw.Draw(img)

    # Get fonts
    title_font = get_font(100)
    subtitle_font = get_font(48)

    # Calculate text position (centered)
    # Get text bounding box
    title_bbox = draw.textbbox((0, 0), text, font=title_font)
    title_width = title_bbox[2] - title_bbox[0]
    title_height = title_bbox[3] - title_bbox[1]

    title_x = (WIDTH - title_width) // 2

    if subtitle:
        # With subtitle, move title up slightly
        title_y = (HEIGHT - title_height) // 2 - 40

        subtitle_bbox = draw.textbbox((0, 0), subtitle, font=subtitle_font)
        subtitle_width = subtitle_bbox[2] - subtitle_bbox[0]
        subtitle_x = (WIDTH - subtitle_width) // 2
        subtitle_y = title_y + title_height + 30

        # Draw subtitle
        draw.text((subtitle_x, subtitle_y), subtitle, font=subtitle_font, fill=WHITE)
    else:
        title_y = (HEIGHT - title_height) // 2

    # Draw main title
    draw.text((title_x, title_y), text, font=title_font, fill=WHITE)

    # Add subtle decorative lines
    line_y_top = title_y - 50
    line_y_bottom = title_y + title_height + (80 if subtitle else 50)
    line_margin = 300

    draw.line([(line_margin, line_y_top), (WIDTH - line_margin, line_y_top)], fill=WHITE, width=2)
    draw.line([(line_margin, line_y_bottom), (WIDTH - line_margin, line_y_bottom)], fill=WHITE, width=2)

    # Save
    output_path = os.path.join(OUTPUT_DIR, filename)
    img.save(output_path, 'PNG')
    print(f"Created: {output_path}")

    return output_path


def main():
    """Generate all title cards."""
    # Create output directory
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    print(f"Creating {len(TITLE_CARDS)} title cards...")
    print(f"Output directory: {OUTPUT_DIR}")
    print()

    for card in TITLE_CARDS:
        create_title_card(
            text=card["text"],
            subtitle=card.get("subtitle"),
            filename=card["filename"]
        )

    print()
    print(f"All {len(TITLE_CARDS)} title cards created successfully!")


if __name__ == "__main__":
    main()
