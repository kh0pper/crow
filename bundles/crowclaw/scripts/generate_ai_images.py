#!/usr/bin/env python3
"""
Generate AI images for the Ford video using Runware API.
Run on grackle with: source ~/video-env/bin/activate && python3 generate_ai_images.py

API Key: se9LgAoBMzDHSAdRxMtV2LARvZkx8TkS
Budget: $24.73
"""

import asyncio
import os
import base64
import httpx
from runware import Runware, IImageInference

# Runware API key
API_KEY = "se9LgAoBMzDHSAdRxMtV2LARvZkx8TkS"

# Output directory
OUTPUT_DIR = "/home/kh0pp/DSCI-5330/assignment-06-video-script/images/ai_generated"

# Video dimensions (must be multiples of 64)
# 1920x1088 is closest 16:9 that's valid for Runware
WIDTH = 1920  # 64 * 30 = 1920
HEIGHT = 1088  # 64 * 17 = 1088 (closest to 1080)

# CRITICAL: All prompts must include "no text, no words, no letters" to avoid garbled text
# Image prompts by section
IMAGE_PROMPTS = [
    # OPENING (3 images)
    {
        "filename": "01_ford_ranger.png",
        "prompt": "2020 Ford Ranger pickup truck driving on American highway, dramatic golden hour lighting, cinematic photography, detailed vehicle, scenic landscape, no text no words no letters no signs no writing"
    },
    {
        "filename": "02_workers_united.png",
        "prompt": "Factory workers united, diverse group of men and women, American automotive manufacturing, solidarity, hard hats and work uniforms, warm lighting, cinematic, no text no words no letters no signs no writing"
    },
    {
        "filename": "03_middle_class.png",
        "prompt": "American middle class neighborhood, suburban homes with well-kept lawns, pickup trucks in driveways, warm afternoon sunlight, peaceful community, cinematic photography, no text no words no letters no signs no writing"
    },

    # UNION LABOR VALUE (2 images)
    {
        "filename": "04_assembly_line.png",
        "prompt": "Ford truck assembly line, skilled workers welding automotive parts, sparks flying, dramatic industrial lighting, American manufacturing, professional photography, cinematic, no text no words no letters no signs no writing"
    },
    {
        "filename": "05_proud_workers.png",
        "prompt": "Proud automotive factory workers, diverse group wearing hard hats, American manufacturing plant, confident poses, professional lighting, cinematic photography, no text no words no letters no signs no writing"
    },

    # EV CAVEAT (3 images)
    {
        "filename": "06_mach_e.png",
        "prompt": "Ford Mustang Mach-E electric vehicle, sleek modern design, studio lighting, dramatic shadows, futuristic, cinematic automotive photography, no text no words no letters no signs no writing"
    },
    {
        "filename": "07_robot_battery.png",
        "prompt": "Robotic arms assembling electric car batteries, automated factory, cold blue industrial lighting, sterile environment, dystopian atmosphere, cinematic, no text no words no letters no signs no writing"
    },
    {
        "filename": "08_automated_factory.png",
        "prompt": "Empty automated factory floor with only robots, no human workers, sterile blue lighting, concerning atmosphere, modern automation, cinematic photography, no text no words no letters no signs no writing"
    },

    # LABOR CRITIQUE (4 images)
    {
        "filename": "09_gigafactory.png",
        "prompt": "Massive modern electric vehicle factory exterior, stark industrial architecture, cold overcast sky, imposing building, cinematic photography, no text no words no letters no signs no writing"
    },
    {
        "filename": "10_closed_factory.png",
        "prompt": "Closed American factory, abandoned industrial building, empty parking lot, economic decline, overcast sky, melancholy atmosphere, cinematic photography, no text no words no letters no signs no writing"
    },
    {
        "filename": "11_economic_hardship.png",
        "prompt": "Working class family at kitchen table, worried expressions, economic stress, bills on table, realistic, dramatic lighting, empathetic portrayal, cinematic, no text no words no letters no signs no writing"
    },
    {
        "filename": "12_decline.png",
        "prompt": "Small town America in decline, empty storefronts, quiet main street, economic hardship, atmospheric fog, melancholy, cinematic photography, no text no words no letters no signs no writing"
    },

    # INFRASTRUCTURE CRITIQUE (4 images)
    {
        "filename": "13_charging_stations.png",
        "prompt": "Row of electric vehicle charging stations, modern infrastructure, empty parking lot, cold blue lighting, clinical atmosphere, cinematic photography, no text no words no letters no signs no writing"
    },
    {
        "filename": "14_investment.png",
        "prompt": "Abstract visualization of massive infrastructure investment, money flowing concept, dramatic lighting, financial abstract art, cinematic, no text no words no letters no signs no writing"
    },
    {
        "filename": "15_battery_swap.png",
        "prompt": "Modern battery swap station, car entering automated bay, futuristic efficient technology, clean design, optimistic lighting, cinematic photography, no text no words no letters no signs no writing"
    },
    {
        "filename": "16_mining.png",
        "prompt": "Rare earth mineral open pit mine, massive excavation, environmental impact, dramatic aerial view, concerning landscape, cinematic photography, no text no words no letters no signs no writing"
    },

    # CLOSING & FUTURE VISION (4 images)
    {
        "filename": "17_f150_patriotic.png",
        "prompt": "Ford F-150 pickup truck, dramatic American landscape, golden hour sunset, patriotic feeling, proud manufacturing heritage, cinematic photography, no text no words no letters no signs no writing"
    },
    {
        "filename": "18_autonomous_fleet.png",
        "prompt": "Fleet of autonomous electric taxis, futuristic city street, shared mobility concept, optimistic future, clean modern design, cinematic photography, no text no words no letters no signs no writing"
    },
    {
        "filename": "19_public_transit.png",
        "prompt": "Modern sleek public transit train, sustainable transportation, urban environment, hopeful atmosphere, clean design, cinematic photography, no text no words no letters no signs no writing"
    },
    {
        "filename": "20_ford_pro.png",
        "prompt": "Fleet of commercial Ford vans, professional services, business success, organized fleet management, optimistic lighting, cinematic photography, no text no words no letters no signs no writing"
    },
]


async def download_image(url, filepath):
    """Download image from URL and save to file."""
    async with httpx.AsyncClient() as client:
        response = await client.get(url, timeout=60.0)
        response.raise_for_status()
        with open(filepath, 'wb') as f:
            f.write(response.content)


async def generate_images():
    """Generate all AI images using Runware API."""
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    print(f"Generating {len(IMAGE_PROMPTS)} AI images...")
    print(f"Output directory: {OUTPUT_DIR}")
    print(f"Resolution: {WIDTH}x{HEIGHT}")
    print()

    # Initialize Runware client
    runware = Runware(api_key=API_KEY)
    await runware.connect()

    generated = 0
    failed = 0

    for i, img_data in enumerate(IMAGE_PROMPTS):
        filename = img_data["filename"]
        prompt = img_data["prompt"]
        filepath = os.path.join(OUTPUT_DIR, filename)

        # Skip if already exists
        if os.path.exists(filepath):
            print(f"[{i+1}/{len(IMAGE_PROMPTS)}] Skipping {filename} (already exists)")
            generated += 1
            continue

        print(f"[{i+1}/{len(IMAGE_PROMPTS)}] Generating {filename}...")

        try:
            # Create image inference request
            request = IImageInference(
                positivePrompt=prompt,
                negativePrompt="text, words, letters, writing, signs, logos, watermarks, blurry, low quality, distorted",
                height=HEIGHT,
                width=WIDTH,
                model="runware:100@1",  # Default high-quality model
                steps=25,
                CFGScale=7.0,
                numberResults=1,
            )

            # Generate image
            images = await runware.imageInference(requestImage=request)

            if images and len(images) > 0:
                image_url = images[0].imageURL
                await download_image(image_url, filepath)
                print(f"    Saved: {filename}")
                generated += 1
            else:
                print(f"    ERROR: No image returned for {filename}")
                failed += 1

        except Exception as e:
            print(f"    ERROR generating {filename}: {e}")
            failed += 1

        # Small delay to avoid rate limiting
        await asyncio.sleep(0.5)

    print()
    print(f"Image generation complete!")
    print(f"  Generated: {generated}")
    print(f"  Failed: {failed}")
    print(f"  Total: {len(IMAGE_PROMPTS)}")


if __name__ == "__main__":
    asyncio.run(generate_images())
